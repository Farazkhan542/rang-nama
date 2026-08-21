"""The verdict engine.

This is the product. It answers the only two questions that are still open once
a tailor is doing the fitting:

  1. Does this colour suit me?
  2. Is this print the right scale for my frame?

Everything here is arithmetic. No model call, no diffusion, no network. That is
a deliberate architectural choice, not a limitation:

* **It is free.** This runs on every product the user looks at. Anything with a
  per-call cost could not.
* **It is instant.** No spinner, no "generating...".
* **It is explainable.** Every score decomposes into a stated reason, which is
  what earns trust. An unexplained score is the untrusted novelty that has kept
  virtual try-on at 15-25% adoption.
* **It is testable.** Deterministic in, deterministic out.

The generated image, when there is one, illustrates this verdict. It never
produces it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import Enum

from .colour import Lab, hex_to_lab
from .palette import (
    Contrast,
    Season,
    classify_contrast,
    classify_depth,
    classify_undertone,
    nearest_swatch_distance,
    select_season,
)


class Band(str, Enum):
    """Human-facing verdict bands, in descending order of goodness."""

    EXCELLENT = "excellent"
    GOOD = "good"
    NEUTRAL = "neutral"
    POOR = "poor"


class Build(str, Enum):
    PETITE = "petite"
    AVERAGE = "average"
    TALL = "tall"


@dataclass(frozen=True)
class UserProfile:
    """Everything the verdict needs about a person.

    Note what is absent: no photo, no body measurements, no size. The photo-free
    path is the default, and for unstitched fabric the tailor owns fit.
    """

    skin: Lab
    hair: Lab
    height_cm: float
    eye: Lab | None = None

    @classmethod
    def from_hex(
        cls,
        skin: str,
        hair: str,
        height_cm: float,
        eye: str | None = None,
    ) -> UserProfile:
        return cls(
            skin=hex_to_lab(skin),
            hair=hex_to_lab(hair),
            height_cm=height_cm,
            eye=hex_to_lab(eye) if eye else None,
        )

    @property
    def build(self) -> Build:
        # Bands chosen against Pakistani women's height distribution rather than
        # a global average, which sits several centimetres higher.
        if self.height_cm < 155.0:
            return Build.PETITE
        if self.height_cm > 168.0:
            return Build.TALL
        return Build.AVERAGE

    @property
    def season(self) -> Season:
        return select_season(
            classify_undertone(self.skin),
            classify_depth(self.skin),
            classify_contrast(self.skin, self.hair),
        )

    @property
    def contrast(self) -> Contrast:
        return classify_contrast(self.skin, self.hair)


@dataclass(frozen=True)
class ColourShare:
    """One dominant colour of a fabric and how much of it there is."""

    lab: Lab
    proportion: float  # 0..1, shares across a fabric sum to ~1


@dataclass(frozen=True)
class FabricProfile:
    """What Stage 1 extracts from a product photo, cached per SKU."""

    sku: str
    colours: tuple[ColourShare, ...]
    motif_scale_cm: float | None = None
    weave: str | None = None
    motif_type: str | None = None

    @property
    def value_spread(self) -> float:
        """L* range across dominant colours - the fabric's internal contrast.

        A fabric whose colours all sit at similar lightness reads as flat;
        one spanning a wide L* range reads as high-contrast. Matching this to
        the wearer's own contrast is what stops an outfit looking washed out
        or overwhelming.
        """
        if len(self.colours) < 2:
            return 0.0
        lightness = [c.lab.L for c in self.colours]
        return max(lightness) - min(lightness)


@dataclass(frozen=True)
class Score:
    """A single scored dimension with its reasoning."""

    name: str
    value: float  # 0..100
    band: Band
    reason: str


@dataclass(frozen=True)
class Verdict:
    headline: Band
    score: float
    scores: tuple[Score, ...]
    season_name: str
    notes: tuple[str, ...] = field(default_factory=tuple)

    def explain(self) -> str:
        lines = [f"{self.headline.value.upper()} ({self.score:.0f}/100) - {self.season_name}"]
        lines.extend(f"  - {s.reason}" for s in self.scores)
        lines.extend(f"  ! {n}" for n in self.notes)
        return "\n".join(lines)


# --- Calibration -----------------------------------------------------------
# These thresholds are the tunable surface of the engine. They are deliberately
# named constants rather than inline magic numbers, because the blind-panel
# eval exists to move them. Do not hand-tune them against a handful of examples.

# Nearest-swatch CIEDE2000 distance to the user's palette.
_DE_EXCELLENT = 12.0
_DE_GOOD = 22.0
_DE_NEUTRAL = 38.0

# Decay constant mapping distance to a 0-100 score.
_DE_TAU = 26.0

# Fabric value-spread bands, matched against the wearer's own contrast.
_SPREAD_LOW = 18.0
_SPREAD_HIGH = 42.0


def _band_from_distance(distance: float) -> Band:
    if distance <= _DE_EXCELLENT:
        return Band.EXCELLENT
    if distance <= _DE_GOOD:
        return Band.GOOD
    if distance <= _DE_NEUTRAL:
        return Band.NEUTRAL
    return Band.POOR


def _score_from_distance(distance: float) -> float:
    """Smooth 0-100 score from a perceptual distance.

    Exponential rather than linear so that the difference between "very close"
    and "close" matters more than between "far" and "very far" - past a point,
    wrong is just wrong.
    """
    return 100.0 * math.exp(-max(0.0, distance) / _DE_TAU)


def score_colour(fabric: FabricProfile, user: UserProfile) -> Score:
    """Proportion-weighted palette fit.

    Weighting by area matters: a fabric that is 80% clashing rust with a 5%
    flattering teal accent should not score well on the strength of the accent.
    """
    season = user.season
    if not fabric.colours:
        return Score("colour", 50.0, Band.NEUTRAL, "No colour data extracted for this fabric.")

    total_weight = sum(c.proportion for c in fabric.colours) or 1.0

    weighted_distance = 0.0
    dominant = max(fabric.colours, key=lambda c: c.proportion)
    dominant_distance, dominant_match = nearest_swatch_distance(dominant.lab, season)

    for share in fabric.colours:
        distance, _ = nearest_swatch_distance(share.lab, season)
        weighted_distance += distance * (share.proportion / total_weight)

    band = _band_from_distance(weighted_distance)
    value = _score_from_distance(weighted_distance)

    # Both the band and the wording must come from the same number. Quoting the
    # dominant colour's distance while banding on the area-weighted one produces
    # self-contradicting copy ("a long way from your palette (dE 12)").
    phrasing = {
        Band.EXCELLENT: "sits right inside",
        Band.GOOD: "sits close to",
        Band.NEUTRAL: "sits at the edge of",
        Band.POOR: "falls well outside",
    }[band]

    reason = (
        f"Across the whole print this {phrasing} your {season.name} palette "
        f"(weighted dE {weighted_distance:.0f}); the dominant colour's nearest "
        f"match is {dominant_match} at dE {dominant_distance:.0f}. "
        f"{season.description}"
    )
    return Score("colour", value, band, reason)


def score_contrast(fabric: FabricProfile, user: UserProfile) -> Score:
    """Match the fabric's internal contrast to the wearer's own.

    High-contrast people carry high-contrast prints; on low-contrast people the
    same print wears them. This is the axis people most often get wrong about
    themselves, which is why it is scored separately and stated out loud.
    """
    spread = fabric.value_spread
    user_contrast = user.contrast

    if spread >= _SPREAD_HIGH:
        fabric_level = Contrast.HIGH
    elif spread <= _SPREAD_LOW:
        fabric_level = Contrast.LOW
    else:
        fabric_level = Contrast.MEDIUM

    order = {Contrast.LOW: 0, Contrast.MEDIUM: 1, Contrast.HIGH: 2}
    gap = abs(order[fabric_level] - order[user_contrast])

    value, band = {0: (100.0, Band.EXCELLENT), 1: (68.0, Band.GOOD)}.get(
        gap, (34.0, Band.POOR)
    )

    if gap == 0:
        reason = (
            f"The print's {fabric_level.value} contrast matches your own "
            f"{user_contrast.value} colouring."
        )
    elif fabric_level == Contrast.HIGH and user_contrast == Contrast.LOW:
        reason = (
            "This print is much higher contrast than your colouring - it will "
            "tend to wear you rather than the other way round."
        )
    elif fabric_level == Contrast.LOW and user_contrast == Contrast.HIGH:
        reason = (
            "This print is flatter than your natural contrast, so it may read "
            "as washed out next to your colouring."
        )
    else:
        reason = (
            f"The print's {fabric_level.value} contrast is close enough to your "
            f"{user_contrast.value} colouring to work."
        )
    return Score("contrast", value, band, reason)


def score_print_scale(fabric: FabricProfile, user: UserProfile) -> Score:
    """Motif size against frame.

    Deliberately a small readable rule table rather than a learned model. There
    is no training data for this, the relationships are well understood by
    working stylists, and a table can be argued with and corrected. Learn it
    later, once outcome data exists.
    """
    if fabric.motif_scale_cm is None:
        return Score(
            "print_scale",
            50.0,
            Band.NEUTRAL,
            "Motif scale could not be measured, so scale is unscored.",
        )

    scale = fabric.motif_scale_cm
    build = user.build

    # Comfortable motif range per frame, in cm.
    windows: dict[Build, tuple[float, float]] = {
        Build.PETITE: (0.8, 7.0),
        Build.AVERAGE: (1.2, 11.0),
        Build.TALL: (1.8, 16.0),
    }
    low, high = windows[build]

    if low <= scale <= high:
        return Score(
            "print_scale",
            100.0,
            Band.EXCELLENT,
            f"A {scale:.1f} cm motif sits well on a {build.value} frame.",
        )

    if scale < low:
        # Overshoot below the window reads as visual noise.
        ratio = scale / low
        value = max(30.0, 100.0 * ratio)
        band = Band.GOOD if ratio > 0.7 else Band.NEUTRAL
        reason = (
            f"At {scale:.1f} cm the motif is small for a {build.value} frame and "
            "may read as texture rather than pattern from a distance."
        )
    else:
        ratio = high / scale
        value = max(25.0, 100.0 * ratio)
        band = Band.GOOD if ratio > 0.75 else Band.POOR
        reason = (
            f"At {scale:.1f} cm the motif is large for a {build.value} frame and "
            "will dominate the outfit."
        )
    return Score("print_scale", value, band, reason)


# Relative importance of each dimension in the headline. Colour dominates
# because it is the question users actually ask, and the one a tailor cannot fix.
_WEIGHTS = {"colour": 0.55, "contrast": 0.25, "print_scale": 0.20}


def build_verdict(fabric: FabricProfile, user: UserProfile) -> Verdict:
    """Combine the dimensions into one headline verdict."""
    scores = (
        score_colour(fabric, user),
        score_contrast(fabric, user),
        score_print_scale(fabric, user),
    )

    total = sum(s.value * _WEIGHTS[s.name] for s in scores)
    weight_sum = sum(_WEIGHTS[s.name] for s in scores)
    combined = total / weight_sum

    if combined >= 78.0:
        headline = Band.EXCELLENT
    elif combined >= 58.0:
        headline = Band.GOOD
    elif combined >= 40.0:
        headline = Band.NEUTRAL
    else:
        headline = Band.POOR

    notes: list[str] = []
    if fabric.motif_scale_cm is None:
        notes.append("Print scale unmeasured - verdict rests on colour and contrast only.")
    if len(fabric.colours) < 2:
        notes.append("Only one dominant colour found; contrast reading is weak.")

    return Verdict(
        headline=headline,
        score=combined,
        scores=scores,
        season_name=user.season.name,
        notes=tuple(notes),
    )
