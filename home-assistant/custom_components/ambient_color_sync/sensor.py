"""Screen colour (whole screen, #RRGGBB, at most every sensor interval) and the Hyperion connection state.

The screen colour sensor is disabled by default: while colours stream it changes every few seconds, and the recorder
would store every change. Enable it in the entity settings if you want it (its rgb_color attribute is never recorded).
"""

from __future__ import annotations

from homeassistant.components.sensor import SensorEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import AmbientColorSyncConfigEntry
from .const import CONF_HYPERION_ENABLED
from .entity import AmbientColorSyncEntity


async def async_setup_entry(hass: HomeAssistant, entry: AmbientColorSyncConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback) -> None:
    sync = entry.runtime_data
    entities: list[SensorEntity] = [ScreenColorSensor(sync, "screen_color")]
    if sync.opts[CONF_HYPERION_ENABLED]:
        entities.append(HyperionSensor(sync, "hyperion"))
    async_add_entities(entities)


class ScreenColorSensor(AmbientColorSyncEntity, SensorEntity):
    _attr_entity_registry_enabled_default = False
    _unrecorded_attributes = frozenset({"rgb_color", "source"})

    @property
    def native_value(self) -> str | None:
        return self.sync.color_hex

    @property
    def extra_state_attributes(self) -> dict[str, object]:
        return {"rgb_color": list(self.sync.color) if self.sync.color else None, "source": self.sync.source}


class HyperionSensor(AmbientColorSyncEntity, SensorEntity):
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    @property
    def native_value(self) -> str:
        return self.sync.hyperion_status
