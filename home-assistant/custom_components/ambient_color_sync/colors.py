"""Screen colour → light command, without Home Assistant imports (unit-tested on its own)."""

from __future__ import annotations

import colorsys
from dataclasses import dataclass
from typing import Any

Rgb = tuple[int, int, int]


@dataclass(frozen=True)
class Target:
    """What one light should show: off, or a colour (hue 0-360, saturation 0-100) at a brightness in percent."""

    off: bool = False
    hue: float = 0.0
    saturation: float = 0.0
    brightness_pct: int = 100


def rgb_to_hsv(rgb: Rgb) -> tuple[float, float, float]:
    """RGB 0-255 → hue 0-360, saturation 0-100, value 0-100."""
    h, s, v = colorsys.rgb_to_hsv(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255)
    return h * 360, s * 100, v * 100


def parse_rgb(value: Any) -> Rgb | None:
    """[r, g, b] (numbers, clamped to 0-255) of a colour list; a longer list (several LEDs) is averaged; else None."""
    if not isinstance(value, (list, tuple)) or len(value) < 3:
        return None
    if not all(isinstance(c, (int, float)) and not isinstance(c, bool) for c in value):
        return None
    triples = [value[i : i + 3] for i in range(0, len(value) - 2, 3)]
    n = len(triples)
    return tuple(max(0, min(255, round(sum(t[c] for t in triples) / n))) for c in range(3))  # type: ignore[return-value]


def target_for(rgb: Rgb, opts: dict[str, Any]) -> Target | None:
    """The light command for a screen colour, or None to keep the last colour (a black screen with "hold")."""
    hue, sat, val = rgb_to_hsv(rgb)
    fixed = opts["brightness_mode"] == "fixed"
    lo = int(opts["min_brightness"])
    hi = max(lo, int(opts["max_brightness"]))
    if val < float(opts["dark_threshold"]):
        action = opts["dark_action"]
        if action == "off":
            return Target(off=True)
        if action == "hold":
            return None
        return Target(hue=round(hue), saturation=0, brightness_pct=int(opts["fixed_brightness"]) if fixed else lo)
    sat = min(100.0, sat * (1 + float(opts["saturation_boost"]) / 100))
    level = int(opts["fixed_brightness"]) if fixed else round(lo + (hi - lo) * val / 100)
    return Target(hue=round(hue), saturation=round(sat), brightness_pct=max(1, min(100, level)))


def changed(a: Target | None, b: Target, threshold: float) -> bool:
    """Whether a light showing `a` should get `b`: hue (in 1/100 turns), saturation or brightness moved by `threshold`."""
    if a is None or a.off != b.off:
        return True
    if b.off:
        return False
    if threshold <= 0:
        return a != b
    dh = abs(a.hue - b.hue) / 3.6
    dh = min(dh, 100 - dh)  # hue wraps around
    hue_counts = max(a.saturation, b.saturation) >= 10  # hue hardly matters for nearly white colours
    return (
        (hue_counts and dh >= threshold)
        or abs(a.saturation - b.saturation) >= threshold
        or abs(a.brightness_pct - b.brightness_pct) >= threshold
    )


def zones_from_payload(data: dict[str, Any]) -> dict[str, Rgb] | None:
    """The zones of an EPC4Linux document ({"color": [...], "zones": {...}}), or None without a colour."""
    color = parse_rgb(data.get("color"))
    if color is None:
        return None
    zones: dict[str, Rgb] = {"all": color}
    raw = data.get("zones")
    if isinstance(raw, dict):
        for name in ("left", "right", "top", "bottom"):
            c = parse_rgb(raw.get(name))
            if c is not None:
                zones[name] = c
    return zones


def hyperion_layout(leds: Any) -> dict[str, list[int]] | None:
    """LED indices per zone from Hyperion's serverinfo layout ({hmin, hmax, vmin, vmax} per LED, 0-1)."""
    if not isinstance(leds, list):
        return None
    zones: dict[str, list[int]] = {"left": [], "right": [], "top": [], "bottom": []}
    for i, led in enumerate(leds):
        if not isinstance(led, dict):
            continue
        x = (float(led.get("hmin", 0)) + float(led.get("hmax", 0))) / 2
        y = (float(led.get("vmin", 0)) + float(led.get("vmax", 0))) / 2
        if x < 0.2:
            zones["left"].append(i)
        if x > 0.8:
            zones["right"].append(i)
        if y < 0.2:
            zones["top"].append(i)
        if y > 0.8:
            zones["bottom"].append(i)
    return zones


def hyperion_zones(leds: Any, layout: dict[str, list[int]] | None) -> dict[str, Rgb] | None:
    """Zone averages of Hyperion's LED colours (flat [r,g,b,r,g,b,...] or a list of [r,g,b])."""
    if not isinstance(leds, list) or not leds:
        return None
    colors: list[Rgb] = []
    if isinstance(leds[0], (list, tuple)):
        colors = [c for c in (parse_rgb(x) for x in leds) if c is not None]
    else:
        colors = [c for c in (parse_rgb(leds[i : i + 3]) for i in range(0, len(leds) - 2, 3)) if c is not None]
    if not colors:
        return None

    def average(idx: list[int] | None) -> Rgb | None:
        picked = [colors[i] for i in (idx if idx is not None else range(len(colors))) if i < len(colors)]
        if not picked:
            return None
        return tuple(round(sum(c[k] for c in picked) / len(picked)) for k in range(3))  # type: ignore[return-value]

    zones: dict[str, Rgb] = {"all": average(None)}  # type: ignore[dict-item]
    for name, idx in (layout or {}).items():
        c = average(idx)
        if c is not None:
            zones[name] = c
    return zones


def to_hex(rgb: Rgb) -> str:
    return "#{:02X}{:02X}{:02X}".format(*rgb)
