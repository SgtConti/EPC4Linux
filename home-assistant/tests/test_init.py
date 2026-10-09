"""The integration in a running Home Assistant: config flow, webhook → light commands, pacing, end of stream, the
"Follow screen" switch, entities, unload, and the Hyperion poller against a fake server."""

from __future__ import annotations

import asyncio
import json
from datetime import timedelta
from unittest.mock import patch

import pytest

from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import entity_registry as er
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util

from pytest_homeassistant_custom_component.common import MockConfigEntry, async_fire_time_changed, async_mock_service

from custom_components.ambient_color_sync.const import DOMAIN

LEFT = "light.left_lamp"
STRIP = "light.strip"


async def _post(client, webhook_id: str, doc: dict) -> int:
    resp = await client.post(f"/api/webhook/{webhook_id}", json=doc)
    return resp.status


@pytest.fixture
async def lights(hass: HomeAssistant):
    """Two lights with a known state and recorded light.turn_on / turn_off calls."""
    hass.states.async_set(LEFT, "off", {"supported_color_modes": ["color_temp"], "color_mode": None})
    hass.states.async_set(STRIP, "on", {"supported_color_modes": ["hs"], "color_mode": "hs", "hs_color": (30, 90), "brightness": 180})
    return {"on": async_mock_service(hass, "light", "turn_on"), "off": async_mock_service(hass, "light", "turn_off")}


async def _setup(hass: HomeAssistant, options: dict | None = None) -> MockConfigEntry:
    assert await async_setup_component(hass, "http", {})
    entry = MockConfigEntry(
        domain=DOMAIN,
        title="Desk",
        data={"webhook_id": "test-webhook-id"},
        options={"lights": [LEFT, STRIP], "zones": {LEFT: "left", STRIP: "all"}, "saturation_boost": 0, "transition": 0, **(options or {})},
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


DOC = {"source": "EPC4Linux", "version": 1, "seq": 1, "active": True, "color": [0, 0, 255], "zones": {"left": [255, 0, 0], "right": [0, 255, 0], "top": [0, 0, 0], "bottom": [0, 0, 0]}}


async def test_config_flow_shows_the_webhook_url(hass: HomeAssistant) -> None:
    hass.states.async_set(LEFT, "off")
    with patch("custom_components.ambient_color_sync.config_flow.async_get_source_ip", return_value="192.168.1.20"):
        result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
        assert result["type"] is FlowResultType.FORM and result["step_id"] == "user"
        result = await hass.config_entries.flow.async_configure(result["flow_id"], {"name": "Desk", "lights": [LEFT]})
        assert result["type"] is FlowResultType.FORM and result["step_id"] == "zones"
        result = await hass.config_entries.flow.async_configure(result["flow_id"], {LEFT: "left"})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Desk"
    webhook_id = result["data"]["webhook_id"]
    assert result["description_placeholders"]["url"] == f"http://192.168.1.20:8123/api/webhook/{webhook_id}"
    assert result["result"].options == {"lights": [LEFT], "zones": {LEFT: "left"}}


async def test_options_flow(hass: HomeAssistant, lights) -> None:
    entry = await _setup(hass)
    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert result["type"] is FlowResultType.MENU
    result = await hass.config_entries.options.async_configure(result["flow_id"], {"next_step_id": "behaviour"})
    assert result["step_id"] == "behaviour"
    values = {
        "brightness_mode": "fixed", "min_brightness": 5.0, "max_brightness": 90.0, "fixed_brightness": 60.0, "saturation_boost": 10.0,
        "dark_threshold": 4.0, "dark_action": "off", "min_interval": 1000.0, "change_threshold": 3.0, "transition": 0.5,
        "end_action": "off", "inactive_timeout": 20.0,
    }
    result = await hass.config_entries.options.async_configure(result["flow_id"], values)
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    assert entry.options["fixed_brightness"] == 60 and isinstance(entry.options["fixed_brightness"], int)
    assert entry.options["transition"] == 0.5
    assert entry.options["lights"] == [LEFT, STRIP], "other options kept"

    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(result["flow_id"], {"next_step_id": "hyperion"})
    result = await hass.config_entries.options.async_configure(result["flow_id"], {"hyperion_enabled": True, "hyperion_host": " ", "hyperion_port": 19444, "hyperion_poll": 1000})
    assert result["errors"] == {"hyperion_host": "host_required"}


async def test_webhook_drives_the_lights_and_restores_them(hass: HomeAssistant, hass_client_no_auth, lights) -> None:
    entry = await _setup(hass)
    client = await hass_client_no_auth()
    assert await _post(client, "test-webhook-id", DOC) == 200
    await hass.async_block_till_done()
    calls = {c.data["entity_id"]: c.data for c in lights["on"]}
    assert calls[LEFT] == {"entity_id": LEFT, "hs_color": (0, 100), "brightness_pct": 100}, "left lamp: left edge (red)"
    assert calls[STRIP] == {"entity_id": STRIP, "hs_color": (240, 100), "brightness_pct": 100}, "strip: whole screen (blue)"
    assert hass.states.get("binary_sensor.desk_streaming").state == "on"
    assert entry.runtime_data.color_hex == "#0000FF"
    assert hass.states.get("sensor.desk_screen_colour") is None, "disabled by default (recorder load)"
    assert er.async_get(hass).async_get("sensor.desk_screen_colour").disabled_by is er.RegistryEntryDisabler.INTEGRATION

    # Within the minimum interval: one deferred round with the newest colours.
    n = len(lights["on"])
    await _post(client, "test-webhook-id", {**DOC, "color": [0, 255, 0]})
    await _post(client, "test-webhook-id", {**DOC, "color": [255, 255, 0]})
    await hass.async_block_till_done()
    assert len(lights["on"]) == n
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=1))
    await hass.async_block_till_done()
    assert [c.data for c in lights["on"][n:]] == [{"entity_id": STRIP, "hs_color": (60, 100), "brightness_pct": 100}], "only the changed light"

    # The sender ends the stream: the lights' previous states come back (reproduce_state). The mocked services do not
    # change states, so set what the lights would show now.
    hass.states.async_set(LEFT, "on", {"supported_color_modes": ["color_temp", "hs"], "color_mode": "hs", "hs_color": (0, 100), "brightness": 255})
    hass.states.async_set(STRIP, "on", {"supported_color_modes": ["hs"], "color_mode": "hs", "hs_color": (60, 100), "brightness": 255})
    await _post(client, "test-webhook-id", {"source": "EPC4Linux", "version": 1, "active": False})
    await hass.async_block_till_done()
    assert hass.states.get("binary_sensor.desk_streaming").state == "off"
    assert any(c.data.get("entity_id") in (LEFT, [LEFT]) for c in lights["off"]), "left lamp was off: off again"
    restored = [c.data for c in lights["on"] if c.data.get("entity_id") in (STRIP, [STRIP]) and "brightness" in c.data]
    assert restored and restored[-1].get("hs_color") == (30, 90) and restored[-1]["brightness"] == 180

    assert await hass.config_entries.async_unload(entry.entry_id)
    assert await _post(client, "test-webhook-id", DOC) == 200  # unknown webhooks still answer 200
    await hass.async_block_till_done()


