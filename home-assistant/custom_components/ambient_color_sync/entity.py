"""Common base of the entry's entities: one device per entry, updated through the dispatcher."""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity import Entity

from .const import DOMAIN, SIGNAL_UPDATE
from .sync import AmbientColorSync


class AmbientColorSyncEntity(Entity):
    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, sync: AmbientColorSync, key: str) -> None:
        self.sync = sync
        self._attr_unique_id = f"{sync.entry.entry_id}_{key}"
        self._attr_translation_key = key
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, sync.entry.entry_id)},
            name=sync.entry.title,
            entry_type=DeviceEntryType.SERVICE,
        )

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(
            async_dispatcher_connect(self.hass, SIGNAL_UPDATE.format(self.sync.entry.entry_id), self.async_write_ha_state)
        )
