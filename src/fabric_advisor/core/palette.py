"""Seasonal colour palettes and undertone classification.

## An honest caveat about this system

Twelve-season colour analysis was developed and calibrated largely on European
colouring. Applied unmodified to South Asian skin it fails in a specific,
predictable way: most Pakistani colouring lands in a narrow band of "Deep
Autumn / Deep Winter", which is technically defensible and practically useless,
because a system that gives 80% of your users the same answer is not advice.

Two adjustments here, both deliberate:

1. **The value axis is re-centred.** The light/deep split is computed against a
   deeper reference L*, so depth discriminates *within* the range this market
   actually occupies rather than flattening it against a European mid-point.

2. **Olive is treated as its own undertone**, not as "warm with low chroma".
   Olive skin has a genuine green-yellow cast (positive b*, restrained a*) that
   the classic warm/cool binary has no slot for, and it is common here. Olive
   colouring is poorly served by the warm palettes it usually gets assigned.

This is a documented approximation, not ground truth. It is exactly the sort of
thing the blind-panel eval exists to check.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum

from .colour import Lab, delta_e_2000, hex_to_lab


class Undertone(str, Enum):
    COOL = "cool"
    WARM = "warm"
    NEUTRAL = "neutral"
    OLIVE = "olive"


class Depth(str, Enum):
    LIGHT = "light"
    MEDIUM = "medium"
    DEEP = "deep"


class Contrast(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


@dataclass(frozen=True)
class Season:
    """One seasonal palette.

    ``swatches`` are representative, not exhaustive. They are sampled to span
    the season's hue range rather than to enumerate every wearable colour, so
    nearest-swatch distance behaves as a smooth score.
    """

    name: str
    undertone: Undertone
    depth: Depth
    description: str
    swatches: tuple[str, ...]

    def lab_swatches(self) -> list[Lab]:
        return [hex_to_lab(s) for s in self.swatches]


# Twelve seasons. Swatches are chosen to sit inside each season's
# temperature/value/chroma envelope.
SEASONS: dict[str, Season] = {
    "bright_spring": Season(
        name="Bright Spring",
        undertone=Undertone.WARM,
        depth=Depth.LIGHT,
        description="Clear, warm and high-chroma. Colour reads as lit from within.",
        swatches=(
            "#ff6f3c", "#ffb100", "#f7e733", "#3fd06a", "#00b8a9",
            "#22a7f0", "#ff4f81", "#ff8c42", "#c9e265", "#00d1c1",
        ),
    ),
    "true_spring": Season(
        name="True Spring",
        undertone=Undertone.WARM,
        depth=Depth.LIGHT,
        description="Warm and fresh, golden rather than fiery.",
        swatches=(
            "#f4a259", "#f6bd60", "#e9c46a", "#8ab17d", "#43aa8b",
            "#4cc9c0", "#ef8354", "#f79d65", "#bfd7b3", "#7fc8a9",
        ),
    ),
    "light_spring": Season(
        name="Light Spring",
        undertone=Undertone.WARM,
        depth=Depth.LIGHT,
        description="Warm but delicate. Tints rather than saturated hues.",
        swatches=(
            "#ffd6a5", "#fdffb6", "#caffbf", "#9bf6ff", "#ffc6ff",
            "#ffadad", "#f7d6b4", "#d0f4de", "#a9def9", "#fcf6bd",
        ),
    ),
    "light_summer": Season(
        name="Light Summer",
        undertone=Undertone.COOL,
        depth=Depth.LIGHT,
        description="Cool and soft, powdery. Blue-based pastels.",
        swatches=(
            "#a8d8ea", "#aa96da", "#c5fad5", "#ffcbcb", "#b8b5ff",
            "#d3e0ea", "#c7ceea", "#e2d5f0", "#a2d5f2", "#f6dfeb",
        ),
    ),
    "true_summer": Season(
        name="True Summer",
        undertone=Undertone.COOL,
        depth=Depth.MEDIUM,
        description="Cool and muted, dusty. Blue and rose dominate.",
        swatches=(
            "#6d8fa8", "#8e9aaf", "#a8869b", "#5c7a89", "#9a8c98",
            "#7b8fa1", "#b0a1ba", "#4f6d7a", "#c08497", "#88a0a8",
        ),
    ),
    "soft_summer": Season(
        name="Soft Summer",
        undertone=Undertone.NEUTRAL,
        depth=Depth.MEDIUM,
        description="Greyed and cool-leaning. Nothing shouts.",
        swatches=(
            "#8d99ae", "#a3a3a3", "#7d8491", "#9c89b8", "#6b705c",
            "#a5a58d", "#b7b7a4", "#7f7f7f", "#8e8d8a", "#95a5a6",
        ),
    ),
    "soft_autumn": Season(
        name="Soft Autumn",
        undertone=Undertone.OLIVE,
        depth=Depth.MEDIUM,
        description="Muted and warm-leaning. Earth tones with the volume down.",
        swatches=(
            "#a68a64", "#936639", "#7f7f5a", "#a4ac86", "#b6ad90",
            "#c2c5aa", "#997b66", "#8a817c", "#bfa58a", "#8f8073",
        ),
    ),
    "true_autumn": Season(
        name="True Autumn",
        undertone=Undertone.WARM,
        depth=Depth.MEDIUM,
        description="Warm, rich and earthy. Spice-box colouring.",
        swatches=(
            "#bc6c25", "#dda15e", "#606c38", "#283618", "#a53860",
            "#9c6644", "#7f4f24", "#b08968", "#656d4a", "#c1121f",
        ),
    ),
    "deep_autumn": Season(
        name="Deep Autumn",
        undertone=Undertone.WARM,
        depth=Depth.DEEP,
        description="Warm and dark. Depth carries the palette, not brightness.",
        swatches=(
            "#5f0f40", "#9a031e", "#bb3e03", "#ae2012", "#6a4c93",
            "#3a5a40", "#344e41", "#7f5539", "#582f0e", "#8c2f39",
        ),
    ),
    "deep_winter": Season(
        name="Deep Winter",
        undertone=Undertone.COOL,
        depth=Depth.DEEP,
        description="Cool and dark, jewel-toned. Clear rather than dusty.",
        swatches=(
            "#03045e", "#023e8a", "#3c096c", "#5a189a", "#006466",
            "#004b23", "#6a040f", "#370617", "#1b263b", "#2b2d42",
        ),
    ),
    "true_winter": Season(
        name="True Winter",
        undertone=Undertone.COOL,
        depth=Depth.DEEP,
        description="Cool, saturated and high-contrast. Icy or vivid, never muted.",
        swatches=(
            "#0077b6", "#d00000", "#7209b7", "#000000", "#ffffff",
            "#0466c8", "#c1121f", "#5f0f40", "#006d77", "#14213d",
        ),
    ),
    "bright_winter": Season(
        name="Bright Winter",
        undertone=Undertone.COOL,
        depth=Depth.MEDIUM,
        description="Cool and electric. Maximum clarity and contrast.",
        swatches=(
            "#0aefff", "#ff006e", "#8338ec", "#3a86ff", "#fb5607",
            "#00f5d4", "#f20089", "#241023", "#ffffff", "#04052e",
        ),
    ),
}


# --- Skin classification ---------------------------------------------------
# Depth uses the Individual Typology Angle (ITA), the standard metric in
# dermatology and cosmetic science:
#
#     ITA = atan2(L* - 50, b*) in degrees
#
# ITA is used rather than raw L* for a concrete reason: L* alone confuses
# "light" with "low-pigment-but-yellow". ITA folds in b*, which is what actually
# tracks melanin, so it separates a light-but-golden tone from a genuinely fair
# one. Published ITA bands (Chardon et al., and the Fitzpatrick correlations
# that followed) are:
#
#     very light > 55 | light 41..55 | intermediate 28..41
#     tan 10..28      | brown -30..10 | dark < -30
#
# Those six bands collapse to three here. The cut points are placed at 41 and 10
# so that "medium" spans intermediate+tan, which is where the bulk of this
# market sits - the aim is to discriminate *within* that range, not to flatten
# it against a European mid-point.
_ITA_LIGHT_MIN = 41.0
_ITA_DEEP_MAX = 10.0

# Undertone uses the CIELAB hue angle, h = atan2(b*, a*). Ratio tests on b*/a*
# do not work: essentially all human skin sits between about 1.5 and 3.0 on that
# ratio, so a ratio threshold makes "cool" unreachable and lands almost everyone
# in the same season. Hue angle spreads the same data across a usable range.
#
#   < 48 deg   red-dominant      -> cool
#   48..57     balanced          -> neutral
#   > 57       yellow-dominant   -> warm
#
# Olive is a genuine yellow-green cast: a high hue angle held at *low chroma*.
# It is checked first because a plain hue test reads it as strongly warm.
_HUE_COOL_MAX = 48.0
_HUE_WARM_MIN = 57.0
_OLIVE_HUE_MIN = 68.0
_OLIVE_CHROMA_MAX = 28.0

# Contrast is the L* spread between hair and skin.
_CONTRAST_HIGH_MIN = 38.0
_CONTRAST_LOW_MAX = 18.0


def individual_typology_angle(skin: Lab) -> float:
    """ITA in degrees. Higher is lighter; see the band table above."""
    if skin.b == 0.0:
        return 90.0 if skin.L > 50.0 else -90.0
    return math.degrees(math.atan2(skin.L - 50.0, skin.b))


def classify_depth(skin: Lab) -> Depth:
    """Depth band from ITA rather than raw lightness."""
    ita = individual_typology_angle(skin)
    if ita >= _ITA_LIGHT_MIN:
        return Depth.LIGHT
    if ita <= _ITA_DEEP_MAX:
        return Depth.DEEP
    return Depth.MEDIUM


def classify_undertone(skin: Lab) -> Undertone:
    """Undertone from the CIELAB hue angle of skin.

    Caveat worth stating plainly: separating olive from neutral-warm on a single
    sRGB swatch is somewhat ill-posed. The two occupy overlapping regions and
    are distinguished in person by how skin behaves against draped fabric, not
    by a point sample. The threshold below is deliberately conservative - it
    only calls olive on a clear yellow-green signal, and otherwise falls through
    to warm or neutral.
    """
    if skin.a <= 0.0:
        # Outside the plausible range for skin. Return neutral rather than
        # producing a confident wrong answer from a degenerate hue angle.
        return Undertone.NEUTRAL

    hue = skin.hue_degrees
    chroma = skin.chroma

    if hue >= _OLIVE_HUE_MIN and chroma <= _OLIVE_CHROMA_MAX:
        return Undertone.OLIVE
    if hue >= _HUE_WARM_MIN:
        return Undertone.WARM
    if hue <= _HUE_COOL_MAX:
        return Undertone.COOL
    return Undertone.NEUTRAL


def classify_contrast(skin: Lab, hair: Lab) -> Contrast:
    """Value contrast between hair and skin.

    Contrast, not hue, is what most often decides whether an outfit works. It is
    also the axis people get wrong about themselves most often.
    """
    spread = abs(skin.L - hair.L)
    if spread >= _CONTRAST_HIGH_MIN:
        return Contrast.HIGH
    if spread <= _CONTRAST_LOW_MAX:
        return Contrast.LOW
    return Contrast.MEDIUM


def select_season(undertone: Undertone, depth: Depth, contrast: Contrast) -> Season:
    """Map the three axes onto a season.

    A lookup rather than a nearest-neighbour fit: the axes are ordinal and the
    mapping is small enough to be read, argued with, and corrected by a stylist.
    That auditability is worth more here than a marginally better fit.
    """
    if undertone is Undertone.OLIVE:
        # Olive maps to the muted-warm family; depth picks the rung.
        if depth is Depth.DEEP:
            return SEASONS["deep_autumn"]
        if depth is Depth.LIGHT:
            return SEASONS["soft_autumn"]
        return SEASONS["soft_autumn" if contrast is not Contrast.HIGH else "true_autumn"]

    if undertone is Undertone.WARM:
        if depth is Depth.DEEP:
            return SEASONS["deep_autumn"]
        if depth is Depth.LIGHT:
            return SEASONS["bright_spring" if contrast is Contrast.HIGH else "light_spring"]
        return SEASONS["true_autumn" if contrast is not Contrast.LOW else "soft_autumn"]

    if undertone is Undertone.COOL:
        if depth is Depth.DEEP:
            return SEASONS["true_winter" if contrast is Contrast.HIGH else "deep_winter"]
        if depth is Depth.LIGHT:
            return SEASONS["light_summer"]
        return SEASONS["bright_winter" if contrast is Contrast.HIGH else "true_summer"]

    # Neutral
    if depth is Depth.DEEP:
        return SEASONS["deep_winter" if contrast is Contrast.HIGH else "deep_autumn"]
    if depth is Depth.LIGHT:
        return SEASONS["light_summer" if contrast is Contrast.LOW else "light_spring"]
    return SEASONS["soft_summer" if contrast is not Contrast.HIGH else "bright_winter"]


def nearest_swatch_distance(garment: Lab, season: Season) -> tuple[float, str]:
    """Smallest CIEDE2000 distance from a garment colour to the season palette.

    Returns the distance and the hex of the closest swatch, so the verdict can
    say *which* palette colour it is near - "close to your rust" is advice,
    a bare number is not.
    """
    best_distance = float("inf")
    best_hex = season.swatches[0]
    for swatch_hex, swatch_lab in zip(season.swatches, season.lab_swatches(), strict=True):
        distance = delta_e_2000(garment, swatch_lab)
        if distance < best_distance:
            best_distance = distance
            best_hex = swatch_hex
    return best_distance, best_hex
