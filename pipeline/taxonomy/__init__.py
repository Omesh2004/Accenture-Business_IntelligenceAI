"""The ONE event-name canonicalisation vocabulary, applied in the Silver transform.

`canonicalize(name) -> str | None`:
  - already a strict `page.feature.status` (after prefix-strip) -> returned as-is
  - an alias hit (`aliases.yaml`) -> the mapped canonical name
  - `None` (no match, OR an alias mapped to null = known-but-not-tracked) -> the caller
    dead-letters the row (`bronze.events_dead_letter`, stage `silver_taxonomy_reject`). It is
    NOT renamed and NOT propagated to `silver.events`.

No third-party imports beyond PyYAML at module load, so a data-quality checker can exercise it.
Ownership: Track B. A new instrumented name arrives as a PR against `aliases.yaml` (sync doc A6b).
"""
from __future__ import annotations

import os
import re

import yaml

# page.feature.status — three lowercase segments; hyphens allowed (canonical product slugs like
# `crypto-trading`), no spaces, no uppercase.
TAXONOMY_REGEX = re.compile(r"^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$")

PREFIXES = {"free", "pro", "core", "enterprise", "lending"}

_ALIASES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "aliases.yaml")
with open(_ALIASES_PATH, encoding="utf-8") as _f:
    ALIASES: dict[str, str | None] = {str(k).lower(): v for k, v in (yaml.safe_load(_f) or {}).items()}


def _strip_prefixes(name: str) -> str:
    parts = name.split(".")
    while len(parts) > 3 and parts[0] in PREFIXES:
        parts = parts[1:]
    return ".".join(parts)


def canonicalize(name: str) -> str | None:
    if not name:
        return None
    raw = name.strip().lower().replace(" ", "_")

    if raw in ALIASES:
        return ALIASES[raw]                       # str, or None = known reject

    stripped = _strip_prefixes(raw)
    if stripped in ALIASES:
        return ALIASES[stripped]

    if TAXONOMY_REGEX.match(stripped):
        return stripped                            # already canonical

    return None                                    # unresolved -> dead-letter


# Back-compat alias for callers that used the old name.
canonicalize_event_name = canonicalize
