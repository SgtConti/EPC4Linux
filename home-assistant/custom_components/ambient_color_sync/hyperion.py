"""Pull LED colours from a Hyperion.ng server's JSON API (TCP, newline-delimited JSON).

Hyperion's LED stream (ledcolors / ledstream-start) runs at up to 100 updates per second, far more than lights can
follow, so the poller asks for it once per poll interval and stops it at the first update. The server's LED layout
(serverinfo) gives the screen zones.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
import json
import logging
from typing import Any

from .colors import Rgb, hyperion_layout, hyperion_zones

_LOGGER = logging.getLogger(__name__)

REPLY_TIMEOUT = 5.0
MAX_BACKOFF = 300.0
LINE_LIMIT = 1 << 20


class HyperionPoller:
    """Connects, polls and reconnects until stopped. Callbacks run in the event loop."""

    def __init__(
        self,
        host: str,
        port: int,
        token: str,
        poll_ms: int,
        on_colors: Callable[[dict[str, Rgb]], None],
        on_status: Callable[[str], None],
    ) -> None:
        self._host = host
        self._port = port
        self._token = token
        self._poll = max(0.25, min(10.0, poll_ms / 1000))
        self._on_colors = on_colors
        self._on_status = on_status
        self._task: asyncio.Task | None = None
        self._layout: dict[str, list[int]] | None = None
        self.status = "off"

    def start(self, create_task: Callable[..., asyncio.Task]) -> None:
        if self._task is None:
            self._task = create_task(self._run(), f"ambient_color_sync hyperion {self._host}")

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._set_status("off")

    def _set_status(self, status: str) -> None:
        if status != self.status:
            self.status = status
            self._on_status(status)

    async def _run(self) -> None:
        failures = 0
        while True:
            try:
                await self._session()
                failures = 0
            except asyncio.CancelledError:
                raise
            except (OSError, asyncio.TimeoutError, ValueError) as err:
                failures += 1
                delay = min(MAX_BACKOFF, 5 * 2 ** min(failures - 1, 6))
                _LOGGER.warning("Hyperion %s:%s: %s; reconnecting in %d s", self._host, self._port, err or type(err).__name__, delay)
                self._set_status(f"error: {err or type(err).__name__}"[:120])
                await asyncio.sleep(delay)

    async def _session(self) -> None:
        self._set_status("connecting")
        reader, writer = await asyncio.wait_for(asyncio.open_connection(self._host, self._port, limit=LINE_LIMIT), 10)
        try:

            async def send(message: dict[str, Any]) -> None:
                writer.write((json.dumps(message) + "\n").encode())
                await writer.drain()

            if self._token:
                await send({"command": "authorize", "subcommand": "login", "token": self._token, "tan": 1})
            await send({"command": "serverinfo", "tan": 2})
            self._set_status("connected")
            _LOGGER.info("Connected to Hyperion at %s:%s", self._host, self._port)
            misses = 0
            while True:
                await send({"command": "ledcolors", "subcommand": "ledstream-start", "tan": 3})
                loop = asyncio.get_running_loop()
                deadline = loop.time() + REPLY_TIMEOUT
                got = False
                while not got:
                    remaining = deadline - loop.time()
                    if remaining <= 0:
                        break
                    try:
                        line = await asyncio.wait_for(reader.readline(), remaining)
                    except asyncio.TimeoutError:
                        break
                    if not line:
                        raise ConnectionError("the server closed the connection")
                    got = self._handle(line)
                if got:
                    misses = 0
                    await send({"command": "ledcolors", "subcommand": "ledstream-stop", "tan": 4})
                else:
                    misses += 1
                    if misses >= 3:
                        raise asyncio.TimeoutError(f"no LED data for {3 * REPLY_TIMEOUT:.0f} s")
                await asyncio.sleep(self._poll)
                # Updates that arrived after the stop belong to the old request.
                while True:
                    try:
                        line = await asyncio.wait_for(reader.readline(), 0.001)
                    except asyncio.TimeoutError:
                        break
                    if not line:
                        raise ConnectionError("the server closed the connection")
                    if b"ledcolors-ledstream-update" not in line:
                        self._handle(line)
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass

    def _handle(self, line: bytes) -> bool:
        """One server line; True for an LED update (delivered)."""
        try:
            msg = json.loads(line)
        except ValueError:
            return False
        if not isinstance(msg, dict):
            return False
        cmd = msg.get("command")
        if cmd == "ledcolors-ledstream-update":
            payload = msg.get("data") if isinstance(msg.get("data"), dict) else msg.get("result")
            leds = payload.get("leds") if isinstance(payload, dict) else None
            zones = hyperion_zones(leds, self._layout)
            if zones is not None:
                self._on_colors(zones)
            return True
        if cmd == "serverinfo" and msg.get("success") and isinstance(msg.get("info"), dict):
            self._layout = hyperion_layout(msg["info"].get("leds"))
        elif msg.get("success") is False:
            _LOGGER.warning("Hyperion %s: %s", cmd or "request", msg.get("error") or "failed")
            if str(cmd or "").startswith("authorize"):
                self._set_status("error: authorization failed")
        return False
