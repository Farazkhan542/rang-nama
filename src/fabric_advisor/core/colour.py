"""Colour-space maths for the verdict engine.

Deliberately dependency-free and written in plain Python. Two reasons:

1. This module is the *hot path*. It runs for every product the user looks at,
   so it must cost nothing and finish instantly. No model call, no numpy import.
2. It gets ported to TypeScript to run client-side inside the browser
   extension. Keeping it to plain arithmetic makes that port mechanical.

Everything here is deterministic and unit-testable, which is the whole point:
the verdict is arithmetic, the diffusion model is only ever illustration.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

# CIE standard illuminant D65, 2-degree observer.
_D65 = (0.95047, 1.00000, 1.08883)

# CIE standard constants. Expressed as exact rationals rather than the
# rounded 0.008856 / 903.3 that older references use.
_EPSILON = 216.0 / 24389.0
_KAPPA = 24389.0 / 27.0


@dataclass(frozen=True)
class Lab:
    """A colour in CIELAB. L in [0, 100], a and b roughly [-128, 127]."""

    L: float
    a: float
    b: float

    @property
    def chroma(self) -> float:
        """Distance from the neutral axis. High chroma reads as 'saturated'."""
        return math.hypot(self.a, self.b)

    @property
    def hue_degrees(self) -> float:
        """Hue angle in degrees, [0, 360)."""
        return math.degrees(math.atan2(self.b, self.a)) % 360.0


def hex_to_rgb(value: str) -> tuple[int, int, int]:
    """Parse ``#rrggbb`` (or ``rrggbb``) into 8-bit channels."""
    text = value.strip().lstrip("#")
    if len(text) == 3:  # shorthand #abc
        text = "".join(ch * 2 for ch in text)
    if len(text) != 6:
        raise ValueError(f"not a hex colour: {value!r}")
    return int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16)


def rgb_to_hex(rgb: tuple[int, int, int]) -> str:
    r, g, b = (max(0, min(255, int(round(c)))) for c in rgb)
    return f"#{r:02x}{g:02x}{b:02x}"


def _srgb_to_linear(channel: float) -> float:
    """Undo the sRGB transfer function. ``channel`` is in [0, 1]."""
    if channel <= 0.04045:
        return channel / 12.92
    return ((channel + 0.055) / 1.055) ** 2.4


def rgb_to_lab(rgb: tuple[int, int, int]) -> Lab:
    """Convert 8-bit sRGB to CIELAB under D65.

    Going through linear light matters. Averaging or comparing colours in
    gamma-encoded sRGB is the single most common bug in "extract the dominant
    colour" code, and it skews results toward the dark end.
    """
    r, g, b = (_srgb_to_linear(c / 255.0) for c in rgb)

    # Linear sRGB -> XYZ (D65), sRGB primaries.
    x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b
    y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b
    z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b

    def f(t: float) -> float:
        return t ** (1.0 / 3.0) if t > _EPSILON else (_KAPPA * t + 16.0) / 116.0

    fx, fy, fz = f(x / _D65[0]), f(y / _D65[1]), f(z / _D65[2])
    return Lab(L=116.0 * fy - 16.0, a=500.0 * (fx - fy), b=200.0 * (fy - fz))


def hex_to_lab(value: str) -> Lab:
    return rgb_to_lab(hex_to_rgb(value))


