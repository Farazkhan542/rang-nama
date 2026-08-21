"""Measuring whether a try-on model actually handles Pakistani ethnic wear.

Every open try-on model is trained on VITON-HD and DressCode: Western tops, on
slim Western models, photographed against clean studio backdrops. Shalwar kameez
is out of distribution on garment shape, garment length, drape and the presence
of a dupatta. "It looks a bit off" is not a finding you can act on, so this
module turns the question into numbers.

Three failure modes, each measured separately:

1. **Length truncation.** Human parsers (SCHP, trained on ATR/LIP) label clothing
   as "upper clothes", a category that ends at the waist. A kurta reaches
   mid-thigh. If the agnostic mask stops short, the model was never given the
   chance to render a full-length garment, and the result is a kurta-top over
   the wearer's original trousers. `mask_extent` measures this directly, and it
   is the first thing to check because it invalidates everything else.

2. **Print drift.** The whole argument for compositing over diffusion is that a
   print must survive exactly. `compare_print` measures whether it did, in
   CIEDE2000 and in motif period.

3. **Motif rescaling.** A model that renders the print at the wrong repeat size
   silently breaks the print-scale verdict, since that verdict is stated in
   centimetres.

`estimate_motif_period` is not eval-only: Stage 1 needs exactly this to measure
a fabric's repeat off product photography.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PIL import Image

from ..core.colour import Lab, delta_e_2000, rgb_to_lab


def _pixels(img: Image.Image, mask: Image.Image | None = None,
            max_samples: int = 30000, seed: int = 0) -> np.ndarray:
    """Flat array of RGB pixels, optionally restricted to a mask."""
    arr = np.asarray(img.convert("RGB"), dtype=np.float64)
    if mask is not None:
        m = np.asarray(mask.convert("L").resize(img.size), dtype=np.float64) / 255.0
        arr = arr[m > 0.5]
    else:
        arr = arr.reshape(-1, 3)

    if arr.size == 0:
        return np.zeros((0, 3))
    if len(arr) > max_samples:
        rng = np.random.default_rng(seed)
        arr = arr[rng.choice(len(arr), max_samples, replace=False)]
    return arr


def _kmeans_lab(pixels: np.ndarray, k: int, iters: int = 25, seed: int = 0
                ) -> tuple[np.ndarray, np.ndarray]:
    """Small deterministic k-means, clustering in CIELAB.

    Clustering happens in Lab rather than RGB because Euclidean distance in Lab
    is roughly perceptual, so the resulting centroids correspond to colours a
    person would actually name as distinct. The same clustering in RGB tends to
    split highlights off as their own "colour".
    """
    if len(pixels) == 0:
        return np.zeros((0, 3)), np.zeros(0)

    lab = np.array([[c.L, c.a, c.b] for c in
                    (rgb_to_lab((int(r), int(g), int(b))) for r, g, b in pixels)])

    k = min(k, len(lab))
    rng = np.random.default_rng(seed)

    # k-means++ seeding: random init regularly collapses two centroids onto the
    # same dominant colour and reports a print as having fewer colours than it has.
    centres = [lab[rng.integers(len(lab))]]
    for _ in range(k - 1):
        d2 = np.min(((lab[:, None, :] - np.array(centres)[None, :, :]) ** 2).sum(-1), axis=1)
        total = d2.sum()
        probs = d2 / total if total > 0 else None
        centres.append(lab[rng.choice(len(lab), p=probs)])
    centres = np.array(centres)

    labels = np.zeros(len(lab), dtype=int)
    for _ in range(iters):
        dist = ((lab[:, None, :] - centres[None, :, :]) ** 2).sum(-1)
        new_labels = dist.argmin(1)
        if np.array_equal(new_labels, labels):
            break
        labels = new_labels
        for j in range(k):
            members = lab[labels == j]
            if len(members):
                centres[j] = members.mean(0)

    counts = np.bincount(labels, minlength=k).astype(float)
    return centres, counts / max(counts.sum(), 1)


@dataclass(frozen=True)
class ColourShareMeasured:
    lab: Lab
    proportion: float


def dominant_colours(img: Image.Image, mask: Image.Image | None = None, k: int = 4,
                     seed: int = 0) -> list[ColourShareMeasured]:
    """Dominant colours as Lab centroids with area proportions."""
    centres, props = _kmeans_lab(_pixels(img, mask, seed=seed), k, seed=seed)
    out = [ColourShareMeasured(Lab(*c), float(p)) for c, p in zip(centres, props, strict=True)]
    return sorted(out, key=lambda c: -c.proportion)


def estimate_motif_period(img: Image.Image, mask: Image.Image | None = None,
                          max_side: int = 512) -> float | None:
    """Estimate a print's repeat period in pixels, by autocorrelation.

    Autocorrelation via FFT rather than peak-picking the raw spectrum: a printed
    repeat is rarely a clean sinusoid, so its Fourier peak smears across
    harmonics, while autocorrelation gives one unambiguous lag. Returns None for
    a plain weave, where no periodic structure exists to find.
    """
    grey = img.convert("L")
    # Track the downscale factor. The lag is measured in resized pixels, so it
    # has to be converted back or every period comes out short by that factor -
    # invisible in relative comparisons, fatal for a measurement in centimetres.
    scale = 1.0
    if max(grey.size) > max_side:
        scale = max_side / max(grey.size)
        grey = grey.resize((max(8, int(grey.width * scale)), max(8, int(grey.height * scale))))

    arr = np.asarray(grey, dtype=np.float64)
    if mask is not None:
        m = np.asarray(mask.convert("L").resize(grey.size), dtype=np.float64) / 255.0
        if m.sum() < 100:
            return None
        arr = arr * m + arr[m > 0.5].mean() * (1.0 - m)

    arr = arr - arr.mean()
    if arr.std() < 1e-6:
        return None

    spectrum = np.fft.rfft2(arr)
    acorr = np.fft.irfft2(spectrum * np.conj(spectrum), s=arr.shape)
    acorr = np.fft.fftshift(acorr)
    acorr /= max(acorr.max(), 1e-9)

    cy, cx = np.array(acorr.shape) // 2
    max_r = int(min(cy, cx) * 0.9)
    if max_r < 8:
        return None

    # Measure along the horizontal and vertical axes rather than radially.
    # Printed fabric repeats on a rectangular grid, so the autocorrelation peaks
    # sit at axis-aligned lags. A radial average sweeps a circle through mostly
    # non-peak values and smears the true peak below the noise floor - it
    # returns a number, and the number is wrong.
    profile_x = acorr[cy, cx:cx + max_r]
    profile_y = acorr[cy:cy + max_r, cx]

    # A repeat needs to be seen several times to be a repeat. Anything longer
    # than a quarter of the frame appears at most twice, which is not enough to
    # distinguish a print from large-scale shading - drape and fold shadows on a
    # plain weave otherwise register as a confident false period.
    max_period = min(arr.shape) / 4.0

    periods = [
        p for p in (_first_peak(profile_x), _first_peak(profile_y))
        if p is not None and p <= max_period
    ]
    if not periods:
        return None

    # Prints are usually square-repeat; where the two axes disagree, the smaller
    # is the safer read, since the larger is often a doubled repeat.
    return float(min(periods)) / scale


def _first_peak(profile: np.ndarray) -> float | None:
    """Fundamental period from a 1-D autocorrelation profile."""
    n = len(profile)
    if n < 8:
        return None

    # Skip the central lobe: autocorrelation always peaks at zero lag and decays
    # away from it. The first local minimum marks where that lobe ends and real
    # periodic structure begins; starting at a fixed small lag lands inside the
    # lobe and reports noise.
    start = 1
    while start < n - 2 and profile[start + 1] < profile[start]:
        start += 1
    start = max(start, 2)

    peaks = [
        i for i in range(start + 1, n - 1)
        if profile[i] > profile[i - 1] and profile[i] >= profile[i + 1]
    ]
    if not peaks:
        return None

    strongest = max(profile[p] for p in peaks)
    if strongest < 0.04:
        return None

    # A repeat autocorrelates at its period *and every multiple of it*. Taking
    # the tallest peak lands on a harmonic as often as the fundamental, so take
    # the smallest lag among comparably strong peaks.
    return float(min(p for p in peaks if profile[p] >= 0.55 * strongest))


def mask_extent(mask: Image.Image) -> dict:
    """How far down the frame the agnostic mask reaches.

    The decisive number for the kurta problem. A waist-length "upper clothes"
    mask covers roughly the top 45% of a full-body frame; a kurta needs about
    65-70%. If `bottom_fraction` lands near 0.45 the model was handed the wrong
    region and no amount of prompt or step tuning will produce a full-length
    garment.
    """
    m = np.asarray(mask.convert("L"), dtype=np.float64) / 255.0
    rows = np.where(m.max(axis=1) > 0.5)[0]
    if len(rows) == 0:
        return {"covered": 0.0, "top_fraction": None, "bottom_fraction": None}
    h = m.shape[0]
    return {
        "covered": float((m > 0.5).mean()),
        "top_fraction": float(rows[0] / h),
        "bottom_fraction": float(rows[-1] / h),
        "height_fraction": float((rows[-1] - rows[0]) / h),
    }


def compare_print(source: Image.Image, result: Image.Image,
                  source_mask: Image.Image | None = None,
                  result_mask: Image.Image | None = None,
                  k: int = 3) -> dict:
    """Did the print survive the model?

    Colours are matched greedily nearest-first rather than by rank, because a
    model that preserves every colour but shifts their area proportions would
    otherwise be scored as having changed the colours.
    """
    src = dominant_colours(source, source_mask, k=k)
    res = dominant_colours(result, result_mask, k=k)
    if not src or not res:
        return {"ok": False, "reason": "no colours extracted"}

    deltas = []
    available = list(res)
    for s in src:
        nearest = min(available, key=lambda r: delta_e_2000(s.lab, r.lab))
        deltas.append(delta_e_2000(s.lab, nearest.lab))
        if len(available) > 1:
            available.remove(nearest)

    src_period = estimate_motif_period(source, source_mask)
    res_period = estimate_motif_period(result, result_mask)
    if src_period and res_period:
        scale_ratio = res_period / src_period
    else:
        scale_ratio = None

    return {
        "ok": True,
        "delta_e_per_colour": [round(d, 2) for d in deltas],
        "delta_e_mean": round(float(np.mean(deltas)), 2),
        "delta_e_worst": round(float(np.max(deltas)), 2),
        "source_period_px": None if src_period is None else round(src_period, 1),
        "result_period_px": None if res_period is None else round(res_period, 1),
        "motif_scale_ratio": None if scale_ratio is None else round(scale_ratio, 3),
    }


# Thresholds for a pass/fail read. Deliberately explicit so they can be argued
# with rather than buried in a comparison.
THRESHOLDS = {
    # dE > 10 reads as a different colour to an ordinary viewer.
    "delta_e_mean_max": 10.0,
    # A repeat off by more than a quarter breaks a verdict stated in centimetres.
    "motif_scale_tolerance": 0.25,
    # A kurta needs the mask to reach at least this far down the frame.
    "mask_bottom_min": 0.60,
}


def verdict(metrics: dict, extent: dict) -> tuple[bool, list[str]]:
    """Turn the measurements into a pass/fail with stated reasons."""
    problems: list[str] = []

    bottom = extent.get("bottom_fraction")
    if bottom is not None and bottom < THRESHOLDS["mask_bottom_min"]:
        problems.append(
            f"mask stops at {bottom:.0%} of frame height (need >= "
            f"{THRESHOLDS['mask_bottom_min']:.0%}) - garment truncated to a waist-length top"
        )

    if metrics.get("ok"):
        if metrics["delta_e_mean"] > THRESHOLDS["delta_e_mean_max"]:
            problems.append(f"print colour drifted, mean dE {metrics['delta_e_mean']}")
        ratio = metrics.get("motif_scale_ratio")
        if ratio is not None and abs(ratio - 1.0) > THRESHOLDS["motif_scale_tolerance"]:
            problems.append(f"motif rescaled by {ratio:.2f}x - print-scale verdict invalidated")

    return (not problems), problems
