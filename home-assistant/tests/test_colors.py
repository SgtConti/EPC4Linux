"""The pure colour logic (custom_components/ambient_color_sync/colors.py)."""

from custom_components.ambient_color_sync.colors import (
    Target,
    changed,
    hyperion_layout,
    hyperion_zones,
    parse_rgb,
    target_for,
    zones_from_payload,
)
from custom_components.ambient_color_sync.const import DEFAULTS

OPTS = {**DEFAULTS, "saturation_boost": 0}


def test_parse_rgb():
    assert parse_rgb([1, 2, 3]) == (1, 2, 3)
    assert parse_rgb([300, -5, 2.6]) == (255, 0, 3)
    assert parse_rgb([255, 0, 0, 0, 0, 255]) == (128, 0, 128)
    assert parse_rgb([1, 2]) is None
    assert parse_rgb(["1", 2, 3]) is None
    assert parse_rgb([True, 2, 3]) is None
    assert parse_rgb("red") is None


def test_zones_from_payload():
    doc = {"color": [96, 72, 40], "zones": {"left": [180, 40, 20], "right": "x", "top": [1, 2, 3]}}
    assert zones_from_payload(doc) == {"all": (96, 72, 40), "left": (180, 40, 20), "top": (1, 2, 3)}
    assert zones_from_payload({"zones": {}}) is None


def test_target_follow_and_fixed():
    assert target_for((0, 0, 255), OPTS) == Target(hue=240, saturation=100, brightness_pct=100)
    half = target_for((128, 0, 0), OPTS)
    assert (half.hue, half.saturation, half.brightness_pct) == (0, 100, 55)
    assert target_for((128, 0, 0), {**OPTS, "brightness_mode": "fixed", "fixed_brightness": 30}).brightness_pct == 30
    boosted = target_for((200, 100, 100), {**OPTS, "saturation_boost": 50})
    assert boosted.saturation == 75


def test_target_black_screen():
    assert target_for((0, 0, 0), OPTS) == Target(hue=0, saturation=0, brightness_pct=10)
    assert target_for((0, 0, 0), {**OPTS, "dark_action": "off"}) == Target(off=True)
    assert target_for((0, 0, 0), {**OPTS, "dark_action": "hold"}) is None


def test_changed():
    a = Target(hue=10, saturation=80, brightness_pct=50)
    assert changed(None, a, 3)
    assert not changed(a, Target(hue=15, saturation=81, brightness_pct=51), 3)
    assert changed(a, Target(hue=30, saturation=80, brightness_pct=50), 3)
    assert not changed(Target(hue=358, saturation=80), Target(hue=2, saturation=80), 3), "hue wraps around"
    assert not changed(Target(hue=0, saturation=5), Target(hue=180, saturation=5), 3), "hue ignored for near white"
    assert changed(a, Target(off=True), 3)
    assert not changed(Target(off=True), Target(off=True), 3)
    assert changed(a, Target(hue=11, saturation=80, brightness_pct=50), 0)


def test_hyperion_zones():
    layout = hyperion_layout([
        {"hmin": 0, "hmax": 0.1, "vmin": 0.4, "vmax": 0.5},
        {"hmin": 0.9, "hmax": 1, "vmin": 0.4, "vmax": 0.5},
        {"hmin": 0.45, "hmax": 0.55, "vmin": 0, "vmax": 0.1},
    ])
    assert layout == {"left": [0], "right": [1], "top": [2], "bottom": []}
    zones = hyperion_zones([255, 0, 0, 0, 0, 255, 0, 255, 0], layout)
    assert zones == {"all": (85, 85, 85), "left": (255, 0, 0), "right": (0, 0, 255), "top": (0, 255, 0)}
    assert hyperion_zones([[10, 20, 30]], None) == {"all": (10, 20, 30)}
    assert hyperion_zones([], None) is None
