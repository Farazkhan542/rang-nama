"""Deterministic core: colour maths, palettes and the verdict engine.

Nothing in this package calls a model or the network. It is the free hot path -
it runs on every product view, client-side where possible, and must stay
instant and dependency-light.
"""
