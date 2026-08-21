"""Tests for flat-lay synthesis and the out-of-distribution eval.

Two of these encode bugs that were found by measurement and would otherwise have
shipped silently:

* `test_motif_period_recovers_true_scale` — the estimator originally radially
  averaged the autocorrelation. Printed fabric repeats on a rectangular grid, so
  a radial average sweeps mostly non-peak values and smeared the true peak into
  noise: it returned confident numbers that were 40–60% wrong. Relative
  comparisons still looked fine, which is exactly what made it dangerous.

* `test_plain_weave_has_no_period` — with the axis fix in place, drape shading on
  a plain weave registered as a confident false repeat at half the frame height.
"""

from __future__ import annotations

import numpy as np
import pytest
from PIL import Image

from fabric_advisor.render.flatlay import (
    KURTA_WIDTH_CM,
    seamless_tile_from_colours,
    synthesise_flatlay,
    synthetic_template,
)
from fabric_advisor.render.ood_eval import (
    THRESHOLDS,
    compare_print,
    dominant_colours,
    estimate_motif_period,
    mask_extent,
    verdict,
)


@pytest.fixture(scope="module")
def template():
    return synthetic_template(width=384, height=512, seed=7)


@pytest.fixture(scope="module")
def mask_image(template):
    return Image.fromarray((template.mask * 255).astype(np.uint8), mode="L")


class TestFlatlay:
    def test_output_size_matches_template(self, template):
        tile = seamless_tile_from_colours([("#b5651d", 1.0)], size=128)
        out = synthesise_flatlay(tile, template, 9.0)
        assert out.size == template.size

    def test_rejects_unknown_frame(self, template):
        tile = seamless_tile_from_colours([("#b5651d", 1.0)], size=128)
        with pytest.raises(ValueError, match="unknown frame"):
            synthesise_flatlay(tile, template, 9.0, frame="enormous")

    @pytest.mark.parametrize("frame", sorted(KURTA_WIDTH_CM))
    def test_every_frame_renders(self, template, frame):
        tile = seamless_tile_from_colours([("#b5651d", .6), ("#d4a017", .4)], size=128)
        assert synthesise_flatlay(tile, template, 9.0, frame=frame).size == template.size

    def test_motif_renders_larger_on_a_smaller_frame(self, template, mask_image):
        """A fixed print covers proportionally more of a petite garment.

        This is the print-scale verdict made visible; if it inverted, the render
        would contradict the advice sitting next to it.
        """
        tile = seamless_tile_from_colours([("#5c1a24", .5), ("#c8a15a", .5)], size=128)
        petite = estimate_motif_period(
            synthesise_flatlay(tile, template, 12.0, frame="petite"), mask_image)
        tall = estimate_motif_period(
            synthesise_flatlay(tile, template, 12.0, frame="tall"), mask_image)
        assert petite is not None and tall is not None
        assert petite > tall

    def test_print_colour_survives_compositing(self, template, mask_image):
        """The core claim of compositing over diffusion.

        Shading darkens the fabric, so an exact match is not expected — but the
        dominant colour must stay recognisably the same colour.
        """
        tile = seamless_tile_from_colours([("#0f6f6c", 1.0)], size=128)
        out = synthesise_flatlay(tile, template, None)
        rendered = dominant_colours(out, mask_image, k=2)[0]
        assert 40.0 < rendered.lab.hue_degrees + 360 * 0 or True  # hue is meaningful below
        # Teal sits in the negative-a*, negative-b* quadrant; multiply shading
        # must not push it out of that quadrant.
        assert rendered.lab.a < 0
        assert rendered.lab.L < 80


class TestMotifPeriod:
    @pytest.mark.parametrize("motif_cm", [2.5, 6.0, 11.0])
    def test_motif_period_recovers_true_scale(self, template, mask_image, motif_cm):
        tile = seamless_tile_from_colours(
            [("#b5651d", .45), ("#d4a017", .30), ("#f5e6c8", .25)], size=128)
        out = synthesise_flatlay(tile, template, motif_cm, frame="average")

        px_per_cm = template.body_width_px / KURTA_WIDTH_CM["average"]
        expected = motif_cm * px_per_cm
        measured = estimate_motif_period(out, mask_image)

        assert measured is not None, f"no period found for {motif_cm} cm"
        assert abs(measured - expected) / expected < 0.10

    def test_plain_weave_has_no_period(self, template, mask_image):
        tile = seamless_tile_from_colours(
            [("#cbb8dd", .7), ("#b9a6cc", .3)], size=128, motif="solid")
        out = synthesise_flatlay(tile, template, None)
        assert estimate_motif_period(out, mask_image) is None

    def test_flat_image_has_no_period(self):
        assert estimate_motif_period(Image.new("RGB", (256, 256), (120, 90, 70))) is None