def delta_e_2000(c1: Lab, c2: Lab, kl: float = 1.0, kc: float = 1.0, kh: float = 1.0) -> float:
    """CIEDE2000 colour difference.

    We use CIEDE2000 rather than the far simpler CIE76 Euclidean distance
    because CIE76 badly misjudges exactly the region we care about: saturated
    blues and near-neutral skin tones. Getting "does this colour suit you"
    right depends on perceptual accuracy in the low-chroma range, and CIE76
    is not accurate there.

    Rule of thumb for the result: <1 is imperceptible, 1-2 needs a trained
    eye, 2-10 is an obvious difference, >10 reads as a different colour.
    """
    # Step 1: chroma of each, and the mean used to weight the a* correction.
    c1_chroma = math.hypot(c1.a, c1.b)
    c2_chroma = math.hypot(c2.a, c2.b)
    mean_chroma = (c1_chroma + c2_chroma) / 2.0

    # G stretches a* for low-chroma colours, which is what fixes CIE76's
    # poor behaviour near the neutral axis.
    mean_c7 = mean_chroma**7
    g = 0.5 * (1.0 - math.sqrt(mean_c7 / (mean_c7 + 25.0**7))) if mean_chroma > 0 else 0.0

    a1p = (1.0 + g) * c1.a
    a2p = (1.0 + g) * c2.a

    c1p = math.hypot(a1p, c1.b)
    c2p = math.hypot(a2p, c2.b)

    h1p = 0.0 if c1p == 0 else math.degrees(math.atan2(c1.b, a1p)) % 360.0
    h2p = 0.0 if c2p == 0 else math.degrees(math.atan2(c2.b, a2p)) % 360.0

    delta_l = c2.L - c1.L
    delta_c = c2p - c1p

    # Hue difference, taking the short way round the colour wheel.
    if c1p * c2p == 0:
        delta_h_deg = 0.0
    else:
        diff = h2p - h1p
        if diff > 180.0:
            diff -= 360.0
        elif diff < -180.0:
            diff += 360.0
        delta_h_deg = diff
    delta_h = 2.0 * math.sqrt(c1p * c2p) * math.sin(math.radians(delta_h_deg) / 2.0)

    mean_l = (c1.L + c2.L) / 2.0
    mean_cp = (c1p + c2p) / 2.0

    # Mean hue, again handling the wrap-around.
    if c1p * c2p == 0:
        mean_hp = h1p + h2p
    elif abs(h1p - h2p) <= 180.0:
        mean_hp = (h1p + h2p) / 2.0
    elif h1p + h2p < 360.0:
        mean_hp = (h1p + h2p + 360.0) / 2.0
    else:
        mean_hp = (h1p + h2p - 360.0) / 2.0

    t = (
        1.0
        - 0.17 * math.cos(math.radians(mean_hp - 30.0))
        + 0.24 * math.cos(math.radians(2.0 * mean_hp))
        + 0.32 * math.cos(math.radians(3.0 * mean_hp + 6.0))
        - 0.20 * math.cos(math.radians(4.0 * mean_hp - 63.0))
    )

    delta_theta = 30.0 * math.exp(-(((mean_hp - 275.0) / 25.0) ** 2))
    mean_cp7 = mean_cp**7
    rc = 2.0 * math.sqrt(mean_cp7 / (mean_cp7 + 25.0**7)) if mean_cp > 0 else 0.0

    sl = 1.0 + (0.015 * (mean_l - 50.0) ** 2) / math.sqrt(20.0 + (mean_l - 50.0) ** 2)
    sc = 1.0 + 0.045 * mean_cp
    sh = 1.0 + 0.015 * mean_cp * t
    rt = -math.sin(math.radians(2.0 * delta_theta)) * rc

    term_l = delta_l / (kl * sl)
    term_c = delta_c / (kc * sc)
    term_h = delta_h / (kh * sh)

    return math.sqrt(term_l**2 + term_c**2 + term_h**2 + rt * term_c * term_h)


def relative_luminance(rgb: tuple[int, int, int]) -> float:
    """WCAG relative luminance in [0, 1]. Used for value-contrast maths."""
    r, g, b = (_srgb_to_linear(c / 255.0) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(rgb1: tuple[int, int, int], rgb2: tuple[int, int, int]) -> float:
    """WCAG contrast ratio, in [1, 21]."""
    l1, l2 = relative_luminance(rgb1), relative_luminance(rgb2)
    lighter, darker = max(l1, l2), min(l1, l2)
    return (lighter + 0.05) / (darker + 0.05)
