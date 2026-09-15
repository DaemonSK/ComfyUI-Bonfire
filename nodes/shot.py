"""The Bonfire Shot node.

Works out a target resolution and a legal frame count. It reads a connected image only
for its dimensions and never returns it, so nothing downstream sees an altered image.

`core.alignment` is imported as `profiles` because "alignment" is also a schema input.
"""

from __future__ import annotations

from comfy_api.v0_0_2 import io

from ..core import alignment as profiles
from ..core import aspect, frames, sizing

MODE_ASPECT_MP = "aspect_mp"
MODE_CUSTOM_SIZE = "custom_size"
MODE_MATCH_INPUT = "match_input"

RESOLUTION_MODES: tuple[str, ...] = (MODE_ASPECT_MP, MODE_CUSTOM_SIZE, MODE_MATCH_INPUT)

DEFAULT_ALIGNMENT = "minimax_h3"


def image_dimensions(image) -> tuple[int | None, int | None]:
    """Width and height of an IMAGE tensor, or a pair of Nones if nothing is connected.

    ComfyUI images are NHWC, so height and width are the last two spatial axes.
    """
    if image is None:
        return None, None
    shape = getattr(image, "shape", None)
    if shape is None or len(shape) < 3:
        return None, None
    return int(shape[-2]), int(shape[-3])


def resolve_size(
    mode: str,
    multiple: int,
    *,
    snap: bool = True,
    ratio_key: str = "1:1",
    megapixels: float = 1.0,
    custom_width: int = 1024,
    custom_height: int = 1024,
    socket_width: int | None = None,
    socket_height: int | None = None,
    image_width: int | None = None,
    image_height: int | None = None,
) -> tuple[int, int]:
    """The output size for one of the three resolution modes."""
    if mode == MODE_ASPECT_MP:
        return aspect.aligned_size_for_megapixels(
            ratio_key, megapixels, multiple, snap=snap
        )

    if mode == MODE_CUSTOM_SIZE:
        return profiles.finalize_size(custom_width, custom_height, multiple, snap=snap)

    if mode == MODE_MATCH_INPUT:
        matched = sizing.resolve_match_input(
            multiple,
            socket_width=socket_width,
            socket_height=socket_height,
            image_width=image_width,
            image_height=image_height,
            snap=snap,
        )
        return matched.width, matched.height

    raise ValueError(f"Unknown resolution mode: {mode!r}")


class BonfireShot(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="BonfireShot",
            display_name="Bonfire Shot",
            category="Bonfire",
            description=(
                "Calculate a grid-aligned target resolution and a legal video frame "
                "count. Does not alter a connected image."
            ),
            search_aliases=["bonfire", "shot", "resolution", "frame count"],
            inputs=[
                io.Combo.Input(
                    "resolution_mode",
                    options=list(RESOLUTION_MODES),
                    default=MODE_ASPECT_MP,
                    tooltip="Where the output dimensions come from.",
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
                    "aspect_ratio",
                    options=list(aspect.RATIO_KEYS),
                    default="16:9",
                    tooltip="Ratio used by the 'aspect_mp' resolution mode.",
                ),
                io.Float.Input(
                    "megapixels",
                    default=1.0,
                    min=0.01,
                    max=64.0,
                    step=0.01,
                    tooltip="Target area used by the 'aspect_mp' resolution mode.",
                ),
                io.Int.Input(
                    "custom_width",
                    default=1024,
                    min=1,
                    max=profiles.MAX_AXIS,
                    tooltip="Width used by the 'custom_size' resolution mode.",
                ),
                io.Int.Input(
                    "custom_height",
                    default=1024,
                    min=1,
                    max=profiles.MAX_AXIS,
                    tooltip="Height used by the 'custom_size' resolution mode.",
                ),
                io.Float.Input(
                    "seconds",
                    default=5.0,
                    min=frames.SECONDS_MIN,
                    max=frames.SECONDS_MAX,
                    step=0.1,
                    tooltip="Requested duration in seconds, before the frame grid.",
                ),
                io.Int.Input(
                    "fps",
                    default=frames.FPS_DEFAULT,
                    min=frames.FPS_MIN,
                    max=frames.FPS_MAX,
                    tooltip="Frames per second used to convert seconds to frames.",
                ),
                io.Int.Input(
                    "width",
                    optional=True,
                    force_input=True,
                    tooltip=(
                        "Match input: overrides the width taken from the image."
                    ),
                ),
                io.Int.Input(
                    "height",
                    optional=True,
                    force_input=True,
                    tooltip=(
                        "Match input: overrides the height taken from the image."
                    ),
                ),
                io.Image.Input(
                    "image",
                    optional=True,
                    tooltip=(
                        "Match input: read for its dimensions only. Never modified "
                        "and never returned."
                    ),
                ),
            ],
            outputs=[
                io.Int.Output(display_name="width"),
                io.Int.Output(display_name="height"),
                io.Int.Output(display_name="duration"),
            ],
        )

    @classmethod
    def validate_inputs(cls, **kwargs) -> bool | str:
        resolution_mode = kwargs.get("resolution_mode", MODE_ASPECT_MP)
        alignment = kwargs.get("alignment", DEFAULT_ALIGNMENT)
        custom_multiple = kwargs.get("custom_multiple", 8)
        seconds = kwargs.get("seconds", 5.0)
        fps = kwargs.get("fps", frames.FPS_DEFAULT)
        if resolution_mode not in RESOLUTION_MODES:
            return f"Unknown resolution mode: {resolution_mode!r}"
        if resolution_mode == MODE_MATCH_INPUT:
            has_image = "image" in kwargs
            has_dimensions = "width" in kwargs and "height" in kwargs
            if not has_image and not has_dimensions:
                return "Match input needs an image or both width and height connections."
        try:
            profiles.resolve_multiple(alignment, custom_multiple)
            frames.validate_fps(fps)
            frames.validate_seconds(seconds)
        except ValueError as error:
            return str(error)
        return True

    @classmethod
    def execute(
        cls,
        resolution_mode=MODE_ASPECT_MP,
        alignment=DEFAULT_ALIGNMENT,
        custom_multiple=8,
        aspect_ratio="16:9",
        megapixels=1.0,
        custom_width=1024,
        custom_height=1024,
        seconds=5.0,
        fps=frames.FPS_DEFAULT,
        width=None,
        height=None,
        image=None,
    ) -> io.NodeOutput:
        multiple = profiles.resolve_multiple(alignment, custom_multiple)
        image_width, image_height = image_dimensions(image)

        out_width, out_height = resolve_size(
            resolution_mode,
            multiple,
            snap=profiles.snaps_to_grid(alignment),
            ratio_key=aspect_ratio,
            megapixels=megapixels,
            custom_width=custom_width,
            custom_height=custom_height,
            socket_width=width,
            socket_height=height,
            image_width=image_width,
            image_height=image_height,
        )

        result = frames.resolve_frames(seconds, fps, alignment)
        return io.NodeOutput(out_width, out_height, result.frames)
