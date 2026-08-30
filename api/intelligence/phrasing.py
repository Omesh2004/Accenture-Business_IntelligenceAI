"""How a stored figure reads in English.

Phrasing only. Nothing here computes, rounds or reconciles a number -- it receives values that a
stage already produced and a claim already records, and decides how they are said.

It exists because the readable form of a figure has to be decided in ONE place. `txn_type=PAYMENT`
appearing as "payment transactions" in the attribution sentence and as `txn_type=PAYMENT` in the
evidence card is two descriptions of one row, and a reader who notices the difference has no way
to tell which is the real one.

Three things get said badly by default and are handled here:

  * a dimension cell, which is stored as a `{key: value}` map and reads as machine output;
  * the unit of the scored figure, which for a RATIO contract is not the contract's own unit --
    Detect scores an additive fundamental, so "97" is 97 transactions, not 97 percent;
  * the relationship between ranked cells, which a greedy cube emits NESTED. Their shares are
    each measured against the whole movement, so a list of them invites an addition that is
    wrong. See `overlap_note`.
"""
from __future__ import annotations

from datetime import date, datetime

# Standalone phrase per physical metadata key, written to read after "in" -- which is the frame
# every caller uses ("concentrates in ...", "the movement in ..."). `case` normalises the stored
# value: banking facts store enums upper-case and regions title-case.
#
# An unlisted key falls back to "<key> <value>", which reads plainly rather than wrongly.
_DIMENSION: dict[str, tuple[str, str]] = {
    "txn_type": ("%s transactions", "lower"),
    "category": ("the %s category", "lower"),
    "channel": ("the %s channel", "lower"),
    "device_type": ("%s devices", "lower"),
    "status": ("%s transactions", "lower"),
    "direction": ("%s transactions", "lower"),
    "tier": ("the %s tier", "lower"),
    "product": ("the %s product", "asis"),
    "segment": ("the %s segment", "asis"),
    "customer_segment": ("the %s segment", "asis"),
    "merchant_name": ("%s", "asis"),
    "mcc": ("merchant category %s", "asis"),
    "region": ("the %s region", "asis"),
    "branch_code": ("branch %s", "asis"),
    "city": ("%s", "asis"),
    "location": ("%s", "asis"),
    "continent": ("%s", "asis"),
}

# Keys that name WHERE rather than WHAT. A cell mixing the two reads as "<what> in <where>".
_PLACE = frozenset({"region", "branch_code", "city", "location", "continent"})


def dimension_phrase(key: str, value: str) -> str:
    """One `key=value` pair as a noun phrase that reads after "in"."""
    value = str(value).strip()
    if not value:
        return str(key).replace("_", " ")
    template, case = _DIMENSION.get(key, ("", "asis"))
    if case == "lower":
        value = value.lower()
    if not template:
        # `<thing>_type` is the commonest shape in banking facts and reads naturally pluralised:
        # account_type=SAVINGS -> "savings accounts". Keys with their own entry never reach here.
        if key.endswith("_type") and len(key) > 5:
            return "%s %ss" % (value.lower(), key[:-5].replace("_", " "))
        return "%s %s" % (str(key).replace("_", " "), value)
    return template % value


def cell_phrase(dimensions: dict) -> str:
    """A whole localisation cell as one phrase: "payment transactions in the Europe region"."""
    if not dimensions:
        return "the tenant as a whole"
    what = [dimension_phrase(k, v) for k, v in sorted(dimensions.items()) if k not in _PLACE]
    where = [dimension_phrase(k, v) for k, v in sorted(dimensions.items()) if k in _PLACE]
    if what and where:
        return "%s in %s" % (join(what), join(where))
    return join(what or where)


def join(parts: list[str]) -> str:
    """Readable list: "a, b and c". Used wherever ranked items are read out."""
    if len(parts) <= 1:
        return parts[0] if parts else ""
    return "%s and %s" % (", ".join(parts[:-1]), parts[-1])


