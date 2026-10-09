"""Ambient Color Sync: lights follow the screen colours of EPC4Linux (Ambiglow Follow Video) or Hyperion.

EPC4Linux POSTs the colours to this entry's webhook (/api/webhook/<id>, local network only); Hyperion JSON "color" /
"clear" commands to the same webhook work too, and a Hyperion.ng server can be polled instead. See README.md.
"""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant

from .sync import AmbientColorSync

PLATFORMS: list[Platform] = [Platform.BINARY_SENSOR, Platform.SENSOR, Platform.SWITCH]

type AmbientColorSyncConfigEntry = ConfigEntry[AmbientColorSync]


async def async_setup_entry(hass: HomeAssistant, entry: AmbientColorSyncConfigEntry) -> bool:
    sync = AmbientColorSync(hass, entry)
    entry.runtime_data = sync
    await sync.async_start()
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_options_updated))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: AmbientColorSyncConfigEntry) -> bool:
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        await entry.runtime_data.async_stop()
    return unloaded


async def _async_options_updated(hass: HomeAssistant, entry: AmbientColorSyncConfigEntry) -> None:
    """New options: reload (restores the lights of a running session first)."""
    await hass.config_entries.async_reload(entry.entry_id)
