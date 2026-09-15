"""The ordered image queue.

The queue stores *only* the ordered entries. Which one is current is whatever the
node's `image` value holds, and the position is derived by looking it up. Storing an
index as well would be a second copy of the same fact, free to drift on reload.

Order is insertion order, never sorted: the user chose it by adding in that sequence.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

EMPTY_POSITION = "0 / 0"


@dataclass(frozen=True)
class ImageQueue:
    """An immutable ordered list of unique entries.

    Every mutating method returns a new queue, so a caller can never half-apply a
    change to shared state.
    """

    entries: tuple[str, ...] = ()

    def __len__(self) -> int:
        return len(self.entries)

    def __contains__(self, entry: object) -> bool:
        return entry in self.entries

    @classmethod
    def parse(cls, raw: str | None) -> ImageQueue:
        """Read a serialized queue.

        An absent or blank value is an empty queue, not a failure -- that is a node
        that has never been used. Anything else that is not a JSON array of non-empty
        strings is malformed and raises, rather than silently discarding entries the
        user added.
        """
        if raw is None:
            return cls()
        if isinstance(raw, (list, tuple)):
            return cls(cls._deduplicate(raw))
        if not isinstance(raw, str) or not raw.strip():
            return cls()

        try:
            decoded = json.loads(raw)
        except (TypeError, ValueError) as error:
            raise ValueError(f"Image queue is not valid JSON: {error}") from None

        if not isinstance(decoded, list):
            raise ValueError("Image queue must be a JSON array.")
        return cls(cls._deduplicate(decoded))

    @staticmethod
    def _deduplicate(items) -> tuple[str, ...]:
        """Keep the first occurrence of each entry, preserving order."""
        seen: set[str] = set()
        unique: list[str] = []
        for item in items:
            if not isinstance(item, str) or not item:
                raise ValueError("Image queue entries must be non-empty strings.")
            if item not in seen:
                seen.add(item)
                unique.append(item)
        return tuple(unique)

    def serialize(self) -> str:
        return json.dumps(list(self.entries))

    def index_of(self, current: str | None) -> int | None:
        if current is None:
            return None
        try:
            return self.entries.index(current)
        except ValueError:
            return None

    def add(self, entry: str) -> ImageQueue:
        """Append an entry, skipping it if the queue already has it.

        Re-adding an existing entry is not an error and does not reorder anything;
        the caller moves the cursor to it instead.
        """
        if not isinstance(entry, str) or not entry:
            raise ValueError("An image queue entry must be a non-empty string.")
        if entry in self.entries:
            return self
        return ImageQueue(self.entries + (entry,))

    def extend(self, new_entries) -> ImageQueue:
        """Add several entries in the order given, skipping duplicates."""
        queue = self
        for entry in new_entries:
            queue = queue.add(entry)
        return queue

    def remove(self, entry: str) -> tuple[ImageQueue, str | None]:
        """Drop one entry and say which entry should become current.

        This only forgets the queue position. The file on disk is untouched.

        The replacement is whatever slid into the vacated slot, so removing from the
        middle keeps you in the same place in the list. Removing the last entry steps
        back to the new final one; emptying the queue leaves nothing current.
        """
        index = self.index_of(entry)
        if index is None:
            raise ValueError(f"Entry is not in the queue: {entry!r}")

        remaining = self.entries[:index] + self.entries[index + 1 :]
        if not remaining:
            return ImageQueue(), None
        return ImageQueue(remaining), remaining[min(index, len(remaining) - 1)]

    def step(self, current: str | None, offset: int) -> str | None:
        """The entry `offset` places from `current`, clamped at both ends.

        Clamped rather than wrapping: reaching the end of a deliberately ordered list
        should feel like an end, not silently restart it.
        """
        if not self.entries:
            return None
        index = self.index_of(current)
        if index is None:
            return self.entries[0]

        target = index + offset
        target = max(0, min(target, len(self.entries) - 1))
        return self.entries[target]

    def next(self, current: str | None) -> str | None:
        return self.step(current, 1)

    def previous(self, current: str | None) -> str | None:
        return self.step(current, -1)

    def position_label(self, current: str | None) -> str:
        """One-based position for the readout, such as "2 / 5"."""
        if not self.entries:
            return EMPTY_POSITION
        index = self.index_of(current)
        if index is None:
            return f"- / {len(self.entries)}"
        return f"{index + 1} / {len(self.entries)}"
