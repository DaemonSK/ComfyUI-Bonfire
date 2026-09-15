"""Pixel-grid alignment profiles.

A profile answers one question: what pixel grid must both axes land on? Anything
model-specific beyond that grid belongs to the profile that declares it, never to a
bare multiple.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

MAX_AXIS = 16384
"""Hard per-axis ceiling. Applies after grid rounding, so the result stays on-grid."""

H3_REFERENCE_SHORT_EDGE = 2048
"""MiniMax H3 scales a reference image down to this short edge, and never up."""


@dataclass(frozen=True)
class AlignmentProfile:
    """A named pixel grid.

    `multiple` is the grid. `model` marks a profile that carries model-specific
    behaviour elsewhere (reference sizing, frame grids); bare profiles must not
    inherit any of it.
    """

    key: str
    label: str
    multiple: int | None
    model: str | None = None

    @property
    def is_custom(self) -> bool:
        return self.multiple is None


PROFILES: tuple[AlignmentProfile, ...] = (
    AlignmentProfile("minimax_h3", "MiniMax H3 (32)", 32, model="minimax_h3"),
    AlignmentProfile("krea_2", "Krea 2 (16)", 16, model="krea_2"),
    AlignmentProfile("multiple_8", "Multiple of 8", 8),
    AlignmentProfile("multiple_32", "Multiple of 32", 32),
    AlignmentProfile("multiple_64", "Multiple of 64", 64),
    AlignmentProfile("custom", "Custom multiple", None),
)

PROFILES_BY_KEY: dict[str, AlignmentProfile] = {p.key: p for p in PROFILES}

PROFILE_KEYS: tuple[str, ...] = tuple(p.key for p in PROFILES)
PROFILE_LABELS: tuple[str, ...] = tuple(p.label for p in PROFILES)


def get_profile(key: str) -> AlignmentProfile:
    try:
        return PROFILES_BY_KEY[key]
    except KeyError:
        raise ValueError(f"Unknown alignment profile: {key!r}") from None


def resolve_multiple(key: str, custom_multiple: int) -> int:
    """The active grid for a profile, taking `custom_multiple` only when custom.

    A custom multiple must be a positive integer; that is a user-facing error, not
    something to silently clamp into range.
    """
    profile = get_profile(key)
    if not profile.is_custom:
        return profile.multiple
    if not isinstance(custom_multiple, int) or isinstance(custom_multiple, bool):
        raise ValueError("Custom alignment multiple must be an integer.")
    if custom_multiple < 1:
        raise ValueError("Custom alignment multiple must be 1 or greater.")
    return custom_multiple


def align_axis(value: float, multiple: int) -> int:
    """Round one axis to the nearest grid multiple, halves going up.

    Python's `round` is banker's rounding, which would send 48 to 32 on a 32 grid.
    Half-up is the stated convention, so the arithmetic is done explicitly.

    The result is always at least one full multiple: rounding a tiny value to zero
    would produce a degenerate image, so it clamps up rather than down.
    """
    if multiple < 1:
        raise ValueError("Alignment multiple must be 1 or greater.")

    ceiling = (MAX_AXIS // multiple) * multiple
    steps = math.floor(value / multiple + 0.5) if value > 0 else 0
    aligned = steps * multiple
    if aligned < multiple:
        aligned = multiple
    if aligned > ceiling:
        aligned = ceiling
    return aligned


def align_size(width: float, height: float, multiple: int) -> tuple[int, int]:
    """Round both axes independently. Neither axis influences the other."""
    return align_axis(width, multiple), align_axis(height, multiple)


def snaps_to_grid(key: str) -> bool:
    """Bare multiples and custom values are a display choice, not an auto-snap."""
    return get_profile(key).model is not None


def clamp_axis(value: float) -> int:
    """Integer pixels inside the legal axis range, with no grid rounding."""
    rounded = int(math.floor(value + 0.5)) if value > 0 else 1
    return max(1, min(rounded, MAX_AXIS))


def finalize_size(
    width: float, height: float, multiple: int, *, snap: bool
) -> tuple[int, int]:
    """Snap to the model grid when asked; otherwise keep the requested size."""
    if snap:
        return align_size(width, height, multiple)
    return clamp_axis(width), clamp_axis(height)


def h3_reference_size(width: int, height: int) -> tuple[int, int]:
    """MiniMax H3 reference-image sizing.

    Downscale only: if the short edge is over 2048 the whole image is scaled so the
    short edge becomes 2048, preserving aspect ratio. A smaller reference is left at
    its own scale -- upscaling a reference is never automatic. Both results are then
    rounded to the 32 grid.
    """
    if width < 1 or height < 1:
        raise ValueError("Reference dimensions must be positive.")

    short_edge = min(width, height)
    if short_edge > H3_REFERENCE_SHORT_EDGE:
        scale = H3_REFERENCE_SHORT_EDGE / short_edge
        width = width * scale
        height = height * scale

    return align_size(width, height, 32)
