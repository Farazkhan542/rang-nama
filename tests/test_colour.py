"""Tests for the colour core.

The CIEDE2000 cases come from the reference dataset published with

    Sharma, Wu & Dalal (2005), "The CIEDE2000 Color-Difference Formula:
    Implementation Notes, Supplementary Test Data, and Mathematical
    Observations", Color Research & Application 30(1).

That dataset exists specifically to catch the discontinuity and hue-wraparound
bugs that a plausible-looking CIEDE2000 implementation almost always has. Pairs
1-9 sit near the neutral axis and around the 180-degree hue boundary; pairs
17-26 are real-world sample colours. Passing all of them is the difference
between "the formula looks right" and "the formula is right".
"""

from __future__ import annotations

import math

import pytest

from fabric_advisor.core.colour import (
    Lab,
    contrast_ratio,
    delta_e_2000,
    hex_to_lab,
    hex_to_rgb,
    rgb_to_hex,
    rgb_to_lab,
)

# (L1, a1, b1), (L2, a2, b2), expected dE00
SHARMA_CASES = [
    ((50.0000, 2.6772, -79.7751), (50.0000, 0.0000, -82.7485), 2.0425),
    ((50.0000, 3.1571, -77.2803), (50.0000, 0.0000, -82.7485), 2.8615),
    ((50.0000, 2.8361, -74.0200), (50.0000, 0.0000, -82.7485), 3.4412),
    ((50.0000, -1.3802, -84.2814), (50.0000, 0.0000, -82.7485), 1.0000),
    ((50.0000, -1.1848, -84.8006), (50.0000, 0.0000, -82.7485), 1.0000),
    ((50.0000, -0.9009, -85.5211), (50.0000, 0.0000, -82.7485), 1.0000),
    ((50.0000, 0.0000, 0.0000), (50.0000, -1.0000, 2.0000), 2.3669),
    ((50.0000, -1.0000, 2.0000), (50.0000, 0.0000, 0.0000), 2.3669),
    ((50.0000, 2.4900, -0.0010), (50.0000, -2.4900, 0.0009), 7.1792),
    ((50.0000, 2.4900, -0.0010), (50.0000, -2.4900, 0.0010), 7.1792),
    ((50.0000, 2.4900, -0.0010), (50.0000, -2.4900, 0.0011), 7.2195),
    ((50.0000, 2.4900, -0.0010), (50.0000, -2.4900, 0.0012), 7.2195),
    ((50.0000, -0.0010, 2.4900), (50.0000, 0.0009, -2.4900), 4.8045),
    ((50.0000, -0.0010, 2.4900), (50.0000, 0.0010, -2.4900), 4.8045),
    # Not a typo, and not a tolerance issue: nudging a2 from 0.0010 to 0.0011
    # flips the hue quadrant, and CIEDE2000 genuinely steps from 4.8045 to
    # 4.7461. Sharma et al. include this pair precisely to catch implementations
    # that smooth the discontinuity away.
    ((50.0000, -0.0010, 2.4900), (50.0000, 0.0011, -2.4900), 4.7461),
    ((50.0000, 2.5000, 0.0000), (50.0000, 0.0000, -2.5000), 4.3065),
    ((50.0000, 2.5000, 0.0000), (73.0000, 25.0000, -18.0000), 27.1492),
    ((50.0000, 2.5000, 0.0000), (61.0000, -5.0000, 29.0000), 22.8977),
    ((50.0000, 2.5000, 0.0000), (56.0000, -27.0000, -3.0000), 31.9030),
    ((50.0000, 2.5000, 0.0000), (58.0000, 24.0000, 15.0000), 19.4535),
    ((60.2574, -34.0099, 36.2677), (60.4626, -34.1751, 39.4387), 1.2644),
    ((63.0109, -31.0961, -5.8663), (62.8187, -29.7946, -4.0864), 1.2630),
    ((61.2901, 3.7196, -5.3901), (61.4292, 2.2480, -4.9620), 1.8731),
    ((35.0831, -44.1164, 3.7933), (35.0232, -40.0716, 1.5901), 1.8645),
    ((22.7233, 20.0904, -46.6940), (23.0331, 14.9730, -42.5619), 2.0373),
    ((36.4612, 47.8580, 18.3852), (36.2715, 50.5065, 21.2231), 1.4146),
    ((90.8027, -2.0831, 1.4410), (91.1528, -1.6435, 0.0447), 1.4441),
    ((90.9257, -0.5406, -0.9208), (88.6381, -0.8985, -0.7239), 1.5381),
    ((6.7747, -0.2908, -2.4247), (5.8714, -0.0985, -2.2286), 0.6377),
    ((2.0776, 0.0795, -1.1350), (0.9033, -0.0636, -0.5514), 0.9082),
]


