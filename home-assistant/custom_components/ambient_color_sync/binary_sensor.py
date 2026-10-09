""""Streaming": on while a session runs (colours arriving and the lights following)."""

from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import AmbientColorSyncConfigEntry
from .entity import AmbientColorSyncEntity


async def async_setup_entry(hass: HomeAssistant, entry: AmbientColorSyncConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback) -> None:
    async_add_entities([StreamingSensor(entry.runtime_data, "streaming")])


class StreamingSensor(AmbientColorSyncEntity, BinarySensorEntity):
    _attr_device_class = BinarySensorDeviceClass.RUNNING
    _unrecorded_attributes = frozenset({"source"})

    @property
    def is_on(self) -> bool:
        return self.sync.active

    @property
    def extra_state_attributes(self) -> dict[str, str | None]:
        return {"source": self.sync.source}
