"""Decoding and resizing.

The only place in this package that touches PIL or a tensor. Sizing decisions arrive
already made as a `ResizePlan`; this module performs them.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import numpy as np
import torch
from PIL import Image, ImageOps

import comfy.model_management
import comfy.utils
import node_helpers

from ..core import formats
from ..core.sizing import RESAMPLE_DOWN, ResizePlan

_TRANSPOSING_ORIENTATIONS = frozenset({5, 6, 7, 8})
_EXIF_ORIENTATION_TAG = 274


class UnsupportedImageError(ValueError):
    """The file is not a still image this loader will accept."""


@dataclass(frozen=True)
class ImageInfo:
    """What the header says, without decoding pixel data."""

    width: int
    height: int
    image_format: str | None
    frame_count: int
    modified_ns: int
    size_bytes: int

    @property
    def megapixels(self) -> float:
        return (self.width * self.height) / 1_000_000

    @property
    def is_still(self) -> bool:
        return formats.verdict_for(self.image_format, self.frame_count).is_still

    @property
    def rejection(self) -> str | None:
        return formats.verdict_for(self.image_format, self.frame_count).reason


@dataclass(frozen=True)
class VideoInfo:
    """Dimensions obtainable from a video header without decoding frames."""

    width: int
    height: int
    image_format: str | None
    frame_count: int
    modified_ns: int
    size_bytes: int

    @property
    def megapixels(self) -> float:
        return (self.width * self.height) / 1_000_000

    @property
    def is_still(self) -> bool:
        return False

    @property
    def rejection(self) -> None:
        return None


def probe(path: str) -> ImageInfo:
    """Read dimensions, format and frame count from the container header.

    `Image.open` parses the header only, so no frame is decoded. Orientation is read
    from the same header and applied to the reported dimensions, because a rotated
    photo should advertise the size it will actually load at.

    Blocking: keep it off the server event loop.
    """
    stat = os.stat(path)

    with node_helpers.pillow(Image.open, path) as image:
        width, height = image.size
        image_format = formats.canonical_format(image.format) or formats.format_of(path)
        frame_count = int(getattr(image, "n_frames", 1) or 1)

        orientation = None
        try:
            exif = image.getexif()
            orientation = exif.get(_EXIF_ORIENTATION_TAG) if exif else None
        except Exception:
            # An unreadable or malformed EXIF block is not a reason to fail a probe;
            # the unrotated size is still better than no answer.
            orientation = None

    if orientation in _TRANSPOSING_ORIENTATIONS:
        width, height = height, width

    return ImageInfo(
        width=width,
        height=height,
        image_format=image_format,
        frame_count=frame_count,
        modified_ns=stat.st_mtime_ns,
        size_bytes=stat.st_size,
    )


def probe_video(path: str) -> VideoInfo:
    """Read the first video stream's display dimensions, including rotation."""
    import av

    stat = os.stat(path)
    with av.open(path) as container:
        stream = next(iter(container.streams.video), None)
        if stream is None:
            raise OSError("The file has no video stream.")

        width = int(stream.codec_context.width)
        height = int(stream.codec_context.height)
        rotation = 0.0
        raw_rotation = stream.metadata.get("rotate")
        if raw_rotation is not None:
            try:
                rotation = float(raw_rotation)
            except (TypeError, ValueError):
                rotation = 0.0
        for side_data in getattr(stream, "side_data", ()):
            if "DISPLAYMATRIX" not in str(getattr(side_data, "type", "")).upper():
                continue
            get_rotation = getattr(side_data, "get_rotation", None)
            if callable(get_rotation):
                rotation = float(get_rotation())
                break

        if round(rotation) % 180:
            width, height = height, width

        format_name = getattr(getattr(container, "format", None), "name", None)
        frame_count = int(getattr(stream, "frames", 0) or 0)

    return VideoInfo(
        width=width,
        height=height,
        image_format=format_name,
        frame_count=frame_count,
        modified_ns=stat.st_mtime_ns,
        size_bytes=stat.st_size,
    )


def probe_media(path: str) -> ImageInfo | VideoInfo:
    """Probe a supported still image or a common video container by header."""
    if formats.is_supported_extension(path):
        return probe(path)
    if formats.is_video_extension(path):
        return probe_video(path)
    raise OSError(f"Unsupported media extension: {formats.extension_of(path) or '(none)'}")


def load_still(path: str) -> tuple[torch.Tensor, torch.Tensor | None]:
    """Decode one still image into ComfyUI's RGB IMAGE and semantic MASK tensors.

    ComfyUI masks are the inverse of image alpha: opaque pixels are 0 and transparent
    pixels are 1.  ``None`` represents an image with no alpha channel so the caller can
    return core's standard 64x64 empty mask without confusing it with a real mask.

    A multi-frame file raises rather than yielding frame one. Silently loading a slice
    of an animation and calling it the image is the wrong answer this refuses to give.
    """
    info = probe(path)
    verdict = formats.verdict_for(info.image_format, info.frame_count)
    if not verdict.is_still:
        raise UnsupportedImageError(verdict.reason)

    image = node_helpers.pillow(Image.open, path)
    try:
        image = node_helpers.pillow(ImageOps.exif_transpose, image)
        rgb = np.array(image.convert("RGB"), dtype=np.float32) / 255.0
        pixels = torch.from_numpy(rgb).unsqueeze(0)

        mask = None
        if "A" in image.getbands():
            alpha = np.array(image.getchannel("A"), dtype=np.float32) / 255.0
            mask = 1.0 - torch.from_numpy(alpha).unsqueeze(0)
        return pixels, mask
    finally:
        image.close()


def resize_image(pixels: torch.Tensor, plan: ResizePlan) -> torch.Tensor:
    """Scale an NHWC IMAGE tensor to the plan, in one operation.

    `common_upscale` works in NCHW and does the centre crop itself when asked, so Crop
    mode is the same single call as the others rather than a separate crop step.
    """
    if plan.resample is None and not plan.center_crop:
        return pixels

    samples = pixels.movedim(-1, 1)
    scaled = comfy.utils.common_upscale(
        samples,
        plan.width,
        plan.height,
        plan.resample or RESAMPLE_DOWN,
        "center" if plan.center_crop else "disabled",
    )
    return scaled.movedim(1, -1)


def resize_mask(mask: torch.Tensor, plan: ResizePlan) -> torch.Tensor:
    """Apply the image's exact scale/crop geometry to its semantic mask.

    Masks deliberately use bilinear interpolation, matching ComfyUI's mask helpers,
    while IMAGE keeps its area/Lanczos policy.
    """
    if plan.resample is None and not plan.center_crop:
        return mask

    return comfy.utils.common_upscale(
        mask.unsqueeze(1),
        plan.width,
        plan.height,
        "bilinear",
        "center" if plan.center_crop else "disabled",
    ).squeeze(1)


def empty_mask() -> torch.Tensor:
    """Return the same sentinel mask shape as ComfyUI's built-in LoadImage."""
    return torch.zeros((1, 64, 64), dtype=torch.float32)


def to_execution_device(tensor: torch.Tensor) -> torch.Tensor:
    """Hand a tensor over on ComfyUI's chosen intermediate device and dtype.

    Device and dtype selection belongs to model management, not to this node.
    """
    return tensor.to(
        device=comfy.model_management.intermediate_device(),
        dtype=comfy.model_management.intermediate_dtype(),
    )
