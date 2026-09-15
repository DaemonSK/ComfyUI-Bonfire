"""Which files the loader accepts, and the single-frame rule.

Deciding *whether* a file is animated needs a decoder and belongs to the I/O layer.
Deciding what to do about it is a rule, and lives here.
"""

from __future__ import annotations

from dataclasses import dataclass

EXTENSIONS: dict[str, str] = {
    ".png": "PNG",
    ".jpg": "JPEG",
    ".jpeg": "JPEG",
    ".webp": "WebP",
    ".gif": "GIF",
    ".bmp": "BMP",
    ".tif": "TIFF",
    ".tiff": "TIFF",
}

SUPPORTED_EXTENSIONS: tuple[str, ...] = tuple(sorted(EXTENSIONS))

SUPPORTED_FORMATS: tuple[str, ...] = ("PNG", "JPEG", "WebP", "GIF", "BMP", "TIFF")

VIDEO_EXTENSIONS: frozenset[str] = frozenset(
    {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}
)

MULTI_FRAME_CAPABLE: frozenset[str] = frozenset({"GIF", "WebP", "TIFF"})
"""Formats whose containers can hold more than one frame. PNG's APNG variant is
reported by decoders as a multi-frame PNG, so frame count is still checked for every
format rather than only these -- this set is what the warning text keys off."""

_MULTI_FRAME_NOUN: dict[str, str] = {
    "GIF": "an animated GIF",
    "WebP": "an animated WebP",
    "TIFF": "a multipage TIFF",
    "PNG": "an animated PNG",
}


@dataclass(frozen=True)
class FrameVerdict:
    """Whether a decoded file may be loaded as a still image."""

    is_still: bool
    frame_count: int
    reason: str | None = None


_CANONICAL_BY_LOWER: dict[str, str] = {name.lower(): name for name in SUPPORTED_FORMATS}


def canonical_format(name: str | None) -> str | None:
    """Map a decoder's format string onto the spelling used here.

    Pillow reports WebP as ``WEBP``, so a decoder's answer cannot be compared to these
    names directly; every lookup that keys off a format goes through this first.
    Unrecognised names are returned unchanged rather than discarded, so an unexpected
    format still reaches the user in a message.
    """
    if name is None:
        return None
    return _CANONICAL_BY_LOWER.get(name.strip().lower(), name)


def extension_of(filename: str) -> str:
    """The lowercased extension, including the dot."""
    _, _, tail = filename.rpartition(".")
    return f".{tail.lower()}" if tail and tail != filename else ""


def is_supported_extension(filename: str) -> bool:
    return extension_of(filename) in EXTENSIONS


def is_video_extension(filename: str) -> bool:
    return extension_of(filename) in VIDEO_EXTENSIONS


def format_of(filename: str) -> str | None:
    return EXTENSIONS.get(extension_of(filename))


def verdict_for(image_format: str | None, frame_count: int) -> FrameVerdict:
    """Apply the single-frame rule to a decoded file.

    Loading frame one of an animation and calling it the image is exactly the silent
    wrong answer this rejects: the user asked for that file, not a slice of it.
    """
    if frame_count < 1:
        return FrameVerdict(False, frame_count, "This file contains no image frames.")
    if frame_count == 1:
        return FrameVerdict(True, 1)

    image_format = canonical_format(image_format)
    noun = _MULTI_FRAME_NOUN.get(
        image_format or "", f"a multi-frame {image_format or 'image'}"
    )
    return FrameVerdict(
        False,
        frame_count,
        f"This is {noun} ({frame_count} frames). Bonfire loads still images only, "
        "and will not silently use the first frame.",
    )
