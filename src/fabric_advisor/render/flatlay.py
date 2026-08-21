"""Stage 4a - synthesise a garment flat-lay from unstitched fabric.

## Why this exists

Try-on models transfer a *garment* onto a person. Unstitched fabric is a flat
bolt of printed cloth, so there is no garment to transfer and every off-the-shelf
model fails at the first step. This module manufactures the missing garment.

## Why compositing rather than diffusion

The print must survive exactly. A diffusion model redraws it, and redrawn
florals drift in motif scale and hue - which would silently invalidate the
CIEDE2000 numbers the verdict engine reports about that same fabric. Nothing
warns you when it happens; the output simply looks plausible and is wrong.

So the pipeline is the multiply-and-displace approach used for garment mockups
in the trade:

    tile the print -> warp it by a displacement map -> multiply a shading map
    -> mask to the garment silhouette

Displacement is what separates this from a flat sticker: it bends the print
around folds, so a stripe crossing a pleat bends the way real cloth bends.
Multiply is what keeps the print's own colour - it only removes light, where a
normal blend would wash grey paint over the top.

The result is deterministic, print-exact, CPU-only, needs no API key, and takes
about a second.

## Templates

A template is three aligned maps at the same size:

* ``mask``         - where the garment is (0..1)
* ``shading``      - how much light reaches each point (0..1, multiply)
* ``displacement`` - 2-channel pixel offsets encoding fold geometry

For production, derive these once from a single photograph of a plain
light-grey kurta: mask by segmentation, shading from the luminance channel
normalised against the flat area, displacement from the shading gradient. That
gives photographic drape for the cost of one photo.

``synthetic_template`` generates the same three maps procedurally so the
pipeline runs with no assets at all. It is visibly synthetic and is meant for
development and tests, not for output you show a shopper.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, map_coordinates

# Garment front width in centimetres by frame. Motif scale is meaningless
# without a real-world reference: a 14 cm block print is a third of the body on
# a petite frame and a quarter on a tall one, and the render must show that.
KURTA_WIDTH_CM = {"petite": 44.0, "average": 49.0, "tall": 54.0}


@dataclass(frozen=True)
class GarmentTemplate:
    """Aligned maps describing a garment's silhouette and drape."""

    mask: np.ndarray          # (H, W) float 0..1
    shading: np.ndarray       # (H, W) float, ~0.35..1.15
    displacement: np.ndarray  # (H, W, 2) float, pixel offsets (dy, dx)
    body_width_px: float      # width of the garment body, for scale conversion

    @property
    def size(self) -> tuple[int, int]:
        return self.mask.shape[1], self.mask.shape[0]


def _fractal_noise(shape: tuple[int, int], rng: np.random.Generator,
                   octaves: int = 4, persistence: float = 0.55,
                   anisotropy: float = 3.0) -> np.ndarray:
    """Smooth multi-octave noise, stretched vertically.

    Anisotropy matters: fabric folds run roughly with gravity, so noise that is
    isotropic reads as crumpled paper rather than hanging cloth.
    """
    h, w = shape
    out = np.zeros(shape, dtype=np.float64)
    amplitude = 1.0
    total = 0.0
    sigma = min(h, w) / 12.0

    for _ in range(octaves):
        layer = rng.standard_normal(shape)
        layer = gaussian_filter(layer, sigma=(sigma * anisotropy, sigma), mode="reflect")
        spread = layer.std()
        if spread > 1e-9:
            layer /= spread
        out += layer * amplitude
        total += amplitude
        amplitude *= persistence
        sigma /= 2.0

    return out / max(total, 1e-9)