@pytest.mark.parametrize("lab1,lab2,expected", SHARMA_CASES)
def test_delta_e_2000_matches_sharma_reference(lab1, lab2, expected):
    got = delta_e_2000(Lab(*lab1), Lab(*lab2))
    assert got == pytest.approx(expected, abs=1e-4)


def test_delta_e_is_symmetric():
    """dE(a,b) must equal dE(b,a). Asymmetry means a hue-wrap bug."""
    for lab1, lab2, _ in SHARMA_CASES:
        forward = delta_e_2000(Lab(*lab1), Lab(*lab2))
        backward = delta_e_2000(Lab(*lab2), Lab(*lab1))
        assert forward == pytest.approx(backward, abs=1e-9)


def test_identical_colours_have_zero_difference():
    lab = hex_to_lab("#7a3b2e")
    assert delta_e_2000(lab, lab) == pytest.approx(0.0, abs=1e-12)


class TestConversions:
    def test_known_srgb_to_lab_anchors(self):
        # White, black and mid grey are the anchors worth pinning: if the
        # transfer function or white point is wrong, these move first.
        white = rgb_to_lab((255, 255, 255))
        assert white.L == pytest.approx(100.0, abs=1e-4)
        assert white.a == pytest.approx(0.0, abs=1e-3)
        assert white.b == pytest.approx(0.0, abs=1e-3)

        black = rgb_to_lab((0, 0, 0))
        assert black.L == pytest.approx(0.0, abs=1e-9)

        # sRGB 128 grey sits near L*=53.6, not 50 - that gap *is* the gamma
        # curve, and a linear-light bug collapses it toward 50.
        grey = rgb_to_lab((128, 128, 128))
        assert grey.L == pytest.approx(53.585, abs=0.01)
        assert grey.chroma == pytest.approx(0.0, abs=1e-3)

    def test_pure_red_lab(self):
        red = rgb_to_lab((255, 0, 0))
        assert red.L == pytest.approx(53.2408, abs=0.01)
        assert red.a == pytest.approx(80.0925, abs=0.01)
        assert red.b == pytest.approx(67.2032, abs=0.01)

    def test_hex_roundtrip(self):
        for value in ("#000000", "#ffffff", "#7a3b2e", "#1b3a5c"):
            assert rgb_to_hex(hex_to_rgb(value)) == value

    def test_hex_shorthand_expands(self):
        assert hex_to_rgb("#abc") == hex_to_rgb("#aabbcc")

    def test_hex_without_hash(self):
        assert hex_to_rgb("7a3b2e") == (0x7A, 0x3B, 0x2E)

    @pytest.mark.parametrize("bad", ["#12345", "nope", "", "#1234567"])
    def test_bad_hex_rejected(self, bad):
        with pytest.raises(ValueError):
            hex_to_rgb(bad)

    def test_hue_angle_wraps_to_positive(self):
        for value in ("#7a3b2e", "#1b3a5c", "#2e7a3b", "#ffffff"):
            assert 0.0 <= hex_to_lab(value).hue_degrees < 360.0

    def test_chroma_is_non_negative(self):
        for value in ("#7a3b2e", "#1b3a5c", "#808080"):
            assert hex_to_lab(value).chroma >= 0.0


class TestContrast:
    def test_black_on_white_is_maximum(self):
        assert contrast_ratio((0, 0, 0), (255, 255, 255)) == pytest.approx(21.0, abs=1e-6)

    def test_identical_colours_have_ratio_one(self):
        assert contrast_ratio((90, 40, 30), (90, 40, 30)) == pytest.approx(1.0, abs=1e-9)

    def test_contrast_is_symmetric(self):
        a, b = (12, 30, 90), (240, 220, 200)
        assert contrast_ratio(a, b) == pytest.approx(contrast_ratio(b, a), abs=1e-12)

    def test_ratio_stays_in_range(self):
        samples = [(0, 0, 0), (255, 255, 255), (128, 128, 128), (200, 30, 40)]
        for first in samples:
            for second in samples:
                assert 1.0 <= contrast_ratio(first, second) <= 21.0


def test_delta_e_grows_with_visible_difference():
    """Sanity ordering: a near-identical pair must score below an obvious one."""
    base = hex_to_lab("#7a3b2e")
    nearly = hex_to_lab("#7c3d30")
    obvious = hex_to_lab("#2e5f7a")
    assert delta_e_2000(base, nearly) < delta_e_2000(base, obvious)
    assert not math.isnan(delta_e_2000(base, obvious))