async def test_hyperion_json_black_screen_switch_and_watchdog(hass: HomeAssistant, hass_client_no_auth, lights) -> None:
    await _setup(hass, {"dark_action": "off", "end_action": "off", "min_interval": 100})
    client = await hass_client_no_auth()
    assert await _post(client, "test-webhook-id", {"command": "color", "color": [255, 128, 0], "priority": 50, "origin": "script"}) == 200
    await hass.async_block_till_done()
    assert {c.data["entity_id"] for c in lights["on"]} == {LEFT, STRIP}, "a single colour: every light follows it"
    assert hass.states.get("binary_sensor.desk_streaming").attributes["source"] == "script"

    await _post(client, "test-webhook-id", {**DOC, "color": [0, 0, 0], "zones": {"left": [0, 0, 0]}})
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=1))  # the deferred round
    await hass.async_block_till_done()
    assert {c.data["entity_id"] for c in lights["off"]} == {LEFT, STRIP}, "black screen with 'off'"

    # "Follow screen" off: the session ends (end action off) and colours no longer reach the lights.
    await hass.services.async_call("switch", "turn_off", {"entity_id": "switch.desk_follow_screen"}, blocking=True)
    assert hass.states.get("binary_sensor.desk_streaming").state == "off"
    n = len(lights["on"])
    await _post(client, "test-webhook-id", DOC)
    await hass.async_block_till_done()
    assert len(lights["on"]) == n
    await hass.services.async_call("switch", "turn_on", {"entity_id": "switch.desk_follow_screen"}, blocking=True)
    await _post(client, "test-webhook-id", DOC)
    await hass.async_block_till_done()
    assert hass.states.get("binary_sensor.desk_streaming").state == "on"

    assert (await client.post("/api/webhook/test-webhook-id", data="not json")).status == 400

    # Silence: the watchdog ends the session.
    with patch("custom_components.ambient_color_sync.sync.time.monotonic", return_value=1e12):
        async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=30))
        await hass.async_block_till_done()
    assert hass.states.get("binary_sensor.desk_streaming").state == "off"



