"""Config and options flow: name and lights first (each light with the part of the screen it follows); behaviour and
the Hyperion pull in the options. The entry's webhook URL, which EPC4Linux needs, is shown after setup and in the
options."""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.components import webhook
from homeassistant.components.network import async_get_source_ip
from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.const import CONF_NAME
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.selector import (
    BooleanSelector,
    EntitySelector,
    EntitySelectorConfig,
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)

from .const import (
    BRIGHTNESS_MODES,
    CONF_BRIGHTNESS_MODE,
    CONF_CHANGE_THRESHOLD,
    CONF_DARK_ACTION,
    CONF_DARK_THRESHOLD,
    CONF_END_ACTION,
    CONF_FIXED_BRIGHTNESS,
    CONF_HYPERION_ENABLED,
    CONF_HYPERION_HOST,
    CONF_HYPERION_POLL,
    CONF_HYPERION_PORT,
    CONF_HYPERION_TOKEN,
    CONF_INACTIVE_TIMEOUT,
    CONF_LIGHTS,
    CONF_MAX_BRIGHTNESS,
    CONF_MIN_BRIGHTNESS,
    CONF_MIN_INTERVAL,
    CONF_ON_OFF,
    CONF_SENSOR_INTERVAL,
    CONF_SATURATION_BOOST,
    CONF_TRANSITION,
    CONF_WEBHOOK_ID,
    CONF_ZONES,
    DARK_ACTIONS,
    DEFAULTS,
    DOMAIN,
    END_ACTIONS,
    ON_OFF_MODES,
    ZONES,
)

_LOGGER = logging.getLogger(__name__)

LIGHTS_SELECTOR = EntitySelector(EntitySelectorConfig(domain="light", multiple=True))


async def async_webhook_url(hass: HomeAssistant, webhook_id: str) -> str:
    """The URL EPC4Linux posts to: this host's LAN IP (EPC4Linux takes no host names) and Home Assistant's port."""
    path = webhook.async_generate_path(webhook_id)
    api = hass.config.api
    scheme = "https" if api is not None and api.use_ssl else "http"
    port = api.port if api is not None else 8123
    try:
        ip = await async_get_source_ip(hass)
    except Exception:  # noqa: BLE001 - no network information: fall back to a placeholder
        _LOGGER.debug("No source IP for the webhook URL", exc_info=True)
        ip = "<home-assistant-ip>"
    return f"{scheme}://{ip}:{port}{path}"


def _number(lo: float, hi: float, step: float = 1, unit: str | None = None) -> NumberSelector:
    config = NumberSelectorConfig(min=lo, max=hi, step=step, mode=NumberSelectorMode.BOX)
    if unit is not None:  # the selector refuses unit_of_measurement=None
        config["unit_of_measurement"] = unit
    return NumberSelector(config)


def _select(options: tuple[str, ...], key: str) -> SelectSelector:
    return SelectSelector(SelectSelectorConfig(options=list(options), translation_key=key, mode=SelectSelectorMode.DROPDOWN))


def _zones_schema(lights: list[str], zones: dict[str, str]) -> vol.Schema:
    return vol.Schema({vol.Required(e, default=zones.get(e, "all")): _select(ZONES, "zone") for e in lights})


def _behaviour_schema(o: dict[str, Any]) -> vol.Schema:
    return vol.Schema(
        {
            vol.Required(CONF_ON_OFF, default=o[CONF_ON_OFF]): _select(ON_OFF_MODES, "on_off"),
            vol.Required(CONF_BRIGHTNESS_MODE, default=o[CONF_BRIGHTNESS_MODE]): _select(BRIGHTNESS_MODES, "brightness_mode"),
            vol.Required(CONF_MIN_BRIGHTNESS, default=o[CONF_MIN_BRIGHTNESS]): _number(1, 100, unit="%"),
            vol.Required(CONF_MAX_BRIGHTNESS, default=o[CONF_MAX_BRIGHTNESS]): _number(1, 100, unit="%"),
            vol.Required(CONF_FIXED_BRIGHTNESS, default=o[CONF_FIXED_BRIGHTNESS]): _number(1, 100, unit="%"),
            vol.Required(CONF_SATURATION_BOOST, default=o[CONF_SATURATION_BOOST]): _number(0, 200, unit="%"),
            vol.Required(CONF_DARK_THRESHOLD, default=o[CONF_DARK_THRESHOLD]): _number(0, 100, unit="%"),
            vol.Required(CONF_DARK_ACTION, default=o[CONF_DARK_ACTION]): _select(DARK_ACTIONS, "dark_action"),
            vol.Required(CONF_MIN_INTERVAL, default=o[CONF_MIN_INTERVAL]): _number(50, 10000, 10, "ms"),
            vol.Required(CONF_CHANGE_THRESHOLD, default=o[CONF_CHANGE_THRESHOLD]): _number(0, 50),
            vol.Required(CONF_TRANSITION, default=o[CONF_TRANSITION]): _number(0, 5, 0.1, "s"),
            vol.Required(CONF_END_ACTION, default=o[CONF_END_ACTION]): _select(END_ACTIONS, "end_action"),
            vol.Required(CONF_INACTIVE_TIMEOUT, default=o[CONF_INACTIVE_TIMEOUT]): _number(5, 600, unit="s"),
            vol.Required(CONF_SENSOR_INTERVAL, default=o[CONF_SENSOR_INTERVAL]): _number(0.1, 60, 0.1, "s"),
        }
    )


