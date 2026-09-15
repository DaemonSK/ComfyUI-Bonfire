"""Listing, filtering and ordering for the image browser.

Pure: an entry is a name plus what `os.stat` already told us. Nothing here opens a file,
so the whole browser ordering is testable without a filesystem.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

SORT_MODIFIED = "modified"
SORT_NAME = "name"
SORT_SIZE = "size"

SORT_MODES: tuple[str, ...] = (SORT_MODIFIED, SORT_NAME, SORT_SIZE)

SORT_MODE_LABELS: dict[str, str] = {
    SORT_MODIFIED: "Date modified",
    SORT_NAME: "Filename",
    SORT_SIZE: "File size",
}

DEFAULT_SORT = SORT_MODIFIED

_DIGITS = re.compile(r"(\d+)")
_MASK_EDITOR_SCRATCH = re.compile(
    r"^clipspace-(?:paint|mask|painted)-(?!masked-)", re.IGNORECASE
)


@dataclass(frozen=True)
class BrowseEntry:
    """One listed image. `name` is input-relative with forward slashes."""

    name: str
    modified_ns: int
    size_bytes: int

    @property
    def filename(self) -> str:
        return self.name.rsplit("/", 1)[-1]

    @property
    def folder(self) -> str:
        return self.name.rsplit("/", 1)[0] if "/" in self.name else ""


def is_mask_editor_scratch(name: str) -> bool:
    """Whether a file is an internal Mask Editor layer, not a user-facing result.

    The editor writes transparent paint and mask companions beside the final
    ``clipspace-painted-masked-*`` image. Listing those companions produces blank
    checkerboard cards and makes one edit look like four user images.
    """
    filename = str(name).replace("\\", "/").rsplit("/", 1)[-1]
    return bool(_MASK_EDITOR_SCRATCH.match(filename))


def natural_key(name: str) -> tuple:
    """Sort key that orders embedded numbers by value, not by digit.

    Plain string ordering puts shot10 before shot2, which is wrong for the numbered
    sequences this browser is mostly full of. Digit runs are compared as integers and
    everything else case-insensitively.
    """
    parts = _DIGITS.split(name)
    return tuple(
        (1, int(part), "") if part.isdigit() else (0, 0, part.lower())
        for part in parts
        if part != ""
    )


def matches(entry: BrowseEntry, query: str) -> bool:
    """Whether a query matches the entry, by folder path or by filename.

    Case-insensitive substring over the whole relative name, so "portraits/" narrows by
    folder and "sunset" by filename, without needing two different search boxes.
    """
    if not query:
        return True
    return query.strip().lower() in entry.name.lower()


def filter_entries(entries, query: str) -> list[BrowseEntry]:
    return [entry for entry in entries if matches(entry, query)]


def default_descending(mode: str) -> bool:
    """Whether a sort mode should start newest- or largest-first.

    Date and size are more useful inverted; filenames read best A to Z.
    """
    if mode not in SORT_MODES:
        raise ValueError(f"Unknown sort mode: {mode!r}")
    return mode in (SORT_MODIFIED, SORT_SIZE)


def shared_digests(name_to_digest: dict[str, str]) -> dict[str, str]:
    """Keep only names whose content digest appears more than once."""
    counts: dict[str, int] = {}
    for digest in name_to_digest.values():
        counts[digest] = counts.get(digest, 0) + 1
    return {
        name: digest
        for name, digest in name_to_digest.items()
        if counts.get(digest, 0) > 1
    }


def sort_entries(entries, mode: str = DEFAULT_SORT, descending: bool | None = None):
    """Order entries by one of the three supported modes.

    Newest-first and largest-first are the useful defaults for date and size, while
    names read best ascending, so `descending` defaults per mode rather than globally.
    """
    if mode not in SORT_MODES:
        raise ValueError(f"Unknown sort mode: {mode!r}")

    if descending is None:
        descending = default_descending(mode)

    if mode == SORT_NAME:
        key = lambda entry: natural_key(entry.name)  # noqa: E731
    elif mode == SORT_MODIFIED:
        key = lambda entry: (entry.modified_ns, natural_key(entry.name))  # noqa: E731
    else:
        key = lambda entry: (entry.size_bytes, natural_key(entry.name))  # noqa: E731

    return sorted(entries, key=key, reverse=descending)


def thumbnail_size(width: int, height: int, box: int) -> tuple[int, int]:
    """Fit an image inside a square box, preserving aspect ratio, never upscaling.

    A thumbnail larger than its source would only waste bytes to show the same pixels,
    so a small image is served at its own size.
    """
    if width < 1 or height < 1:
        raise ValueError("Image dimensions must be positive.")
    if box < 1:
        raise ValueError("Thumbnail box must be positive.")

    scale = min(box / width, box / height, 1.0)
    return max(1, round(width * scale)), max(1, round(height * scale))
