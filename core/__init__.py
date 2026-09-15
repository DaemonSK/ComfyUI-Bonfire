"""Pure calculation layer for Bonfire.

Nothing in this package imports ComfyUI, torch, PIL or aiohttp. Every function here
is a deterministic calculation over plain Python values so it can be tested without a
running server. Node registration and tensor work live in `nodes/`.
"""
