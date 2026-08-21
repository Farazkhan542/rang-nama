"""Rendering: fabric -> garment flat-lay -> try-on.

Stage 4a (`flatlay`) is the piece that makes try-on possible for unstitched
cloth at all. Every try-on model on the market - CatVTON, Leffa, FASHN, Kling -
needs a *garment* to transfer onto a person. An unstitched product photo is a
flat bolt of printed fabric: there is no garment, nothing to segment, nothing to
warp. Synthesising a plausible stitched garment from the print is therefore not
an optimisation, it is the precondition.

Stage 4b (`tryon`) is deliberately a thin, swappable backend. That part is
commodity; this part is not.
"""
