"""The "Follow screen" switch: off pauses the lights (the end action applies), on lets the next colours drive them."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.restore_state import RestoreEntity

from . import AmbientColorSyncConfigEntry
from .entity import AmbientColorSyncEntity


async def async_setup_entry(hass: HomeAssistant, entry: AmbientColorSyncConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback) -> None:
    async_add_entities([FollowSwitch(entry.runtime_data, "follow")])


class FollowSwitch(AmbientColorSyncEntity, SwitchEntity, RestoreEntity):
    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        last = await self.async_get_last_state()
        if last is not None and last.state == "off":
            self.sync.following = False

    @property
    def is_on(self) -> bool:
        return self.sync.following

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self.sync.async_set_following(True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self.sync.async_set_following(False)
