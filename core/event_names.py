"""
The ingest dialect of the event taxonomy, with no third-party imports.

This is the single implementation of what `POST /events` does to an event name.
`core/models.py` delegates its `FeatureEvent.validate_event_name` validator here so
there is exactly one copy of the rules; nothing reimplements them.

It lives apart from `models.py` so tooling can exercise the dialect without importing
pydantic. CLAUDE.md requires taxonomy claims to be verified by *running* the function,
and a checker that cannot import the function ends up reimplementing it -- which is how
the three dialects drifted apart in the first place (coupling point 2).

Note this dialect COERCES rather than rejects: an unrecognised name is wrapped as
`core.<name>.action`, not refused. The failure mode is a silent rename.
"""
import re

# Strict [page].[feature].[status], exactly three lowercase segments.
TAXONOMY_REGEX = re.compile(r'^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$')
# Legacy flat name (e.g. login, view_feed).
LEGACY_REGEX = re.compile(r'^[a-z][a-z0-9_]*$')

# Prefixes preserved as-is by this dialect. The Node dialect (enforceTaxonomy) STRIPS
# these instead, which is why `pro.new_feature.view` resolves differently depending on
# whether the producer went through the NexaBank backend or posted straight to ingestion.
PRESERVED_PREFIXES = {'free', 'pro', 'core', 'enterprise', 'lending'}

_SUFFIX_STATUS = {
    '_success': 'success',
    '_failed': 'failed',
    '_error': 'failed',
    '_view': 'view',
    '_access': 'success',
    '_action': 'action',
}


def normalize_status(status: str) -> str:
    s = re.sub(r'[^a-z0-9_]', '_', status or '').strip('_')
    if s in {'error', 'fail'}:
        return 'failed'
    if s == 'viewed':
        return 'view'
    if s == 'access':
        return 'success'
    return s or 'action'


def normalize_part(part: str) -> str:
    p = re.sub(r'[^a-z0-9_]', '_', part or '').strip('_')
    return p or 'core'


def split_feature_status(token: str) -> tuple[str, str]:
    t = normalize_part(token)
    for suffix, status in _SUFFIX_STATUS.items():
        if t.endswith(suffix) and len(t) > len(suffix):
            return normalize_part(t[:-len(suffix)]), status
    return t, 'action'


def normalize_ingest_event_name(value: str) -> str:
    """Return the name `POST /events` will store for `value`.

    Raises ValueError only when even the `core.<name>.action` fallback cannot be formed.
    """
    raw = value.strip().lower().replace('-', '_')

    if TAXONOMY_REGEX.match(raw):
        page, feature, status = raw.split('.')
        if page in PRESERVED_PREFIXES:
            # Preserve prefixed 3-part events as-is (with a normalized status).
            # Historical analytics aliases rely on keys like `free.dashboard.view`.
            return f"{normalize_part(page)}.{normalize_part(feature)}.{normalize_status(status)}"
        if page == 'auth' and feature in {'login', 'register'}:
            return f"{feature}.auth.{normalize_status(status)}"
        return f"{normalize_part(page)}.{normalize_part(feature)}.{normalize_status(status)}"

    if LEGACY_REGEX.match(raw):
        return f"core.{raw}.action"

    parts = [p for p in raw.split('.') if p]
    while len(parts) >= 3 and parts[0] in PRESERVED_PREFIXES:
        parts = parts[1:]

    if len(parts) == 3 and parts[0] == 'auth' and parts[1] in {'login', 'register'}:
        return f"{parts[1]}.auth.{normalize_status(parts[2])}"

    if len(parts) == 2:
        page = normalize_part(parts[0])
        feature, status = split_feature_status(parts[1])
        candidate = f"{page}.{feature}.{normalize_status(status)}"
        if TAXONOMY_REGEX.match(candidate):
            return candidate

    if len(parts) >= 3:
        page = normalize_part(parts[0])
        status = normalize_status(parts[-1])
        feature = normalize_part('_'.join(parts[1:-1])) or 'action'
        candidate = f"{page}.{feature}.{status}"
        if TAXONOMY_REGEX.match(candidate):
            return candidate

    fallback = f"core.{normalize_part(raw)}.action"
    if TAXONOMY_REGEX.match(fallback):
        return fallback

    raise ValueError(
        f"Invalid event_name '{value}'. Must normalize to strict 'page.feature.status' taxonomy."
    )
