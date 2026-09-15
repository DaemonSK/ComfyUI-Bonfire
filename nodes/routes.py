"""HTTP routes for the node interface.

Two jobs. It serves the image browser its listing and thumbnails, and it answers the
readout questions ("what size will this actually be?") so the interface never has to
reimplement the calculations in JavaScript and drift from the backend.

Every handler is a plain async function, registered separately at the bottom. That keeps
them callable from a test without a running server.

Rules that apply to every handler here:

* Nothing trusts a name from the request. Each one goes back through `paths` and is
  refused unless it lands inside the input directory.
* No blocking call runs on the event loop. Directory walks, `stat`, decoding and
  thumbnail encoding all go through `asyncio.to_thread`.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os

from aiohttp import web

import folder_paths

from ..core import alignment as profiles
from ..core import aspect, browse, formats, frames, sizing
from . import image_loader, imageio, paths
from .shot import RESOLUTION_MODES, resolve_size

PREFIX = "/bonfire"
MAX_DELETE_COUNT = 500

THUMBNAIL_CACHE_DIR = "bonfire-thumbnails"
THUMBNAIL_BOX_DEFAULT = 192
THUMBNAIL_BOX_MAX = 512

_log = logging.getLogger(__name__)


def _error(message: str, status: int = 400) -> web.Response:
    return web.json_response({"error": message}, status=status)


def _int_param(request, name: str, default: int | None = None) -> int | None:
    raw = request.query.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be an integer.") from None


def _float_param(request, name: str, default: float | None = None) -> float | None:
    raw = request.query.get(name)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be a number.") from None


# --------------------------------------------------------------------------- options


def option_tables() -> dict:
    """Every table and limit the interface needs, straight from the backend.

    The interface reads its dropdowns from here rather than carrying its own copies.
    A duplicated option list is a list that eventually disagrees with the schema, and
    a disagreement there means a workflow value the backend rejects.
    """
    return {
        "alignment_profiles": [
            {
                "key": profile.key,
                "label": profile.label,
                "multiple": profile.multiple,
                "model": profile.model,
            }
            for profile in profiles.PROFILES
        ],
        "resize_modes": [
            {"key": mode, "label": sizing.RESIZE_MODE_LABELS[mode]}
            for mode in sizing.RESIZE_MODES
        ],
        "resolution_modes": list(RESOLUTION_MODES),
        "aspect_ratios": [
            {
                "key": ratio.key,
                "label": ratio.label,
                "width": ratio.width,
                "height": ratio.height,
                "value": ratio.value,
            }
            for ratio in aspect.RATIOS
        ],
        "sort_modes": [
            {
                "key": mode,
                "label": browse.SORT_MODE_LABELS[mode],
                "default_descending": browse.default_descending(mode),
            }
            for mode in browse.SORT_MODES
        ],
        "extensions": list(formats.SUPPORTED_EXTENSIONS),
        "limits": {
            "max_axis": profiles.MAX_AXIS,
            "fps_default": frames.FPS_DEFAULT,
            "fps_min": frames.FPS_MIN,
            "fps_max": frames.FPS_MAX,
            "seconds_min": frames.SECONDS_MIN,
            "seconds_max": frames.SECONDS_MAX,
            "max_frames": frames.MAX_FRAMES,
            "h3_trained_min": frames.H3_TRAINED_MIN,
            "h3_trained_max": frames.H3_TRAINED_MAX,
            "thumbnail_box_default": THUMBNAIL_BOX_DEFAULT,
            "thumbnail_box_max": THUMBNAIL_BOX_MAX,
        },
    }


async def handle_options(_request) -> web.Response:
    return web.json_response(option_tables())


# --------------------------------------------------------------------------- listing


def collect_entries() -> list[browse.BrowseEntry]:
    """Walk the input directory once, keeping only what ordering needs.

    Deliberately does not open any file: name, mtime and size answer all three sort
    modes, and opening 400-odd images to build a listing would make the browser unusable.
    Blocking.
    """
    base = paths.input_directory()
    entries: list[browse.BrowseEntry] = []

    for root, _dirs, files in os.walk(base, onerror=lambda _error: None):
        for filename in files:
            if not formats.is_supported_extension(filename):
                continue
            if browse.is_mask_editor_scratch(filename):
                continue
            absolute = os.path.join(root, filename)
            if not folder_paths.is_within_directory(base, absolute):
                continue
            try:
                stat = os.stat(absolute)
            except OSError:
                continue
            entries.append(
                browse.BrowseEntry(
                    name=paths.relative_name(absolute),
                    modified_ns=stat.st_mtime_ns,
                    size_bytes=stat.st_size,
                )
            )

    return entries


def sha256_file(absolute: str) -> str:
    digest = hashlib.sha256()
    with open(absolute, "rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def duplicate_digests(entries: list[browse.BrowseEntry]) -> dict[str, str]:
    """Hash only same-size files; unique sizes cannot be byte-identical."""
    by_size: dict[int, list[browse.BrowseEntry]] = {}
    for entry in entries:
        by_size.setdefault(entry.size_bytes, []).append(entry)

    hashed: dict[str, str] = {}
    for group in by_size.values():
        if len(group) < 2:
            continue
        for entry in group:
            try:
                hashed[entry.name] = sha256_file(paths.resolve_existing(entry.name))
            except (OSError, paths.UnsafePathError):
                continue
    return browse.shared_digests(hashed)


def _sha256_hex(value: str) -> str | None:
    digest = str(value or "").strip().lower()
    if len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
        return None
    return digest


async def handle_images(request) -> web.Response:
    query = request.query.get("query", "")
    sort = request.query.get("sort", browse.DEFAULT_SORT)
    descending_raw = request.query.get("descending")
    descending = None if descending_raw is None else descending_raw == "true"

    if sort not in browse.SORT_MODES:
        return _error(f"Unknown sort mode: {sort!r}")

    def payload():
        entries = collect_entries()
        duplicates = duplicate_digests(entries)
        selected = browse.sort_entries(
            browse.filter_entries(entries, query), sort, descending
        )
        return entries, selected, duplicates

    entries, selected, duplicates = await asyncio.to_thread(payload)
    return web.json_response(
        {
            "total": len(entries),
            "images": [
                {
                    "name": entry.name,
                    "filename": entry.filename,
                    "folder": entry.folder,
                    "modified_ns": entry.modified_ns,
                    "size_bytes": entry.size_bytes,
                    "duplicate": entry.name in duplicates,
                    "digest": duplicates.get(entry.name),
                }
                for entry in selected
            ],
        }
    )


async def handle_duplicate(request) -> web.Response:
    """Return an existing input-relative name for a file with this size and digest."""
    digest = _sha256_hex(request.query.get("digest", ""))
    if digest is None:
        return _error("digest must be a SHA-256 hex string.")
    try:
        size = _int_param(request, "size")
    except ValueError as error:
        return _error(str(error))
    if size is None or size < 0:
        return _error("size must be a non-negative integer.")

    def find():
        for entry in collect_entries():
            if entry.size_bytes != size:
                continue
            try:
                if sha256_file(paths.resolve_existing(entry.name)) == digest:
                    return entry.name
            except (OSError, paths.UnsafePathError):
                continue
        return None

    return web.json_response({"name": await asyncio.to_thread(find)})


async def handle_delete(request) -> web.Response:
    """Delete explicitly named input images after validating every requested path.

    Validation happens for the complete selection before the first removal. A later
    operating-system error is reported per file so the browser can accurately remove
    only the entries that are actually gone.
    """
    try:
        body = await request.json()
    except (ValueError, TypeError):
        return _error("Delete request must contain JSON.")

    raw_names = body.get("names") if isinstance(body, dict) else None
    if not isinstance(raw_names, list):
        return _error("Delete request needs an image-name list.")
    names = list(dict.fromkeys(name for name in raw_names if isinstance(name, str) and name))
    if not names:
        return _error("Choose at least one image to delete.")
    if len(names) > MAX_DELETE_COUNT:
        return _error(f"Delete at most {MAX_DELETE_COUNT} images at once.")

    resolved: list[tuple[str, str]] = []
    try:
        for name in names:
            if not formats.is_supported_extension(name):
                return _error(f"Unsupported image type: {name!r}", status=400)
            resolved.append((name, paths.resolve_existing(name)))
    except (paths.UnsafePathError, OSError) as error:
        return _error(str(error), status=404)

    def remove_files() -> tuple[list[str], dict[str, str]]:
        deleted: list[str] = []
        errors: dict[str, str] = {}
        for name, absolute in resolved:
            try:
                os.remove(absolute)
            except OSError as error:
                errors[name] = str(error)
            else:
                deleted.append(name)
        return deleted, errors

    deleted, errors = await asyncio.to_thread(remove_files)
    return web.json_response({"deleted": deleted, "errors": errors})


# ------------------------------------------------------------------------ thumbnails


def thumbnail_cache_path(absolute: str, box: int, modified_ns: int, size: int) -> str:
    """Where a thumbnail for this exact file version is cached.

    The key covers modification time and size, so editing an image in place produces a
    different path rather than serving a stale picture. Lives in ComfyUI's temp
    directory so it is disposable and gets cleaned up with everything else.
    """
    digest = hashlib.sha256(
        f"{os.path.normcase(absolute)}|{modified_ns}|{size}|{box}".encode()
    ).hexdigest()
    directory = os.path.join(folder_paths.get_temp_directory(), THUMBNAIL_CACHE_DIR)
    os.makedirs(directory, exist_ok=True)
    return os.path.join(directory, f"{digest}.png")


def build_thumbnail(name: str, box: int) -> str:
    """Produce (or reuse) a cached thumbnail and return its path.

    Saved as PNG in RGBA so transparency survives. A thumbnail that flattens alpha onto
    white would misrepresent exactly the images whose alpha matters. Blocking.
    """
    from PIL import Image

    absolute = paths.resolve_existing(name)
    stat = os.stat(absolute)
    cached = thumbnail_cache_path(absolute, box, stat.st_mtime_ns, stat.st_size)
    if os.path.isfile(cached):
        return cached

    import node_helpers

    with node_helpers.pillow(Image.open, absolute) as image:
        frame_count = int(getattr(image, "n_frames", 1) or 1)
        verdict = formats.verdict_for(
            formats.canonical_format(image.format), frame_count
        )
        source = image.convert("RGBA")
        width, height = browse.thumbnail_size(source.width, source.height, box)
        source = source.resize((width, height), Image.LANCZOS)

    temporary = f"{cached}.{os.getpid()}.part"
    source.save(temporary, format="PNG")
    os.replace(temporary, cached)

    if not verdict.is_still:
        # A thumbnail is still useful for an animation the loader will refuse, so it is
        # generated either way; the browser marks it from /probe.
        _log.debug("Thumbnail built for non-still image %s", name)

    return cached


async def handle_thumbnail(request) -> web.Response:
    name = request.query.get("name", "")
    try:
        box = _int_param(request, "size", THUMBNAIL_BOX_DEFAULT)
    except ValueError as error:
        return _error(str(error))

    box = max(16, min(int(box), THUMBNAIL_BOX_MAX))

    try:
        cached = await asyncio.to_thread(build_thumbnail, name, box)
    except paths.UnsafePathError as error:
        return _error(str(error), status=404)
    except OSError as error:
        return _error(f"Could not read image: {error}", status=404)

    return web.FileResponse(
        cached,
        headers={
            "Content-Type": "image/png",
            # Safe to cache hard: the filename already encodes the file version.
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )


# ----------------------------------------------------------------------------- probe


async def handle_probe(request) -> web.Response:
    name = request.query.get("name", "")
    try:
        absolute = await asyncio.to_thread(paths.resolve_existing, name)
        info = await asyncio.to_thread(imageio.probe_media, absolute)
    except paths.UnsafePathError as error:
        return _error(str(error), status=404)
    except OSError as error:
        return _error(f"Could not read media: {error}", status=404)

    return web.json_response(
        {
            "name": name,
            "width": info.width,
            "height": info.height,
            "format": info.image_format,
            "frame_count": info.frame_count,
            "megapixels": round(info.megapixels, 3),
            "aspect_ratio": aspect.describe_ratio(info.width, info.height),
            "is_still": info.is_still,
            "rejection": info.rejection,
            "size_bytes": info.size_bytes,
            "modified_ns": info.modified_ns,
        }
    )


# --------------------------------------------------------------------- live readouts


async def handle_plan(request) -> web.Response:
    """The Image Loader readout: what this image will actually come out as.

    Computed by the same `core` functions the node executes with, so the number shown
    before a run is the number produced by the run.
    """
    name = request.query.get("name", "")
    try:
        custom_multiple = _int_param(request, "custom_multiple", 8)
    except ValueError as error:
        return _error(str(error))

    try:
        absolute = await asyncio.to_thread(paths.resolve_existing, name)
        info = await asyncio.to_thread(imageio.probe, absolute)
    except paths.UnsafePathError as error:
        return _error(str(error), status=404)
    except OSError as error:
        return _error(f"Could not read image: {error}", status=404)

    payload = {
        "name": name,
        "source_width": info.width,
        "source_height": info.height,
        "megapixels": round(info.megapixels, 3),
        "aspect_ratio": aspect.describe_ratio(info.width, info.height),
        "is_still": info.is_still,
        "rejection": info.rejection,
    }

    try:
        plan = image_loader.plan_image_resize(
            request.query.get("alignment", image_loader.DEFAULT_ALIGNMENT),
            custom_multiple,
            request.query.get("resize_mode", sizing.MODE_OFF),
            info.width,
            info.height,
            megapixels=_float_param(request, "megapixels", 1.0),
            long_edge=_int_param(request, "long_edge", 1024),
            target_width=_int_param(request, "target_width", 1024),
            target_height=_int_param(request, "target_height", 1024),
        )
    except ValueError as error:
        # A half-typed target or an out-of-range multiple is something to show in the
        # readout, not a failed request. Only a malformed query is a 4xx.
        payload["error"] = str(error)
        return web.json_response(payload)

    payload.update(
        {
            "width": plan.width,
            "height": plan.height,
            "resample": plan.resample,
            "center_crop": plan.center_crop,
            "final_aspect_ratio": aspect.describe_ratio(plan.width, plan.height),
            "final_megapixels": round(plan.target_pixels / 1_000_000, 3),
        }
    )
    return web.json_response(payload)


async def handle_shot(request) -> web.Response:
    """The Bonfire Shot readout, including the frame count and its warnings."""
    alignment_key = request.query.get("alignment", "minimax_h3")
    try:
        custom_multiple = _int_param(request, "custom_multiple", 8)
        seconds = _float_param(request, "seconds", 5.0)
        fps = _int_param(request, "fps", frames.FPS_DEFAULT)
    except ValueError as error:
        return _error(str(error))

    # The size and the duration are independent answers. One being unanswerable must not
    # withhold the other, so each reports its own error and the response stays a 200
    # unless the query itself was malformed.
    payload: dict = {}

    source_connected = request.query.get("source_connected", "").lower() == "true"
    resolution_mode = request.query.get("resolution_mode", "aspect_mp")
    try:
        width, height = resolve_size(
            resolution_mode,
            profiles.resolve_multiple(alignment_key, custom_multiple),
            snap=profiles.snaps_to_grid(alignment_key),
            ratio_key=request.query.get("aspect_ratio", "16:9"),
            megapixels=_float_param(request, "megapixels", 1.0),
            custom_width=_int_param(request, "custom_width", 1024),
            custom_height=_int_param(request, "custom_height", 1024),
            socket_width=_int_param(request, "socket_width"),
            socket_height=_int_param(request, "socket_height"),
            image_width=_int_param(request, "image_width"),
            image_height=_int_param(request, "image_height"),
        )
    except ValueError as error:
        if resolution_mode == "match_input" and source_connected:
            payload["size_known"] = False
        else:
            payload["size_error"] = str(error)
    else:
        payload.update(
            {
                "size_known": True,
                "width": width,
                "height": height,
                "aspect_ratio": aspect.describe_ratio(width, height),
                "megapixels": round((width * height) / 1_000_000, 3),
            }
        )

    try:
        result = frames.resolve_frames(seconds, fps, alignment_key)
    except ValueError as error:
        payload["duration_error"] = str(error)
        return web.json_response(payload)

    payload.update(
        {
            "frames": result.frames,
            "raw_frames": result.raw_frames,
            "requested_seconds": result.requested_seconds,
            "actual_seconds": round(result.actual_seconds, 3),
            "fps": result.fps,
            "snapped": result.snapped,
            "capped": result.capped,
            "warning": result.warning,
        }
    )
    return web.json_response(payload)


# ------------------------------------------------------------------------ registration

ROUTES: tuple[tuple[str, str, object], ...] = (
    ("get", "/options", handle_options),
    ("get", "/images", handle_images),
    ("get", "/duplicate", handle_duplicate),
    ("post", "/delete", handle_delete),
    ("get", "/thumbnail", handle_thumbnail),
    ("get", "/probe", handle_probe),
    ("get", "/plan", handle_plan),
    ("get", "/shot", handle_shot),
)


def register(routes) -> list[str]:
    """Attach every handler to a route table. Returns the paths registered."""
    registered = []
    for method, suffix, handler in ROUTES:
        path = f"{PREFIX}{suffix}"
        getattr(routes, method)(path)(handler)
        registered.append(path)
    return registered


def register_with_server() -> list[str]:
    """Register against the running PromptServer, if there is one.

    ComfyUI loads custom nodes before it calls `PromptServer.add_routes`, so registering
    at import time is enough. Guarded so importing this module outside a server -- in a
    test, or a tool -- is not an error.
    """
    try:
        from server import PromptServer
    except ImportError:
        return []

    instance = getattr(PromptServer, "instance", None)
    if instance is None or not hasattr(instance, "routes"):
        return []
    return register(instance.routes)