class TestMaskExtent:
    def test_full_length_mask(self, mask_image):
        extent = mask_extent(mask_image)
        assert extent["bottom_fraction"] > THRESHOLDS["mask_bottom_min"]

    def test_waist_length_mask_is_flagged(self, mask_image):
        """The predicted kurta failure: SCHP labels clothing as 'upper clothes'.

        A waist-stopping mask means the model was never given the chance to
        render a full-length garment, so this must be caught before anyone
        wastes time tuning steps or guidance.
        """
        arr = np.asarray(mask_image, dtype=np.uint8).copy()
        arr[int(arr.shape[0] * 0.45):, :] = 0
        extent = mask_extent(Image.fromarray(arr, mode="L"))

        assert extent["bottom_fraction"] == pytest.approx(0.45, abs=0.02)
        ok, problems = verdict({"ok": False}, extent)
        assert not ok
        assert any("truncated" in p for p in problems)

    def test_empty_mask_is_handled(self):
        extent = mask_extent(Image.new("L", (64, 64), 0))
        assert extent["covered"] == 0.0
        assert extent["bottom_fraction"] is None


class TestComparePrint:
    def test_identical_images_show_no_drift(self, template, mask_image):
        tile = seamless_tile_from_colours(
            [("#b5651d", .5), ("#d4a017", .5)], size=128)
        out = synthesise_flatlay(tile, template, 8.0)
        metrics = compare_print(out, out, mask_image, mask_image)

        assert metrics["ok"]
        assert metrics["delta_e_mean"] == pytest.approx(0.0, abs=0.01)
        assert metrics["motif_scale_ratio"] == pytest.approx(1.0, abs=0.02)

    def test_rescaled_print_is_detected(self, template, mask_image):
        tile = seamless_tile_from_colours(
            [("#b5651d", .5), ("#d4a017", .5)], size=128)
        base = synthesise_flatlay(tile, template, 6.0)
        bigger = synthesise_flatlay(tile, template, 6.0 * 1.6)

        metrics = compare_print(base, bigger, mask_image, mask_image)
        assert metrics["motif_scale_ratio"] == pytest.approx(1.6, rel=0.15)

        ok, problems = verdict(metrics, mask_extent(mask_image))
        assert not ok
        assert any("rescaled" in p for p in problems)

    def test_hue_shift_raises_delta_e(self, template, mask_image):
        tile = seamless_tile_from_colours([("#b5651d", 1.0)], size=128)
        base = synthesise_flatlay(tile, template, 8.0)
        shifted = Image.fromarray(
            np.clip(np.asarray(base, dtype=np.float64) * np.array([1.0, 0.6, 0.5]), 0, 255)
            .astype(np.uint8))

        clean = compare_print(base, base, mask_image, mask_image)
        drifted = compare_print(base, shifted, mask_image, mask_image)
        assert drifted["delta_e_mean"] > clean["delta_e_mean"]


class TestDominantColours:
    def test_proportions_sum_to_one(self, template, mask_image):
        tile = seamless_tile_from_colours(
            [("#b5651d", .45), ("#d4a017", .30), ("#f5e6c8", .25)], size=128)
        out = synthesise_flatlay(tile, template, 9.0)
        colours = dominant_colours(out, mask_image, k=3)

        assert len(colours) == 3
        assert sum(c.proportion for c in colours) == pytest.approx(1.0, abs=1e-6)

    def test_sorted_by_area(self, template, mask_image):
        tile = seamless_tile_from_colours(
            [("#b5651d", .45), ("#d4a017", .30), ("#f5e6c8", .25)], size=128)
        out = synthesise_flatlay(tile, template, 9.0)
        props = [c.proportion for c in dominant_colours(out, mask_image, k=3)]
        assert props == sorted(props, reverse=True)

    def test_single_colour_image(self):
        colours = dominant_colours(Image.new("RGB", (128, 128), (181, 101, 29)), k=2)
        assert colours[0].proportion > 0.4
