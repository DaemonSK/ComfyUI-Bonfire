"""Aspect-ratio presets and the aspect-plus-megapixels calculation."""

from __future__ import annotations

import math
from dataclasses import dataclass

from .alignment import finalize_size


@dataclass(frozen=True)
class AspectRatio:
    """One selectable ratio.

    `width`/`height` are the ratio terms as written, so the label and the arithmetic
    can never drift apart: 2.39:1 stores 2.39 and 1, not a rounded decimal.
    """

    key: str
    label: str
    width: float
    height: float

    @property
    def value(self) -> float:
        return self.width / self.height

    @property
    def is_landscape(self) -> bool:
        return self.width > self.height

    @property
    def is_square(self) -> bool:
        return self.width == self.height


RATIOS: tuple[AspectRatio, ...] = (
    AspectRatio("1:1", "1:1", 1, 1),
    AspectRatio("4:5", "4:5", 4, 5),
    AspectRatio("5:4", "5:4", 5, 4),
    AspectRatio("2:3", "2:3", 2, 3),
    AspectRatio("3:2", "3:2", 3, 2),
    AspectRatio("3:4", "3:4", 3, 4),
    AspectRatio("4:3", "4:3", 4, 3),
    AspectRatio("9:16", "9:16", 9, 16),
    AspectRatio("16:9", "16:9", 16, 9),
    AspectRatio("9:21", "9:21", 9, 21),
    AspectRatio("21:9", "21:9", 21, 9),
    AspectRatio("1.85:1", "1.85:1", 1.85, 1),
    AspectRatio("2.39:1", "2.39:1", 2.39, 1),
)

RATIOS_BY_KEY: dict[str, AspectRatio] = {r.key: r for r in RATIOS}

RATIO_KEYS: tuple[str, ...] = tuple(r.key for r in RATIOS)


def get_ratio(key: str) -> AspectRatio:
    try:
        return RATIOS_BY_KEY[key]
    except KeyError:
        raise ValueError(f"Unknown aspect ratio: {key!r}") from None


def size_for_megapixels(ratio_value: float, megapixels: float) -> tuple[float, float]:
    """Unaligned width and height covering `megapixels` at the given ratio.

    Solving w*h = pixels with w/h = ratio gives w = sqrt(pixels * ratio). The result
    is deliberately unrounded; grid alignment is a separate, explicit step.
    """
    if ratio_value <= 0:
        raise ValueError("Aspect ratio must be positive.")
    if megapixels <= 0:
        raise ValueError("Megapixel target must be positive.")

    pixels = megapixels * 1_000_000
    return math.sqrt(pixels * ratio_value), math.sqrt(pixels / ratio_value)


def aligned_size_for_megapixels(
    ratio_key: str, megapixels: float, multiple: int, *, snap: bool = True
) -> tuple[int, int]:
    """Width and height for a ratio and megapixel target, optionally grid-snapped."""
    width, height = size_for_megapixels(get_ratio(ratio_key).value, megapixels)
    return finalize_size(width, height, multiple, snap=snap)


READABLE_RATIO_TERM = 16
"""Largest term still worth printing as a ratio.

Chosen to cover every preset in *reduced* form, which is not the same as the terms they
are written with: 21:9 reduces to 7:3 and 9:21 to 3:7, so the widest preset contributes a
7, and the biggest reduced term across the whole table is the 16 of 16:9.

Above that the integer form stops being recognisable. Grid rounding turns a 16:9 request
at 1MP into 1344x736, which reduces to 42:23 -- worse to show someone who asked for 16:9
than a plain decimal.
"""


def describe_ratio(width: int, height: int) -> str:
    """The ratio of a concrete size, written the way it reads best.

    1920x1080 reads as 16:9. Anything that only reduces to large terms is shown as a
    decimal rather than an unreadable pair like 42:23 or 1237:642.
    """
    if width < 1 or height < 1:
        raise ValueError("Dimensions must be positive.")

    divisor = math.gcd(width, height)
    terms = (width // divisor, height // divisor)
    if max(terms) <= READABLE_RATIO_TERM:
        return f"{terms[0]}:{terms[1]}"

    # Put the 1 on the side that makes the number readable. A portrait shape written as
    # "0.56:1" is accurate and useless; "1:1.78" is recognisably a 9:16.
    if width >= height:
        return f"{width / height:.2f}:1"
    return f"1:{height / width:.2f}"
