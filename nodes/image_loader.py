"""The Bonfire Image Loader node.

Thin by design: it validates, asks `core` what the output size should be, and hands the
work to `imageio`. Every calculation it relies on is tested without a server.

`core.alignment` is imported as `profiles` throughout this module because "alignment" is
also the name of a schema input, and the parameter would shadow the module inside every
method that takes it.
"""

from __future__ import annotations

import hashlib

from comfy_api.v0_0_2 import io

from ..core import alignment as profiles
from ..core import browse, sizing
from ..core.imagequeue import ImageQueue

from . import imageio, paths

CURRENT_IMAGE_INPUT = "image"
"""Must stay exactly "image". The Mask Editor locates its target by that name
(ComfyUI_frontend v1.51.10, useMaskEditorSaver.ts:286) and silently writes nowhere if
it does not match, which would leave painted masks out of the MASK output."""

QUEUE_INPUT = "queue"

DEFAULT_ALIGNMENT = "minimax_h3"


def plan_image_resize(
    alignment: str,
    custom_multiple: int,
    resize_mode: str,
    source_width: int,
    source_height: int,
    **resize_values,
) -> sizing.ResizePlan:
    """Resolve the loader's generic modes plus MiniMax H3 reference fitting."""
    multiple = profiles.resolve_multiple(alignment, custom_multiple)
    plan = sizing.plan_resize(
        resize_mode,
        source_width,
        source_height,
        multiple,
        snap=profiles.snaps_to_grid(alignment),
        **resize_values,
    )
    if resize_mode != sizing.MODE_OFF:
        return plan

    if profiles.get_profile(alignment).model != "minimax_h3":
        return plan

    width, height = profiles.h3_reference_size(source_width, source_height)
    return sizing.ResizePlan(
        width=width,
        height=height,
        source_width=source_width,
        source_height=source_height,
        resample=sizing.choose_resample(source_width, source_height, width, height),
    )


def _sorted_input_images() -> list[str]:
    """Options for the image widget.

    Sorted for a stable widget list, which is a different concern from the queue: the
    queue keeps the order the user added things in, this is only the picker.
    """
    try:
        return sorted(
            name for name in paths.list_images() if not browse.is_mask_editor_scratch(name)
        )
    except OSError:
        return []


class BonfireImageLoader(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="BonfireImageLoader",
            display_name="Bonfire Image Loader",
            category="Bonfire",
            description=(
                "Load a still image from the input directory, preserving the order "
                "images were added in, with alignment and resizing applied."
            ),
            search_aliases=["bonfire", "image loader", "ordered image queue"],
            inputs=[
                io.Combo.Input(
                    CURRENT_IMAGE_INPUT,
                    options=_sorted_input_images(),
                    tooltip="The image currently selected from the queue.",
                ),
                io.String.Input(
                    QUEUE_INPUT,
                    default="[]",
                    tooltip=(
                        "The ordered queue, as JSON. Maintained by the node interface "
                        "and persisted with the workflow."
                    ),
                ),
                io.Combo.Input(
                    "alignment",
                    options=list(profiles.PROFILE_KEYS),
                    default=DEFAULT_ALIGNMENT,
                    tooltip="Pixel grid both output dimensions are rounded to.",
                ),
                io.Int.Input(
                    "custom_multiple",
                    default=8,
                    min=1,
                    max=1024,
                    tooltip="Grid used when the alignment profile is 'custom'.",
                ),
                io.Combo.Input(
                    "resize_mode",
                    options=list(sizing.RESIZE_MODES),
                    default=sizing.MODE_OFF,
                    tooltip="How the image is scaled before alignment is applied.",
                ),
                io.Float.Input(
                    "megapixels",
                    default=1.0,
                    min=0.01,
                    max=64.0,
                    step=0.01,
                    tooltip="Target area for the 'megapixels' resize mode.",
                ),
                io.Int.Input(
                    "long_edge",
                    default=1024,
                    min=8,
                    max=profiles.MAX_AXIS,
                    tooltip="Target longest side for the 'long_edge' resize mode.",
                ),
                io.Int.Input(
                    "target_width",
                    default=1024,
                    min=8,
                    max=profiles.MAX_AXIS,
                    tooltip="Target width for the 'fit' and 'crop' resize modes.",
                ),
                io.Int.Input(
                    "target_height",
                    default=1024,
                    min=8,
                    max=profiles.MAX_AXIS,
                    tooltip="Target height for the 'fit' and 'crop' resize modes.",
                ),
            ],
            outputs=[
                io.Image.Output(),
                io.Mask.Output(),
                io.Int.Output(display_name="width"),
                io.Int.Output(display_name="height"),
            ],
        )

    @classmethod
    def validate_inputs(
        cls,
        image=None,
        queue=None,
        alignment=DEFAULT_ALIGNMENT,
        custom_multiple=8,
        **_unused,
    ) -> bool | str:
        """Reject bad state before execution, with a message naming the problem."""
        try:
            path = paths.resolve_existing(image)
        except paths.UnsafePathError as error:
            return str(error)

        try:
            profiles.resolve_multiple(alignment, custom_multiple)
        except ValueError as error:
            return str(error)

        try:
            ImageQueue.parse(queue)
        except ValueError as error:
            return str(error)

        try:
            info = imageio.probe(path)
        except OSError as error:
            return f"Could not read {image!r}: {error}"

        if not info.is_still:
            return info.rejection

        return True

    @classmethod
    def fingerprint_inputs(
        cls,
        image=None,
        alignment=DEFAULT_ALIGNMENT,
        custom_multiple=8,
        resize_mode=sizing.MODE_OFF,
        megapixels=1.0,
        long_edge=1024,
        target_width=1024,
        target_height=1024,
        **_unused,
    ):
        """Cache key: the file's modification identity plus every parameter that
        changes the pixels.

        Modification time and size rather than a content hash, so switching between
        images does not read each file in full just to decide whether a cached result
        can be reused.

        The queue is deliberately absent. Reordering or extending it does not change
        this image, and including it would discard a valid cached result.
        """
        digest = hashlib.sha256()
        try:
            info = imageio.probe(paths.resolve_existing(image))
            digest.update(f"{info.modified_ns}:{info.size_bytes}".encode())
        except (paths.UnsafePathError, OSError) as error:
            # An unreadable selection must not share a cache key with a readable one.
            digest.update(f"unresolved:{error}".encode())

        for value in (
            image,
            alignment,
            custom_multiple,
            resize_mode,
            megapixels,
            long_edge,
            target_width,
            target_height,
        ):
            digest.update(f"|{value}".encode())

        return digest.hexdigest()

    @classmethod
    def execute(
        cls,
        image,
        queue="[]",
        alignment=DEFAULT_ALIGNMENT,
        custom_multiple=8,
        resize_mode=sizing.MODE_OFF,
        megapixels=1.0,
        long_edge=1024,
        target_width=1024,
        target_height=1024,
    ) -> io.NodeOutput:
        path = paths.resolve_existing(image)
        pixels, mask = imageio.load_still(path)

        source_height, source_width = pixels.shape[1], pixels.shape[2]
        plan = plan_image_resize(
            alignment,
            custom_multiple,
            resize_mode,
            source_width,
            source_height,
            megapixels=megapixels,
            long_edge=long_edge,
            target_width=target_width,
            target_height=target_height,
        )

        pixels = imageio.resize_image(pixels, plan)
        mask = imageio.empty_mask() if mask is None else imageio.resize_mask(mask, plan)

        return io.NodeOutput(
            imageio.to_execution_device(pixels),
            imageio.to_execution_device(mask),
            plan.width,
            plan.height,
        )
