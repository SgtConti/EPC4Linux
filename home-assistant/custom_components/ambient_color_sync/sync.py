"""The colour sync of one config entry: receives colours (webhook, Hyperion) and drives the lights.

- Each light follows the whole screen or one edge of it (left, right, top, bottom).
- Pacing: at most one round per minimum interval, and a light only gets a new command when its colour moved by the
  change threshold. Each light has at most one command in flight: while a slow light is still busy, newer colours only
  replace its pending one, which goes out when the previous command finished. Nothing piles up, the newest colours win,
  so a fast light (Wi-Fi, WLED) can follow every frame while a slow one (Zigbee) skips what it cannot keep up with.
- On/off: in "control" mode the sync turns lights on (with the colour) and off (black screen, end of stream) itself; in
  "respect" mode only lights that are on follow — a light switched off by someone else (a rule, a wall switch, an
  automation) stays off, and follows the screen again as soon as it is switched on.
- A session starts with the first colours; its end (the sender says so, the "Follow screen" switch is turned off, or
  nothing arrives for the inactivity timeout) restores the lights' previous states, turns them off, or leaves them.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta
import logging
import time
from typing import Any

from aiohttp import web

from homeassistant.components import webhook
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import ATTR_ENTITY_ID, STATE_ON
from homeassistant.core import CALLBACK_TYPE, Context, Event, EventStateChangedData, HomeAssistant, State, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_call_later, async_track_state_change_event, async_track_time_interval
from homeassistant.helpers.state import async_reproduce_state

from .colors import Rgb, Target, changed, parse_rgb, target_for, to_hex, zones_from_payload
from .const import (
    COMMAND_TIMEOUT,
    CONF_CHANGE_THRESHOLD,
    CONF_DARK_ACTION,
    CONF_END_ACTION,
    CONF_HYPERION_ENABLED,
    CONF_HYPERION_HOST,
    CONF_HYPERION_POLL,
    CONF_HYPERION_PORT,
    CONF_HYPERION_TOKEN,
    CONF_INACTIVE_TIMEOUT,
    CONF_LIGHTS,
    CONF_MIN_INTERVAL,
    CONF_ON_OFF,
    CONF_SENSOR_INTERVAL,
    CONF_TRANSITION,
    CONF_WEBHOOK_ID,
    CONF_ZONES,
    DEFAULTS,
    DOMAIN,
    SIGNAL_UPDATE,
    WATCHDOG_INTERVAL,
)
from .hyperion import HyperionPoller

_LOGGER = logging.getLogger(__name__)


class AmbientColorSync:
    """State and logic of one entry; the entities only show and switch it."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self.opts: dict[str, Any] = {**DEFAULTS, **entry.options}
        self.respect = self.opts[CONF_ON_OFF] == "respect"
        # In "respect" mode the sync never switches a light off itself: a black screen dims instead.
        self._target_opts = {**self.opts, CONF_DARK_ACTION: "dim"} if self.respect and self.opts[CONF_DARK_ACTION] == "off" else self.opts
        self.following = True  # the "Follow screen" switch
        self.active = False  # a session runs (colours arriving, lights driven)
        self.source: str | None = None
        self.color: Rgb | None = None
        self.hyperion_status = "off"
        self._color_at = -1e9
        self._zones: dict[str, Rgb] | None = None
        self._last_seen = 0.0
        self._last_flush = -1e9
        self._flush_unsub: CALLBACK_TYPE | None = None
        self._watchdog_unsub: CALLBACK_TYPE | None = None
        self._lights_unsub: CALLBACK_TYPE | None = None
        self._sent: dict[str, Target] = {}  # the last command per light
        self._pending: dict[str, Target] = {}  # the next command per light, while its previous one runs
        self._busy: set[str] = set()  # lights with a command in flight
        self._snapshot: list[State] = []
        self._context = Context()
        self._hyperion: HyperionPoller | None = None

    # ───────────── lifecycle ─────────────

    @property
    def webhook_id(self) -> str:
        return self.entry.data[CONF_WEBHOOK_ID]

    async def async_start(self) -> None:
        webhook.async_register(
            self.hass, DOMAIN, f"Ambient Color Sync ({self.entry.title})", self.webhook_id, self._handle_webhook,
            local_only=True, allowed_methods=["POST"],
        )
        if self.opts[CONF_HYPERION_ENABLED] and self.opts[CONF_HYPERION_HOST]:
            self._hyperion = HyperionPoller(
                self.opts[CONF_HYPERION_HOST], int(self.opts[CONF_HYPERION_PORT]), self.opts[CONF_HYPERION_TOKEN],
                int(self.opts[CONF_HYPERION_POLL]), lambda z: self.receive(z, "Hyperion"), self._hyperion_changed,
            )
            self._hyperion.start(lambda coro, name: self.entry.async_create_background_task(self.hass, coro, name))

    async def async_stop(self) -> None:
        webhook.async_unregister(self.hass, self.webhook_id)
        if self._hyperion is not None:
            await self._hyperion.stop()
            self._hyperion = None
        await self.async_end_session("integration unloaded")

    # ───────────── input ─────────────

    async def _handle_webhook(self, hass: HomeAssistant, webhook_id: str, request: web.Request) -> web.Response:
        try:
            data = await request.json()
        except ValueError:
            return web.Response(status=400, text="expected JSON")
        if not isinstance(data, dict):
            return web.Response(status=400, text="expected a JSON object")
        await self.async_handle_payload(data)
        return web.Response(status=200)

    async def async_handle_payload(self, data: dict[str, Any]) -> None:
        """An EPC4Linux document, or a Hyperion JSON-RPC command ("color", "clear", "clearall")."""
        command = data.get("command")
        if command is not None:
            if command == "color":
                rgb = parse_rgb(data.get("color"))
                if rgb is not None:
                    self.receive({"all": rgb}, str(data.get("origin") or "Hyperion JSON")[:40])
            elif command in ("clear", "clearall"):
                await self.async_source_ended("Hyperion JSON")
            else:
                _LOGGER.debug("Hyperion command %s ignored", command)
            return
        source = str(data.get("source") or "webhook")[:40]
        if data.get("active") is False:
            await self.async_source_ended(source)
            return
        zones = zones_from_payload(data)
        if zones is None:
            _LOGGER.debug("Document without a colour ignored")
            return
        self.receive(zones, source)

    @callback
    def receive(self, zones: dict[str, Rgb], source: str) -> None:
        """Colours of one frame."""
        now = time.monotonic()
        self._last_seen = now
        notify = False
        if source != self.source:
            self.source = source
            notify = True
        if now - self._color_at >= float(self.opts[CONF_SENSOR_INTERVAL]) and zones["all"] != self.color:
            self.color = zones["all"]
            self._color_at = now
            notify = True
        if self.following and self.opts[CONF_LIGHTS]:
            if not self.active:
                self._start_session()
                notify = True
            self._zones = zones
            wait = self._last_flush + self.opts[CONF_MIN_INTERVAL] / 1000 - now
            if wait <= 0:
                self._flush()
            elif self._flush_unsub is None:
                self._flush_unsub = async_call_later(self.hass, wait, self._flush_later)
        if notify:
            self._notify()

    async def async_source_ended(self, source: str) -> None:
        await self.async_end_session(f"{source} stopped")

    async def async_set_following(self, on: bool) -> None:
        """The "Follow screen" switch: off ends the session (the end action applies)."""
        self.following = on
        if not on:
            await self.async_end_session("Follow screen switched off")
        self._notify()

    # ───────────── session ─────────────

    @callback
    def _start_session(self) -> None:
        self.active = True
        self._sent = {}
        self._pending = {}
        self._context = Context()
        lights = self.opts[CONF_LIGHTS]
        self._snapshot = [s for s in (self.hass.states.get(e) for e in lights) if s is not None]
        self._watchdog_unsub = async_track_time_interval(self.hass, self._watchdog, timedelta(seconds=WATCHDOG_INTERVAL))
        if self.respect:
            self._lights_unsub = async_track_state_change_event(self.hass, lights, self._light_changed)
        _LOGGER.info(
            "%s: colours from %s, %d light(s) follow%s", self.entry.title, self.source, len(lights),
            " (only while on)" if self.respect else "",
        )

    async def _watchdog(self, _now: Any) -> None:
        silent = time.monotonic() - self._last_seen
        if self.active and silent > float(self.opts[CONF_INACTIVE_TIMEOUT]):
            await self.async_end_session(f"no colours for {silent:.0f} s")

    async def async_end_session(self, reason: str) -> None:
        if not self.active:
            return
        self.active = False
        self._zones = None
        self._pending = {}
        for unsub in (self._flush_unsub, self._watchdog_unsub, self._lights_unsub):
            if unsub is not None:
                unsub()
        self._flush_unsub = self._watchdog_unsub = self._lights_unsub = None
        # Commands still running would land after the restore: let them finish first (briefly).
        for _ in range(40):
            if not self._busy:
                break
            await asyncio.sleep(0.05)
        action = self.opts[CONF_END_ACTION]
        _LOGGER.info("%s: %s; lights %s", self.entry.title, reason, {"off": "off", "leave": "left as they are"}.get(action, "restored"))
        if action == "off":
            await self.hass.services.async_call(
                "light", "turn_off", {ATTR_ENTITY_ID: list(self.opts[CONF_LIGHTS])}, blocking=True, context=self._context
            )
        elif action == "restore" and self._snapshot:
            snapshot = self._snapshot
            if self.respect:
                # Only what the sync changed: lights that were on before and are on now get their colour back; a light
                # switched on or off by someone else meanwhile is left as it is.
                snapshot = [s for s in snapshot if s.state == STATE_ON and self._is_on(s.entity_id)]
            if snapshot:
                await async_reproduce_state(self.hass, snapshot, context=self._context)
        self._snapshot = []
        self._notify()

    # ───────────── driving the lights ─────────────

    def _is_on(self, entity_id: str) -> bool:
        state = self.hass.states.get(entity_id)
        return state is not None and state.state == STATE_ON

    @callback
    def _light_changed(self, event: Event[EventStateChangedData]) -> None:
        """"Respect" mode: a light switched on by someone else follows at once; one switched off is forgotten."""
        new, old = event.data["new_state"], event.data["old_state"]
        entity_id = event.data["entity_id"]
        if new is None or (old is not None and old.state == new.state):
            return
        self._sent.pop(entity_id, None)
        self._pending.pop(entity_id, None)
        if new.state == STATE_ON and self.active and self._zones is not None:
            self._update(entity_id, self._zones)

    @callback
    def _flush_later(self, _now: Any) -> None:
        self._flush_unsub = None
        self._flush()

    @callback
    def _flush(self) -> None:
        self._last_flush = time.monotonic()
        zones = self._zones
        if not self.active or zones is None:
            return
        for entity_id in self.opts[CONF_LIGHTS]:
            self._update(entity_id, zones)

    @callback
    def _update(self, entity_id: str, zones: dict[str, Rgb]) -> None:
        """The light's target for these colours, sent (or queued behind its running command) if it changed enough."""
        if self.respect and not self._is_on(entity_id):
            return
        rgb = zones.get(self.opts[CONF_ZONES].get(entity_id, "all")) or zones["all"]
        target = target_for(rgb, self._target_opts)
        if target is None:
            return
        last = self._pending.get(entity_id) or self._sent.get(entity_id)
        if not changed(last, target, float(self.opts[CONF_CHANGE_THRESHOLD])):
            return
        self._pending[entity_id] = target
        self._kick(entity_id)

    @callback
    def _kick(self, entity_id: str) -> None:
        if entity_id in self._busy:
            return  # the pending target goes out when the running command finished
        target = self._pending.pop(entity_id, None)
        if target is None:
            return
        self._busy.add(entity_id)
        self._sent[entity_id] = target
        self.entry.async_create_task(self.hass, self._send(entity_id, target), f"{DOMAIN} {entity_id}")

    async def _send(self, entity_id: str, target: Target) -> None:
        if target.off:
            service, data = "turn_off", {ATTR_ENTITY_ID: entity_id}
        else:
            service = "turn_on"
            data = {ATTR_ENTITY_ID: entity_id, "hs_color": (target.hue, target.saturation), "brightness_pct": target.brightness_pct}
        transition = float(self.opts[CONF_TRANSITION])
        if transition > 0:
            data["transition"] = transition
        try:
            # Re-checked at the last moment: a light switched off while this command waited stays off.
            if self.respect and not self._is_on(entity_id):
                return
            async with asyncio.timeout(COMMAND_TIMEOUT):
                await self.hass.services.async_call("light", service, data, blocking=True, context=self._context)
        except TimeoutError:
            _LOGGER.debug("%s: %s took longer than %.0f s", entity_id, service, COMMAND_TIMEOUT)
        except Exception as err:  # noqa: BLE001 - a failing light must not stop the others
            _LOGGER.debug("%s: %s failed: %s", entity_id, service, err)
        finally:
            self._busy.discard(entity_id)
            if self.active:
                self._kick(entity_id)

    # ───────────── entities ─────────────

    @callback
    def _hyperion_changed(self, status: str) -> None:
        self.hyperion_status = status
        self._notify()

    @callback
    def _notify(self) -> None:
        async_dispatcher_send(self.hass, SIGNAL_UPDATE.format(self.entry.entry_id))

    @property
    def color_hex(self) -> str | None:
        return to_hex(self.color) if self.color else None
