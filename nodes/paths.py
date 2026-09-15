"""The filesystem boundary.

Every path that reaches this package from a workflow, a widget or an HTTP request is
untrusted. It is resolved here and nowhere else, and it is only ever allowed to land
inside ComfyUI's input directory.
"""

from __future__ import annotations

import os

import folder_paths

from ..core import formats

INPUT_ANNOTATION = " [input]"


class UnsafePathError(ValueError):
    """A requested path resolved outside the input directory, or does not exist."""


def input_directory() -> str:
    return folder_paths.get_input_directory()


def strip_annotation(name: str) -> str:
    """Drop a trailing ``[input]`` marker.

    The Mask Editor writes its result back as ``name [input]``, so the annotation has
    to be understood. ``[output]`` and ``[temp]`` are deliberately not: they name
    directories this node is not allowed to read.
    """
    if not isinstance(name, str):
        raise UnsafePathError("Image name must be a string.")

    stripped = name.strip()
    if stripped.endswith(INPUT_ANNOTATION):
        return stripped[: -len(INPUT_ANNOTATION)].strip()
    for rejected in ("[output]", "[temp]"):
        if stripped.endswith(rejected):
            raise UnsafePathError(
                f"Bonfire reads from the input directory only, not {rejected}."
            )
    return stripped


def resolve(name: str) -> str:
    """Turn a widget value into an absolute path inside the input directory.

    Containment is re-checked after resolution rather than trusted from the shape of
    the string, because `..` segments and symlinks both only reveal themselves once
    the path is real.
    """
    relative = strip_annotation(name)
    if not relative:
        raise UnsafePathError("No image selected.")
    if "\x00" in relative:
        raise UnsafePathError("Image name contains a null byte.")

    base = os.path.realpath(input_directory())
    candidate = os.path.realpath(os.path.abspath(os.path.join(base, relative)))

    if not folder_paths.is_within_directory(base, candidate):
        raise UnsafePathError(f"Image path escapes the input directory: {name!r}")
    return candidate


def resolve_existing(name: str) -> str:
    """Resolve, and require that the file is actually there."""
    path = resolve(name)
    if not os.path.isfile(path):
        raise UnsafePathError(f"Image file does not exist: {strip_annotation(name)!r}")
    return path


def is_safe(name: str) -> bool:
    """Whether `name` resolves to an existing file inside the input directory."""
    try:
        resolve_existing(name)
    except (UnsafePathError, OSError):
        return False
    return True


def relative_name(path: str) -> str:
    """The input-relative name for an absolute path, using forward slashes.

    Forward slashes because this value travels to the browser and back, and a
    Windows backslash does not survive that round trip intact.
    """
    relative = os.path.relpath(path, input_directory())
    return relative.replace(os.sep, "/")


def list_images(recursive: bool = True) -> list[str]:
    """Every supported image under the input directory, as relative names.

    Walks with `os.walk` rather than a glob so that unreadable subdirectories are
    skipped instead of aborting the listing. Blocking: call it off the event loop.
    """
    base = input_directory()
    found: list[str] = []

    for root, dirs, files in os.walk(base, onerror=lambda _error: None):
        if not recursive and root != base:
            dirs.clear()
            continue
        for filename in files:
            if not formats.is_supported_extension(filename):
                continue
            absolute = os.path.join(root, filename)
            if folder_paths.is_within_directory(base, absolute):
                found.append(relative_name(absolute))

    return found
