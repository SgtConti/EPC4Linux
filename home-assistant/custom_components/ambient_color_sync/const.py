"""Constants of the Ambient Color Sync integration."""

from __future__ import annotations

from typing import Final

DOMAIN: Final = "ambient_color_sync"

CONF_WEBHOOK_ID: Final = "webhook_id"
CONF_LIGHTS: Final = "lights"
CONF_ZONES: Final = "zones"
CONF_BRIGHTNESS_MODE: Final = "brightness_mode"
CONF_MIN_BRIGHTNESS: Final = "min_brightness"
CONF_MAX_BRIGHTNESS: Final = "max_brightness"
CONF_FIXED_BRIGHTNESS: Final = "fixed_brightness"
CONF_SATURATION_BOOST: Final = "saturation_boost"
CONF_DARK_THRESHOLD: Final = "dark_threshold"
CONF_DARK_ACTION: Final = "dark_action"
CONF_MIN_INTERVAL: Final = "min_interval"
CONF_CHANGE_THRESHOLD: Final = "change_threshold"
CONF_TRANSITION: Final = "transition"
CONF_END_ACTION: Final = "end_action"
CONF_INACTIVE_TIMEOUT: Final = "inactive_timeout"
CONF_ON_OFF: Final = "on_off"
CONF_SENSOR_INTERVAL: Final = "sensor_interval"
CONF_HYPERION_ENABLED: Final = "hyperion_enabled"
CONF_HYPERION_HOST: Final = "hyperion_host"
CONF_HYPERION_PORT: Final = "hyperion_port"
CONF_HYPERION_TOKEN: Final = "hyperion_token"
CONF_HYPERION_POLL: Final = "hyperion_poll"

ZONES: Final = ("all", "left", "right", "top", "bottom")
BRIGHTNESS_MODES: Final = ("follow", "fixed")
DARK_ACTIONS: Final = ("dim", "off", "hold")
END_ACTIONS: Final = ("restore", "off", "leave")
# "control": the sync turns lights on (with a colour) and off (black screen, end of stream) itself.
# "respect": only lights that are on follow; a light switched off elsewhere stays off and follows again once on.
ON_OFF_MODES: Final = ("control", "respect")

DEFAULTS: Final[dict] = {
    CONF_LIGHTS: [],
    CONF_ZONES: {},
    CONF_BRIGHTNESS_MODE: "follow",
    CONF_MIN_BRIGHTNESS: 10,
    CONF_MAX_BRIGHTNESS: 100,
    CONF_FIXED_BRIGHTNESS: 80,
    CONF_SATURATION_BOOST: 25,
    CONF_DARK_THRESHOLD: 4,
    CONF_DARK_ACTION: "dim",
    CONF_MIN_INTERVAL: 500,
    CONF_CHANGE_THRESHOLD: 3,
    CONF_TRANSITION: 0.4,
    CONF_END_ACTION: "restore",
    CONF_INACTIVE_TIMEOUT: 15,
    CONF_ON_OFF: "control",
    CONF_SENSOR_INTERVAL: 2.0,
    CONF_HYPERION_ENABLED: False,
    CONF_HYPERION_HOST: "",
    CONF_HYPERION_PORT: 19444,
    CONF_HYPERION_TOKEN: "",
    CONF_HYPERION_POLL: 1000,
}

# How often the watchdog looks for a source that went silent.
WATCHDOG_INTERVAL: Final = 5.0
# A light command that has not finished after this long no longer holds back that light's next one.
COMMAND_TIMEOUT: Final = 10.0

SIGNAL_UPDATE: Final = f"{DOMAIN}_update_{{}}"
