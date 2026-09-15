"""Requested seconds to a legal video frame count.

The `duration` a generation wants is a frame count, not seconds. Only profiles that
declare a frame grid get one; a bare alignment multiple must never inherit it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .alignment import get_profile

FPS_DEFAULT = 24
FPS_MIN = 1
FPS_MAX = 240

SECONDS_MIN = 0.1
SECONDS_MAX = 150.0

MAX_FRAMES = 3600
"""Absolute ceiling on emitted frames, whatever the profile."""

H3_MODULUS = 17
H3_REMAINDER = 5
"""MiniMax H3 accepts only frame counts where frames % 17 == 5."""

H3_TRAINED_MIN = 124
H3_TRAINED_MAX = 362
"""The range H3 was trained on. Outside is allowed, but warned about."""


@dataclass(frozen=True)
class FrameResult:
    """The outcome of a duration calculation.

    `frames` is what the node emits. `requested_seconds` is what the user asked for and
    `actual_seconds` is what `frames` really plays as at `fps` -- they differ whenever a
    frame grid snapped the count, and the UI shows both.
    """

    frames: int
    fps: int
    requested_seconds: float
    raw_frames: int
    snapped: bool
    capped: bool
    warning: str | None = None

    @property
    def actual_seconds(self) -> float:
        return self.frames / self.fps


def validate_fps(fps: int) -> int:
    if not isinstance(fps, int) or isinstance(fps, bool):
        raise ValueError("FPS must be an integer.")
    if not FPS_MIN <= fps <= FPS_MAX:
        raise ValueError(f"FPS must be between {FPS_MIN} and {FPS_MAX}.")
    return fps


def validate_seconds(seconds: float) -> float:
    if not SECONDS_MIN <= float(seconds) <= SECONDS_MAX:
        raise ValueError(
            f"Duration must be between {SECONDS_MIN} and {SECONDS_MAX} seconds."
        )
    return float(seconds)


def raw_frame_count(seconds: float, fps: int) -> int:
    """seconds x fps, halves going up, never below one frame.

    Half-up rather than `round`, which is banker's rounding and would send 2.5 to 2.
    """
    return max(1, math.floor(seconds * fps + 0.5))


def is_h3_legal(frames: int) -> bool:
    return frames % H3_MODULUS == H3_REMAINDER


def h3_snap_up(frames: int) -> int:
    """The first H3-legal count at or above `frames`."""
    offset = (H3_REMAINDER - frames) % H3_MODULUS
    return frames + offset


def largest_h3_legal_at_most(limit: int) -> int:
    """The highest H3-legal count not exceeding `limit`.

    At the 3600 ceiling this is 3592; snapping up from the cap would exceed it.
    """
    candidate = h3_snap_up(limit - H3_MODULUS + 1)
    while candidate + H3_MODULUS <= limit:
        candidate += H3_MODULUS
    return candidate


def resolve_frames(seconds: float, fps: int, profile_key: str) -> FrameResult:
    """Turn a requested duration into the frame count the node emits."""
    fps = validate_fps(fps)
    seconds = validate_seconds(seconds)
    profile = get_profile(profile_key)

    raw = raw_frame_count(seconds, fps)
    frames = raw
    snapped = False
    capped = False
    warning: str | None = None

    if profile.model == "minimax_h3":
        frames = h3_snap_up(raw)
        snapped = frames != raw
        if frames > MAX_FRAMES:
            frames = largest_h3_legal_at_most(MAX_FRAMES)
            capped = True
        if frames < H3_TRAINED_MIN or frames > H3_TRAINED_MAX:
            warning = (
                f"{frames} frames is outside MiniMax H3's trained range of "
                f"{H3_TRAINED_MIN}-{H3_TRAINED_MAX}. Quality may drop."
            )
    elif frames > MAX_FRAMES:
        frames = MAX_FRAMES
        capped = True

    return FrameResult(
        frames=frames,
        fps=fps,
        requested_seconds=seconds,
        raw_frames=raw,
        snapped=snapped,
        capped=capped,
        warning=warning,
    )