def _hyperion_schema(o: dict[str, Any]) -> vol.Schema:
    return vol.Schema(
        {
            vol.Required(CONF_HYPERION_ENABLED, default=o[CONF_HYPERION_ENABLED]): BooleanSelector(),
            vol.Optional(CONF_HYPERION_HOST, default=o[CONF_HYPERION_HOST]): TextSelector(),
            vol.Required(CONF_HYPERION_PORT, default=o[CONF_HYPERION_PORT]): _number(1, 65535),
            vol.Optional(CONF_HYPERION_TOKEN, default=o[CONF_HYPERION_TOKEN]): TextSelector(TextSelectorConfig(type=TextSelectorType.PASSWORD)),
            vol.Required(CONF_HYPERION_POLL, default=o[CONF_HYPERION_POLL]): _number(250, 10000, 50, "ms"),
        }
    )


def _ints(values: dict[str, Any]) -> dict[str, Any]:
    """Number selectors return floats; whole-number settings are stored as ints."""
    return {k: int(v) if isinstance(v, float) and v.is_integer() and k not in (CONF_TRANSITION, CONF_SENSOR_INTERVAL) else v for k, v in values.items()}


class AmbientColorSyncConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    def __init__(self) -> None:
        self._name = "Ambient Color Sync"
        self._lights: list[str] = []

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            self._name = user_input[CONF_NAME].strip() or self._name
            self._lights = list(user_input.get(CONF_LIGHTS, []))
            if self._lights:
                return await self.async_step_zones()
            return await self._async_create({})
        schema = vol.Schema(
            {
                vol.Required(CONF_NAME, default=self._name): TextSelector(),
                vol.Optional(CONF_LIGHTS, default=[]): LIGHTS_SELECTOR,
            }
        )
        return self.async_show_form(step_id="user", data_schema=schema)

    async def async_step_zones(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return await self._async_create({e: user_input.get(e, "all") for e in self._lights})
        return self.async_show_form(step_id="zones", data_schema=_zones_schema(self._lights, {}))

    async def _async_create(self, zones: dict[str, str]) -> ConfigFlowResult:
        webhook_id = webhook.async_generate_id()
        return self.async_create_entry(
            title=self._name,
            data={CONF_WEBHOOK_ID: webhook_id},
            options={CONF_LIGHTS: self._lights, CONF_ZONES: zones},
            description_placeholders={"url": await async_webhook_url(self.hass, webhook_id)},
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return AmbientColorSyncOptionsFlow()


class AmbientColorSyncOptionsFlow(OptionsFlow):
    def __init__(self) -> None:
        self._lights: list[str] = []

    @property
    def _options(self) -> dict[str, Any]:
        return {**DEFAULTS, **self.config_entry.options}

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        url = await async_webhook_url(self.hass, self.config_entry.data[CONF_WEBHOOK_ID])
        return self.async_show_menu(step_id="init", menu_options=["lights", "behaviour", "hyperion"], description_placeholders={"url": url})

    async def async_step_lights(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            self._lights = list(user_input.get(CONF_LIGHTS, []))
            if self._lights:
                return await self.async_step_zones()
            return self._save({CONF_LIGHTS: [], CONF_ZONES: {}})
        schema = vol.Schema({vol.Optional(CONF_LIGHTS, default=self._options[CONF_LIGHTS]): LIGHTS_SELECTOR})
        return self.async_show_form(step_id="lights", data_schema=schema)

    async def async_step_zones(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self._save({CONF_LIGHTS: self._lights, CONF_ZONES: {e: user_input.get(e, "all") for e in self._lights}})
        return self.async_show_form(step_id="zones", data_schema=_zones_schema(self._lights, self._options[CONF_ZONES]))

    async def async_step_behaviour(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self._save(_ints(user_input))
        return self.async_show_form(step_id="behaviour", data_schema=_behaviour_schema(self._options))

    async def async_step_hyperion(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            values = _ints(user_input)
            values[CONF_HYPERION_HOST] = str(values.get(CONF_HYPERION_HOST, "")).strip()
            if values[CONF_HYPERION_ENABLED] and not values[CONF_HYPERION_HOST]:
                errors[CONF_HYPERION_HOST] = "host_required"
            else:
                return self._save(values)
        return self.async_show_form(step_id="hyperion", data_schema=_hyperion_schema({**self._options, **(user_input or {})}), errors=errors)

    def _save(self, changes: dict[str, Any]) -> ConfigFlowResult:
        return self.async_create_entry(data={**self.config_entry.options, **changes})
