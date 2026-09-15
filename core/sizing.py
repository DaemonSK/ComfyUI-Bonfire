"""Resize modes, interpolation choice, and Match-input resolution.

This module decides *what* the output size must be; it never touches a tensor. The
node layer reads a `ResizePlan` and performs exactly one scale operation.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .alignment import finalize_size

MODE_OFF = "off"
MODE_MEGAPIXELS = "megapixels"
MODE_LONG_EDGE = "long_edge"
MODE_FIT = "fit"
MODE_CROP = "crop"

RESIZE_MODES: tuple[str, ...] = (
    MODE_OFF,
    MODE_MEGAPIXELS,
    MODE_LONG_EDGE,
    MODE_FIT,
    MODE_CROP,
)

RESIZE_MODE_LABELS: dict[str, str] = {
    MODE_OFF: "Off",
    MODE_MEGAPIXELS: "Megapixels",
    MODE_LONG_EDGE: "Long edge",
    MODE_FIT: "Fit",
    MODE_CROP: "Crop",
}

RESAMPLE_DOWN = "area"
RESAMPLE_UP = "lanczos"
"""Area averages the pixels it discards; Lanczos is the sharper choice when adding
them. Both names are the ones comfy.utils.common_upscale accepts."""


@dataclass(frozen=True)
class ResizePlan:
    """The single scale operation the node should perform.

    `center_crop` means scale to cover the target and crop the overflow, which is
    what common_upscale does with crop="center". `resample` is None when the output
    already matches the source and no scaling is needed at all.
    """

    width: int
    height: int
    source_width: int
    source_height: int
    resample: str | None
    center_crop: bool = False

    @property
    def changes_size(self) -> bool:
        return (self.width, self.height) != (self.source_width, self.source_height)

    @property
    def source_pixels(self) -> int:
        return self.source_width * self.source_height

    @property
    def target_pixels(self) -> int:
        return self.width * self.height


def choose_resample(
    source_width: int, source_height: int, width: int, height: int
) -> str | None:
    """Area when total pixel area shrinks, Lanczos when it grows.

    The rule is about *total area*, not either axis. Only an entirely unchanged size
    skips resampling: a reshape that happens to preserve area, such as 2000x500 to
    1000x1000, still has to be resampled, and since some axis must have shrunk for the
    area to hold, area averaging is the right choice there.
    """
    if (width, height) == (source_width, source_height):
        return None

    source_pixels = source_width * source_height
    target_pixels = width * height
    if target_pixels > source_pixels:
        return RESAMPLE_UP
    return RESAMPLE_DOWN


def _require_positive(value: float, label: str) -> float:
    if value is None or value <= 0:
        raise ValueError(f"{label} must be greater than zero.")
    return value


def plan_resize(
    mode: str,
    source_width: int,
    source_height: int,
    multiple: int,
    *,
    megapixels: float | None = None,
    long_edge: int | None = None,
    target_width: int | None = None,
    target_height: int | None = None,
    snap: bool = True,
) -> ResizePlan:
    """Work out the output size for one of the five resize modes.

    Model profiles snap to their grid, including `off`. Bare multiples leave the
    requested size alone. Because the grid is rounded to the *nearest* multiple,
    `fit` can end up to half a grid step outside the requested box when snapping.
    """
    if source_width < 1 or source_height < 1:
        raise ValueError("Source dimensions must be positive.")
    if mode not in RESIZE_MODES:
        raise ValueError(f"Unknown resize mode: {mode!r}")

    center_crop = False

    if mode == MODE_OFF:
        raw_width, raw_height = float(source_width), float(source_height)

    elif mode == MODE_MEGAPIXELS:
        _require_positive(megapixels, "Megapixel target")
        scale = math.sqrt(
            (megapixels * 1_000_000) / (source_width * source_height)
        )
        raw_width, raw_height = source_width * scale, source_height * scale

    elif mode == MODE_LONG_EDGE:
        _require_positive(long_edge, "Long-edge target")
        scale = long_edge / max(source_width, source_height)
        raw_width, raw_height = source_width * scale, source_height * scale

    elif mode == MODE_FIT:
        _require_positive(target_width, "Target width")
        _require_positive(target_height, "Target height")
        scale = min(target_width / source_width, target_height / source_height)
        raw_width, raw_height = source_width * scale, source_height * scale

    else:  # MODE_CROP
        _require_positive(target_width, "Target width")
        _require_positive(target_height, "Target height")
        raw_width, raw_height = float(target_width), float(target_height)
        center_crop = True

    width, height = finalize_size(raw_width, raw_height, multiple, snap=snap)
    return ResizePlan(
        width=width,
        height=height,
        source_width=source_width,
        source_height=source_height,
        resample=choose_resample(source_width, source_height, width, height),
        center_crop=center_crop,
    )


@dataclass(frozen=True)
class MatchedSize:
    """Where each axis of a Match-input result came from, for the readout."""

    width: int
    height: int
    width_source: str
    height_source: str


def resolve_match_input(
    multiple: int,
    *,
    socket_width: int | None = None,
    socket_height: int | None = None,
    image_width: int | None = None,
    image_height: int | None = None,
    snap: bool = True,
) -> MatchedSize:
    """Combine explicit numeric sockets with an image's own dimensions.

    An explicit socket always wins over the image on that axis, and the image fills
    in whatever the sockets left out. If an axis ends up with no source at all the
    size is genuinely unknown, which is an error rather than a guess.
    """
    width = socket_width if socket_width else image_width
    height = socket_height if socket_height else image_height

    missing = [
        axis
        for axis, value in (("width", width), ("height", height))
        if not value or value < 1
    ]
    if missing:
        raise ValueError(
            "Match input needs both dimensions: "
            f"no source for {' and '.join(missing)}. Connect an image, or supply "
            "the missing value on the width/height socket."
        )

    aligned_width, aligned_height = finalize_size(width, height, multiple, snap=snap)
    return MatchedSize(
        width=aligned_width,
        height=aligned_height,
        width_source="socket" if socket_width else "image",
        height_source="socket" if socket_height else "image",
    )
