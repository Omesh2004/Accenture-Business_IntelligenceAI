# KPI_CONTRACT.md

The KPI contract is the keystone of Phase 1: one governed YAML definition per KPI that three
things read from. It is deliberately a flat YAML file plus a small loader, not a semantic-layer
product (no Cube, no dbt). Contracts live in `contracts/*.yaml`, versioned in git.

## Who reads it

- **Evidence card** reads `lineage`, `source`, `formula`, `freshness_sla_minutes`.
- **Materiality scorer** reads `strategic_weight` and `thresholds`.
- **Entitlement filter** reads `access_restriction` to decide which persona may receive the card.
- **Localize** reads `additivity` and `ratio` to refuse running directly on a ratio (it must
  decompose on the additive numerator and denominator instead).
- **The narrator** may state a KPI only by its contract `definition`; there is no other sanctioned
  definition of the number.

## Schema

| Field | Meaning |
|---|---|
| `id` | Stable key. Matches `anomalies.kpi_id` and `insights` links. |
| `name` | Human label. |
| `definition` | One-sentence glossary term the narrator uses verbatim. |
| `formula` | How it is computed. |
| `grain` | The row grain (e.g. `daily`). |
| `additivity` | `additive` \| `semi-additive` \| `non-additive`. A ratio is non-additive; never sum it across time. |
| `source` | `{name, system, cadence}`. The originating source and its refresh cadence. |
| `ratio` | For ratios: `{numerator, denominator}`, each with its event and `additivity: additive`. |
| `dimensions` | Cube dimensions Localize may search. |
| `drivers` | Named upstream drivers (for the driver read and the KPI chain). |
| `thresholds` | `{warn, critical}` as direction + pct_change. Feeds Detect and materiality. |
| `strategic_weight` | 0..1. Business importance; multiplies impact in the materiality score. |
| `owner` | Accountable team. |
| `lineage` | `{events, endpoint, tables}` the evidence card cites. |
| `access_restriction` | `{visible_to: [personas/roles]}`. Drives entitlement. |
| `freshness_sla_minutes` | Max staleness before the composite-freshness rule caveats/abstains. |
| `interconnection` | `{drives: <kpi_id>}`. The connected-KPI chain. |

## The connected KPI chain (three KPIs, one story)

Phase 1 tells one interconnected story so a move in one KPI explains a move in the next:

```
kyc_completion_rate   (ratio, real-time clickstream)
        drives
loan_approval_volume  (additive, daily loan-state extract)
        drives
pro_revenue           (additive, daily)
```

Author `kyc_completion_rate` fully (worked example in `contracts/kyc_completion_rate.yaml`).
Author `loan_approval_volume` and `pro_revenue` as thinner contracts that reference it via
`interconnection.drives`. If the second source is not wired in time, derive the downstream two
from the same events within ClickHouse and keep the contracts honest about `source.cadence`.

## Rules

- Every KPI an insight mentions must have a contract. If a query is not covered by a defined
  metric, the pipeline abstains rather than inventing a definition.
- A ratio contract must carry its `ratio.numerator` and `ratio.denominator` so Localize runs on
  the additive fundamentals, not the rate.
- Changing a contract is a reviewed change, like a schema migration. Bump nothing silently;
  the evidence card shows the definition the number was computed under.
- Taxonomy caution: the event names in `ratio` and `lineage` must exist in all three taxonomy
  dialects (see `skills/event-taxonomy/SKILL.md`), or the funnel will read zero.