async def test_respect_mode_only_lights_that_are_on_follow(hass: HomeAssistant, hass_client_no_auth, lights) -> None:
    await _setup(hass, {"on_off": "respect", "dark_action": "off", "min_interval": 50})
    client = await hass_client_no_auth()
    await _post(client, "test-webhook-id", DOC)
    await hass.async_block_till_done()
    assert [c.data["entity_id"] for c in lights["on"]] == [STRIP], "the left lamp is off: left alone"

    # Switched on by someone else: follows at once (its zone's colour), without waiting for a new frame.
    hass.states.async_set(LEFT, "on", {"supported_color_modes": ["hs"], "color_mode": "hs"})
    await hass.async_block_till_done()
    assert lights["on"][-1].data == {"entity_id": LEFT, "hs_color": (0, 100), "brightness_pct": 100}

    # Black screen with "off": respect mode dims instead of switching off.
    await _post(client, "test-webhook-id", {**DOC, "color": [0, 0, 0], "zones": {"left": [0, 0, 0]}})
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=1))
    await hass.async_block_till_done()
    assert lights["off"] == []
    assert {c.data["entity_id"]: c.data["brightness_pct"] for c in lights["on"][-2:]} == {LEFT: 10, STRIP: 10}

    # Switched off by someone else: stays off while the colours change.
    hass.states.async_set(LEFT, "off")
    await hass.async_block_till_done()
    n = len(lights["on"])
    await _post(client, "test-webhook-id", {**DOC, "color": [0, 255, 0], "zones": {"left": [255, 255, 0]}})
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=2))
    await hass.async_block_till_done()
    assert [c.data["entity_id"] for c in lights["on"][n:]] == [STRIP]

    # End of stream: only the strip (on before and now) gets its old colour back; the left lamp is not touched.
    hass.states.async_set(STRIP, "on", {"supported_color_modes": ["hs"], "color_mode": "hs", "hs_color": (120, 100), "brightness": 255})
    await hass.async_block_till_done()
    n = len(lights["on"])
    await _post(client, "test-webhook-id", {"source": "EPC4Linux", "active": False})
    await hass.async_block_till_done()
    assert lights["off"] == []
    restored = lights["on"][n:]
    assert [c.data["entity_id"] for c in restored] in ([STRIP], [[STRIP]])
    assert restored[0].data["hs_color"] == (30, 90) and restored[0].data["brightness"] == 180


async def test_a_slow_light_gets_only_the_newest_colour(hass: HomeAssistant, hass_client_no_auth) -> None:
    hass.states.async_set(STRIP, "on", {"supported_color_modes": ["hs"], "color_mode": "hs"})
    release = asyncio.Event()
    calls: list[dict] = []

    async def slow_turn_on(call) -> None:
        calls.append(dict(call.data))
        await release.wait()

    hass.services.async_register("light", "turn_on", slow_turn_on)
    assert await async_setup_component(hass, "http", {})
    entry = MockConfigEntry(domain=DOMAIN, title="Desk", data={"webhook_id": "slow"}, options={"lights": [STRIP], "min_interval": 50, "transition": 0, "saturation_boost": 0})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    client = await hass_client_no_auth()
    for color in ([255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]):
        await _post(client, "slow", {**DOC, "color": color, "zones": {}})
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=1))  # the deferred round: the newest colours
    for _ in range(5):
        await asyncio.sleep(0)
    assert [c["hs_color"] for c in calls] == [(0, 100)], "one command in flight; the others wait"
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=2))
    await asyncio.sleep(0)
    assert len(calls) == 1, "still busy: nothing more goes out"
    release.set()
    for _ in range(20):
        await asyncio.sleep(0.01)
    assert [c["hs_color"] for c in calls] == [(0, 100), (60, 100)], "then only the newest (yellow)"
    assert await hass.config_entries.async_unload(entry.entry_id)


async def test_hyperion_pull(hass: HomeAssistant, lights, socket_enabled) -> None:
    received: list[dict] = []

    async def server(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        while line := await reader.readline():
            msg = json.loads(line)
            received.append(msg)
            if msg["command"] == "serverinfo":
                info = {"leds": [{"hmin": 0, "hmax": 0.1, "vmin": 0.4, "vmax": 0.5}, {"hmin": 0.9, "hmax": 1, "vmin": 0.4, "vmax": 0.5}]}
                writer.write((json.dumps({"command": "serverinfo", "success": True, "tan": 2, "info": info}) + "\n").encode())
            elif msg.get("subcommand") == "ledstream-start":
                update = json.dumps({"command": "ledcolors-ledstream-update", "data": {"leds": [255, 0, 0, 0, 0, 255]}}) + "\n"
                writer.write(update.encode() * 3)  # the stream runs on until stopped
            await writer.drain()

    srv = await asyncio.start_server(server, "127.0.0.1", 0)
    port = srv.sockets[0].getsockname()[1]
    try:
        entry = await _setup(hass, {"hyperion_enabled": True, "hyperion_host": "127.0.0.1", "hyperion_port": port, "hyperion_poll": 250})
        for _ in range(100):
            await asyncio.sleep(0.02)
            await hass.async_block_till_done()
            if lights["on"]:
                break
        calls = {c.data["entity_id"]: c.data for c in lights["on"]}
        assert calls[LEFT]["hs_color"] == (0, 100), "left zone from the Hyperion layout"
        assert calls[STRIP]["hs_color"] == (300, 100), "all: the average (magenta)"
        assert hass.states.get("sensor.desk_hyperion_connection").state == "connected"
        assert [m.get("subcommand") or m["command"] for m in received[:3]] == ["serverinfo", "ledstream-start", "ledstream-stop"]
        assert await hass.config_entries.async_unload(entry.entry_id)
    finally:
        srv.close()
        await srv.wait_closed()