def _kurta_mask(h: int, w: int) -> np.ndarray:
    """Front-view kurta silhouette: body, sleeves, neckline."""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    y, x = yy / h, xx / w
    mask = np.zeros((h, w), dtype=np.float64)

    # Body: shoulders at 0.09, flaring gently to the hem.
    body_top, body_bottom = 0.085, 0.99
    t = np.clip((y - body_top) / (body_bottom - body_top), 0.0, 1.0)
    half = 0.195 + 0.075 * (1.0 - t) ** 1.6 + 0.030 * t
    in_body = (np.abs(x - 0.5) <= half) & (y >= body_top) & (y <= body_bottom)
    mask[in_body] = 1.0

    # Sleeves: taper outward and downward from the shoulder line.
    s_top, s_bottom = 0.10, 0.46
    st = np.clip((y - s_top) / (s_bottom - s_top), 0.0, 1.0)
    outer = 0.075 + 0.010 * st
    inner = 0.255 + 0.030 * st
    in_sleeve = (
        (y >= s_top) & (y <= s_bottom)
        & (((x >= outer) & (x <= inner)) | ((x >= 1.0 - inner) & (x <= 1.0 - outer)))
    )
    mask[in_sleeve] = 1.0

    # Neckline: elliptical scoop cut out of the shoulders.
    neck = (((x - 0.5) / 0.105) ** 2 + ((y - 0.088) / 0.115) ** 2) <= 1.0
    mask[neck] = 0.0

    # Soften the edge so compositing does not alias.
    return np.clip(gaussian_filter(mask, sigma=max(1.0, min(h, w) / 400.0)), 0.0, 1.0)


def synthetic_template(width: int = 768, height: int = 1024, seed: int = 7) -> GarmentTemplate:
    """Procedural template: runs with no photographic assets.

    Good enough to develop and test the pipeline against. Replace with maps
    derived from a real photograph before showing output to anyone.
    """
    rng = np.random.default_rng(seed)
    mask = _kurta_mask(height, width)

    folds = _fractal_noise((height, width), rng, octaves=4, persistence=0.55, anisotropy=3.0)

    # Body form: a cylinder is brightest where it faces the light and falls off
    # toward each edge. Without this the garment reads as flat paper.
    xx = np.linspace(-1.0, 1.0, width)[None, :]
    form = np.cos(np.clip(xx, -1, 1) * (np.pi / 2.0)) ** 0.55
    form = np.repeat(form, height, axis=0)

    # Light from the upper left.
    yy = np.linspace(0.0, 1.0, height)[:, None]
    key = 1.06 - 0.16 * yy - 0.10 * xx

    shading = np.clip(0.62 * form * key + 0.30 + 0.34 * folds, 0.34, 1.16)
    shading = gaussian_filter(shading, sigma=1.2)

    # Displacement follows the gradient of the fold field: the print shifts most
    # where the surface turns most steeply away from the viewer.
    gy, gx = np.gradient(gaussian_filter(folds, sigma=2.0))
    scale = min(width, height) * 0.020
    norm = max(float(np.abs(np.stack([gy, gx])).max()), 1e-9)
    displacement = np.stack([gy, gx], axis=-1) / norm * scale

    body_width_px = width * 0.585
    return GarmentTemplate(mask, shading, displacement, body_width_px)


def load_template(directory: str | Path) -> GarmentTemplate:
    """Load a template derived from a real photograph.

    Expects ``mask.png`` (white = garment), ``shading.png`` (grey, 0.5 = neutral)
    and optionally ``displacement.png`` (R = dy, G = dx, 128 = zero offset).
    """
    d = Path(directory)
    mask = np.asarray(Image.open(d / "mask.png").convert("L"), dtype=np.float64) / 255.0
    shading = np.asarray(Image.open(d / "shading.png").convert("L"), dtype=np.float64) / 255.0
    shading = np.clip(shading / max(float(np.median(shading[mask > 0.5])), 1e-6), 0.30, 1.25)

    disp_path = d / "displacement.png"
    if disp_path.exists():
        raw = np.asarray(Image.open(disp_path).convert("RGB"), dtype=np.float64)
        scale = min(mask.shape) * 0.020
        displacement = (raw[..., :2] - 128.0) / 128.0 * scale
    else:
        gy, gx = np.gradient(gaussian_filter(shading, sigma=2.0))
        norm = max(float(np.abs(np.stack([gy, gx])).max()), 1e-9)
        displacement = np.stack([gy, gx], axis=-1) / norm * (min(mask.shape) * 0.020)

    return GarmentTemplate(mask, shading, displacement, mask.shape[1] * 0.585)