def overlap_note(causes: list[dict]) -> str:
    """Warn when the shown cells are NESTED, so a reader does not add them up.

    A greedy cube emits `{txn_type=PAYMENT}` and `{region=Northeast, txn_type=PAYMENT}` as separate
    ranks; the second is a subset of the first and its rows are counted in both. Cumulative
    `explained_pct` passing 1.0 is the symptom -- it reached 2.07 on live data -- but nesting is
    detected structurally here rather than by trusting that number.

    Returns "" when the cells are genuinely disjoint, because a warning nobody needs is noise.
    """
    sets = [frozenset((k, str(v)) for k, v in (c.get("dimensions") or {}).items()) for c in causes]
    nested = [(a, b) for i, a in enumerate(sets) for b in sets[i + 1:]
              if a and b and (a < b or b < a)]
    if not nested:
        return ""
    inner, outer = (nested[0][0], nested[0][1]) if len(nested[0][0]) < len(nested[0][1]) \
        else (nested[0][1], nested[0][0])
    # No numeral in this sentence, deliberately: the numeric verifier rejects any figure that does
    # not trace to a stored row, and a literal "100%" in a caveat about arithmetic is exactly the
    # kind of number nothing measured.
    return ("These segments overlap rather than divide the movement between them: %s sits inside "
            "%s, and rows in it are counted in both. Each share is measured against the whole "
            "movement, so they are not meant to sum."
            % (cell_phrase(dict(outer)), cell_phrase(dict(inner))))


def window_phrase(start, end) -> str:
    """The scored window as a reader would say it. `end` is exclusive, so the last day is end-1."""
    s, e = _as_date(start), _as_date(end)
    if not s or not e:
        return ""
    last = date.fromordinal(max(e.toordinal() - 1, s.toordinal()))
    days = last.toordinal() - s.toordinal() + 1
    if days <= 1:
        return "%d %s %d" % (last.day, last.strftime("%B"), last.year)
    # Length plus end date fixes the period exactly, so naming the start as well is clutter.
    return "the %d days to %d %s %d" % (days, last.day, last.strftime("%B"), last.year)


def _as_date(value):
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return datetime.fromisoformat(str(value)).date()
    except (TypeError, ValueError):
        return None


# ── what the scored number actually counts ─────────────────────────────────────────────────────
def scored_measure(kpi_id: str) -> tuple[str, str, bool]:
    """(what the scored figure counts, its cadence, whether that differs from the KPI).

    Detect scores an ADDITIVE fundamental, never a rate -- a ratio cannot be re-aggregated. For
    `digital_adoption_rate` that fundamental is `digital_transactions`, so the stored observed
    value of 97 is 97 transactions a day and reads as nonsense against a contract whose declared
    unit is `ratio`. The third element says the figure is a proxy, and every caller that states
    the number is expected to say so too.
    """
    try:
        from api.intelligence.contracts import load_declared
        contract = load_declared().get(kpi_id)
    except Exception:                                               # noqa: BLE001
        return "", "", False
    if contract is None:
        return "", "", False
    # A ratio with a usable denominator is scored on the rate itself, so there is no proxy to
    # declare and no per-day noun: the figure is the KPI. Only a malformed ratio still falls
    # back to its numerator, and that case is what the proxy wording exists for.
    if contract.is_ratio and contract.denominator():
        return "", "", False
    measure = str((contract.scored_fundamental or {}).get("metric") or "").replace("_", " ")
    cadence = str((contract.raw.get("grain") or {}).get("time") or "")
    unit = str(contract.raw.get("unit") or "")
    proxy = bool(measure) and unit in ("ratio", "percent")
    return measure, cadence, proxy


_PER = {"daily": "per day", "hourly": "per hour", "weekly": "per week", "monthly": "per month"}


def quantity(value: float, measure: str, cadence: str) -> str:
    """A bare figure given back its noun: "97 digital transactions per day"."""
    body = ("%.2f" % value).rstrip("0").rstrip(".")
    if measure:
        body += " %s" % measure
    per = _PER.get(cadence, "")
    return "%s %s" % (body, per) if per else body


def severity_clause(severity: str) -> str:
    return {"urgent": "It is graded urgent, the highest severity this platform assigns.",
            "warn": "It is graded a warning rather than urgent.",
            "info": "It is graded informational."}.get(str(severity).lower(), "")