def _tile_to(tile: Image.Image, height: int, width: int, motif_px: float) -> np.ndarray:
    """Repeat a seamless tile across the canvas at a given motif size."""
    target = max(4, int(round(motif_px)))
    resized = tile.convert("RGB").resize((target, target), Image.LANCZOS)
    src = np.asarray(resized, dtype=np.float64)

    reps_y = int(np.ceil(height / target)) + 1
    reps_x = int(np.ceil(width / target)) + 1
    return np.tile(src, (reps_y, reps_x, 1))[:height, :width, :]


def synthesise_flatlay(
    tile: Image.Image,
    template: GarmentTemplate,
    motif_cm: float | None,
    frame: str = "average",
    background: tuple[int, int, int] = (244, 243, 240),
) -> Image.Image:
    """Render an unstitched fabric as a stitched garment.

    ``motif_cm`` is the real-world repeat size of the print. Passing it is what
    makes the output honest about scale: the same tile renders visibly larger on
    a petite frame than a tall one, because the garment is narrower.
    Pass ``None`` for a plain weave.
    """
    if frame not in KURTA_WIDTH_CM:
        raise ValueError(f"unknown frame {frame!r}; expected one of {sorted(KURTA_WIDTH_CM)}")

    width, height = template.size
    px_per_cm = template.body_width_px / KURTA_WIDTH_CM[frame]
    motif_px = 64.0 if motif_cm is None else max(6.0, motif_cm * px_per_cm)

    fabric = _tile_to(tile, height, width, motif_px)

    # Warp the print by the fold field. Done per channel on coordinates rather
    # than by resampling the whole image, so the print bends without softening.
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float64)
    coords_y = np.clip(yy + template.displacement[..., 0], 0, height - 1)
    coords_x = np.clip(xx + template.displacement[..., 1], 0, width - 1)
    warped = np.empty_like(fabric)
    for c in range(3):
        warped[..., c] = map_coordinates(
            fabric[..., c], [coords_y, coords_x], order=1, mode="reflect"
        )

    # Multiply the shading in. Multiply, not blend: it removes light and leaves
    # hue alone, which is what keeps the print's measured colours intact.
    lit = np.clip(warped * template.shading[..., None], 0.0, 255.0)

    alpha = template.mask[..., None]
    canvas = np.asarray(background, dtype=np.float64)[None, None, :]
    composited = lit * alpha + canvas * (1.0 - alpha)

    return Image.fromarray(composited.round().astype(np.uint8), mode="RGB")


def seamless_tile_from_colours(colours: list[tuple[str, float]], size: int = 256,
                               motif: str = "floral", seed: int = 3) -> Image.Image:
    """Placeholder tile drawn from dominant colours.

    Stands in until the extraction pipeline measures a real repeat off product
    photography. Anything rendered from this is illustrative, not a depiction of
    a real fabric.
    """
    from PIL import ImageDraw

    rng = np.random.default_rng(seed)
    hexes = [c for c, _ in colours] or ["#b5651d"]
    base = hexes[0]
    ink = hexes[1] if len(hexes) > 1 else base
    accent = hexes[2] if len(hexes) > 2 else ink

    img = Image.new("RGB", (size, size), base)
    draw = ImageDraw.Draw(img)
    c = size / 2

    if motif == "geometric":
        draw.polygon([(c, size * 0.10), (size * 0.90, c), (c, size * 0.90), (size * 0.10, c)], fill=ink)
        draw.polygon([(c, size * 0.32), (size * 0.68, c), (c, size * 0.68), (size * 0.32, c)], fill=accent)
    else:
        for i in range(6):
            a = (i / 6) * 2 * np.pi
            px, py = c + np.cos(a) * size * 0.20, c + np.sin(a) * size * 0.20
            r1, r2 = size * 0.125, size * 0.085
            draw.ellipse([px - r1, py - r2, px + r1, py + r2], fill=ink)
        draw.ellipse([c - size * 0.09, c - size * 0.09, c + size * 0.09, c + size * 0.09], fill=accent)
        # Corner sprigs, drawn wrapped so the tile still repeats seamlessly.
        for cx, cy in ((0.06, 0.06), (0.94, 0.90)):
            px, py = cx * size, cy * size
            r = size * 0.055
            draw.ellipse([px - r, py - r * 0.6, px + r, py + r * 0.6], fill=accent)

    return img
