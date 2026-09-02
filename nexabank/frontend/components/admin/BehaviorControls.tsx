"use client"

/**
 * Behaviour controls for the admin simulation console.
 *
 * Everything an operator can change is expressed as ROUTE / EVENT TARGETING: dial a
 * specific route or event up or down for traffic and, independently, for failure. A
 * template is just a named starting point that fills these controls in; the operator can
 * then edit every target, the window, the segment, and the realism safeguard before running.
 *
 * The one thing targeting cannot express is POPULATION MIX -- biasing the device / country
 * mix of the generated sessions without touching any rate. That has its own small editor
 * and its own two templates.
 *
 * Nothing here is recorded as ground truth. The only trace a change leaves is the shape of
 * the events in events_raw; the API response echoes the resolved override back for display
 * and never persists it.
 *
 *   - Window: the change applies only to the last N days. Earlier days run at baseline, so
 *     there is something for the movement to be measured against.
 *   - Segment: the change can be confined to e.g. mobile traffic from India, so the movement
 *     concentrates in one cell. Scopes targets AND mix.
 *   - Journey realism safeguard (on by default): a targeted event still only fires when its
 *     real prerequisites have occurred, and raising a target's traffic raises its upstream
 *     funnel proportionally. Turn it OFF to produce an anomaly / exploit shape.
 */

import { useMemo, useState, type ChangeEvent } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { ShieldAlert, Plus, X } from "lucide-react"

export interface BehaviorTarget {
  kind: "event" | "route"
  id: string
  /** Multiplier on how often the target (and, unless the safeguard is off, its upstream
   *  funnel when raised) fires. <1 thins it, >1 amplifies or introduces it. */
  traffic?: number
  /** Multiplier on the target's failure rate. */
  failure?: number
}

export interface BehaviorPayload {
  windowDays: number
  segment?: { device_type?: string; location?: string }
  /** Population mix bias -- the one non-targeting axis. */
  mix?: {
    deviceWeights?: Record<string, number>
    countryWeights?: Record<string, number>
    channelWeights?: Record<string, number>
  }
  /** Per-route / per-event traffic & failure multipliers. */
  targets?: BehaviorTarget[]
  /** When true, the journey-consistency safeguard is off for the targeted routes/events. */
  relaxJourney?: boolean
}

/** Shape returned by GET /events/simulate/catalog. */
export interface SimCatalog {
  routes: { id: string; label: string }[]
  events: { id: string; route: string; label: string; kind: string; proGated: boolean }[]
}

/**
 * Run settings a template needs beyond the behavior block itself.
 *
 * A movement is only measurable against history the SAME customers generated, and fast mode keys
 * a generated application on (customer, date). So a paired before/after demo has to re-run the
 * same `seed`: without one, the second run writes a fresh set of customer-days and leaves the
 * first run's approvals in place, which dilutes the movement instead of replacing it. That is why
 * running a collapse template five times appeared to change nothing.
 */
export interface TemplateRun {
  /** Fixed RNG seed. Two templates sharing one seed generate the same customer-days. */
  seed?: number
  /** Clear these tables first. Scoped so a single-KPI reset spares the other metrics' history. */
  purgeTables?: string[]
  count?: number
  days?: number
  /** Generation passes. One pass can leave a KPI under its contract's min_denominator. */
  passes?: number
}

export interface Template {
  id: string
  label: string
  /** What the operator should expect to see move, in plain language. */
  expect: string
  /** The starting-point override this template fills the controls with. */
  build: () => BehaviorPayload | null
  /**
   * The banking-fact template this plants, from nexabank/src/simulate/templates.ts.
   *
   * Present means the run rebuilds FACTS -- the source every KPI value comes from -- rather than
   * only emitting a clickstream, which cannot move a KPI at all.
   */
  factTemplate?: string
  /** Fast-mode run settings this template needs. Applied to the controls on selection. */
  run?: TemplateRun
}

/**
 * One template per governed KPI, plus a baseline and a false-positive check.
 *
 * The previous list targeted CLICKSTREAM events. Per docs/DATA_MODEL.md every KPI value comes
 * from the daily banking snapshot and the clickstream is behavioural context, so those templates
 * could not move a single number on the dashboard however hard they were aimed -- and a run of
 * twenty users could not shift a metric computed over four thousand customers in any case.
 *
 * Each of these names a `factTemplate` instead: the run rebuilds the banking facts with that
 * anomaly applied, so the movement exists in the source the KPIs are actually built from. The
 * engine still has to find it.
 */
export const TEMPLATES: Template[] = [
  {
    id: "baseline",
    label: "Baseline — no change",
    expect:
      "Rebuilds the bank with no movement planted. Every KPI should read inside its expected " +
      "range and the agent should report nothing material. Record this as the BEFORE state.",
    build: () => null,
    factTemplate: "baseline",
  },
  {
    id: "kyc_leak_single_region",
    label: "KYC completion falls — one region",
    expect:
      "Onboarding leaks in Europe for nine days. KYC Completion Rate drops below its band and " +
      "Localize should name the region rather than spreading the cause across the cube.",
    build: () => null,
    factTemplate: "kyc_leak_single_region",
  },
  {
    id: "failure_burst",
    label: "Transaction failures spike",
    expect:
      "A payments incident over the last seven days. Transaction Failure Rate rises sharply and " +
      "is graded urgent; fee revenue follows it down.",
    build: () => null,
    factTemplate: "failure_burst",
  },
  {
    id: "loan_demand_spike",
    label: "Loan demand spikes",
    expect:
      "Applications surge for ten days and approvals follow. Loan Approval Volume rises above " +
      "its band with no fault anywhere in the funnel.",
    build: () => null,
    factTemplate: "loan_demand_spike",
  },
  {
    id: "spend_slump_region",
    label: "Revenue falls — one region",
    expect:
      "Card spend in Asia collapses to under half for a fortnight. Revenue falls with no cause " +
      "inside the onboarding funnel, which is what makes it a revenue story and not a KYC one.",
    build: () => null,
    factTemplate: "spend_slump_region",
  },
  {
    id: "signup_slowdown",
    label: "New account signups slow",
    expect:
      "Fewer accounts opened over the last ten days, with nothing wrong downstream. New Account " +
      "Signups falls while KYC and approvals hold.",
    build: () => null,
    factTemplate: "signup_slowdown",
  },
  {
    id: "noise_only",
    label: "Noise only — nothing planted",
    expect:
      "Variance without a level change. The engine must NOT report an anomaly; this is the " +
      "false-positive check, and a finding here is a bug.",
    build: () => null,
    factTemplate: "noise_only",
  },
]

const DEVICE_KEYS = ["mobile", "desktop", "tablet"]
const COUNTRY_KEYS = ["India", "USA", "United Kingdom", "Germany", "Japan"]

interface BehaviorControlsProps {
  value: BehaviorPayload | null
  onChange: (next: BehaviorPayload | null) => void
  templateId: string
  onTemplateChange: (id: string) => void
  catalog: SimCatalog | null
  disabled?: boolean
}

export function BehaviorControls({
  value,
  onChange,
  templateId,
  onTemplateChange,
  catalog,
  disabled,
}: BehaviorControlsProps) {
  const [showSegment, setShowSegment] = useState(false)
  const [showTargeting, setShowTargeting] = useState(false)
  const [showMix, setShowMix] = useState(false)

  const active = useMemo(
    () => TEMPLATES.find((t) => t.id === templateId) ?? TEMPLATES[0],
    [templateId]
  )

  const targets = value?.targets ?? []
  const safeguardOn = !(value?.relaxJourney === true)
  const mix = value?.mix ?? {}
  const hasMix =
    Object.keys(mix.deviceWeights ?? {}).length > 0 ||
    Object.keys(mix.countryWeights ?? {}).length > 0 ||
    Object.keys(mix.channelWeights ?? {}).length > 0

  const handleTemplate = (id: string) => {
    onTemplateChange(id)
    const template = TEMPLATES.find((t) => t.id === id)
    const next = template ? template.build() : null
    onChange(next)
    if (next?.targets?.length || next?.relaxJourney) setShowTargeting(true)
    if (next?.mix) setShowMix(true)
    if (next?.segment) setShowSegment(true)
  }

  // Every mutation goes through here so `value` is created if it does not exist yet, and
  // collapses back to null once nothing is actually set.
  const commit = (next: Partial<BehaviorPayload>) => {
    const merged: BehaviorPayload = {
      windowDays: value?.windowDays ?? 5,
      ...value,
      ...next,
    }
    const nothingSet =
      !(merged.targets && merged.targets.length) &&
      !merged.relaxJourney &&
      !merged.mix
    onChange(nothingSet ? null : merged)
  }

  const patchWindow = (e: ChangeEvent<HTMLInputElement>) => {
    if (!value) return
    onChange({ ...value, windowDays: Math.max(1, Math.min(Number(e.target.value) || 1, 60)) })
  }

  const patchSegment = (key: "device_type" | "location", raw: string) => {
    const segment = { ...(value?.segment || {}) }
    if (raw.trim()) segment[key] = raw.trim()
    else delete segment[key]
    commit({ segment: Object.keys(segment).length ? segment : undefined })
  }

  const setTargets = (nextTargets: BehaviorTarget[], relax = value?.relaxJourney) => {
    commit({
      targets: nextTargets.length ? nextTargets : undefined,
      relaxJourney: relax ? true : undefined,
    })
  }

  const addTarget = () => {
    setTargets([...targets, { kind: "event", id: catalog?.events[0]?.id ?? "", traffic: 1, failure: 1 }])
  }

  const updateTarget = (idx: number, patch: Partial<BehaviorTarget>) => {
    const next = targets.map((t, i) => (i === idx ? { ...t, ...patch } : t))
    if (patch.kind) {
      next[idx].id = patch.kind === "route" ? catalog?.routes[0]?.id ?? "" : catalog?.events[0]?.id ?? ""
    }
    setTargets(next)
  }

  const removeTarget = (idx: number) => setTargets(targets.filter((_, i) => i !== idx))
  const toggleSafeguard = (on: boolean) => setTargets(targets, !on)

  const patchMix = (group: "deviceWeights" | "countryWeights", key: string, raw: string) => {
    const n = Number(raw)
    const g = { ...(mix[group] || {}) }
    if (Number.isFinite(n) && n > 0) g[key] = n
    else delete g[key]
    const nextMix = { ...mix }
    if (Object.keys(g).length) nextMix[group] = g
    else delete nextMix[group]
    commit({ mix: Object.keys(nextMix).length ? nextMix : undefined })
  }

  const clampMul = (raw: string): number => {
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) return 1
    return Math.min(n, 20)
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label className="text-xs font-black uppercase text-zinc-400">Template</Label>
        <Select value={templateId} onValueChange={handleTemplate} disabled={disabled}>
          <SelectTrigger className="h-12 rounded-2xl font-bold border-zinc-100">
            <SelectValue placeholder="Pick a template" />
          </SelectTrigger>
          <SelectContent className="rounded-2xl border-zinc-100 max-h-[380px]">
            {TEMPLATES.map((t) => (
              <SelectItem key={t.id} value={t.id} className="font-bold">
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-zinc-500 font-medium leading-relaxed">{active.expect}</p>
        <p className="text-[11px] text-zinc-400 font-medium">
          A template fills the controls below. Edit anything before running — the run uses
          what the controls say, not the template.
        </p>
      </div>

      {value && (
        <div className="space-y-2">
          <Label className="text-xs font-black uppercase text-zinc-400">Change window (days)</Label>
          <Input
            type="number"
            min={1}
            max={60}
            value={value.windowDays}
            onChange={patchWindow}
            disabled={disabled}
            className="h-12 rounded-2xl font-bold border-zinc-100"
          />
          <p className="text-xs text-zinc-500 font-medium">
            Applies to the most recent N days only. Earlier days generate at baseline — without
            that history there is nothing for the change to be measured against.
          </p>
        </div>
      )}

      {/* ── Route / event targeting ──────────────────────────────────────────── */}
      <div className="pt-3 border-t border-zinc-100">
        <button
          type="button"
          onClick={() => setShowTargeting((p) => !p)}
          className="text-xs font-black uppercase text-violet-600 hover:text-violet-800 cursor-pointer"
        >
          {showTargeting ? "Hide" : "Show"} route &amp; event targeting
          {(targets.length > 0 || !safeguardOn) && (
            <span className="ml-2 inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-[10px] text-violet-700">
              {targets.length > 0 ? `${targets.length} target${targets.length > 1 ? "s" : ""}` : ""}
              {!safeguardOn ? (targets.length > 0 ? " · realism off" : "realism off") : ""}
            </span>
          )}
        </button>

        {showTargeting && (
          <div className="mt-3 space-y-4">
            <p className="text-xs text-zinc-600 font-medium leading-relaxed">
              Dial one route or event up or down for traffic and, separately, for failure.
              Only routes and events the simulator can actually produce are offered.
            </p>

            {!catalog && (
              <p className="text-xs text-amber-600 font-semibold">Loading target vocabulary…</p>
            )}

            {targets.map((t, idx) => (
              <div key={idx} className="space-y-3 border border-violet-100 rounded-2xl p-4 bg-violet-50/40">
                <div className="flex items-center gap-2">
                  <Select
                    value={t.kind}
                    onValueChange={(v: string) => updateTarget(idx, { kind: v as "event" | "route" })}
                    disabled={disabled}
                  >
                    <SelectTrigger className="h-10 w-28 rounded-xl font-bold border-zinc-100 bg-white text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="rounded-xl border-zinc-100">
                      <SelectItem value="event" className="font-bold">Event</SelectItem>
                      <SelectItem value="route" className="font-bold">Route</SelectItem>
                    </SelectContent>
                  </Select>
                  <button
                    type="button"
                    onClick={() => removeTarget(idx)}
                    disabled={disabled}
                    className="ml-auto text-zinc-400 hover:text-red-500 cursor-pointer"
                    aria-label="Remove target"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <Select
                  value={t.id}
                  onValueChange={(v: string) => updateTarget(idx, { id: v })}
                  disabled={disabled || !catalog}
                >
                  <SelectTrigger className="h-10 rounded-xl font-bold border-zinc-100 bg-white text-xs">
                    <SelectValue placeholder="Pick a target" />
                  </SelectTrigger>
                  <SelectContent className="rounded-xl border-zinc-100 max-h-[320px]">
                    {t.kind === "route"
                      ? (catalog?.routes ?? []).map((r) => (
                          <SelectItem key={r.id} value={r.id} className="font-bold">
                            {r.label} <span className="text-zinc-400">({r.id})</span>
                          </SelectItem>
                        ))
                      : (catalog?.events ?? []).map((ev) => (
                          <SelectItem key={ev.id} value={ev.id} className="font-bold">
                            {ev.label} <span className="text-zinc-400">({ev.id})</span>
                          </SelectItem>
                        ))}
                  </SelectContent>
                </Select>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-[10px] font-black uppercase text-zinc-400">Traffic ×</Label>
                    <Input
                      type="number" step="0.1" min={0} max={20}
                      value={t.traffic ?? 1}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => updateTarget(idx, { traffic: clampMul(e.target.value) })}
                      disabled={disabled}
                      className="h-10 rounded-xl font-bold border-zinc-100 bg-white text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] font-black uppercase text-zinc-400">Failure ×</Label>
                    <Input
                      type="number" step="0.1" min={0} max={20}
                      value={t.failure ?? 1}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => updateTarget(idx, { failure: clampMul(e.target.value) })}
                      disabled={disabled}
                      className="h-10 rounded-xl font-bold border-zinc-100 bg-white text-xs"
                    />
                  </div>
                </div>
                <p className="text-[11px] text-zinc-500 font-medium">
                  1× leaves it unchanged. Traffic and failure move independently.
                </p>
              </div>
            ))}

            <button
              type="button"
              onClick={addTarget}
              disabled={disabled || !catalog}
              className="inline-flex items-center gap-1.5 text-xs font-black uppercase text-violet-600 hover:text-violet-800 cursor-pointer disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" /> Add target
            </button>

            <div
              className={`flex items-start gap-3 rounded-2xl border p-4 ${
                safeguardOn ? "border-zinc-100 bg-white" : "border-amber-300 bg-amber-50"
              }`}
            >
              <Switch checked={safeguardOn} onCheckedChange={toggleSafeguard} disabled={disabled} className="mt-0.5" />
              <div className="space-y-1">
                <p className="text-xs font-black uppercase text-zinc-700 flex items-center gap-1.5">
                  {!safeguardOn && <ShieldAlert className="h-3.5 w-3.5 text-amber-600" />}
                  Journey realism safeguard {safeguardOn ? "ON" : "OFF"}
                </p>
                <p className="text-[11px] text-zinc-500 font-medium leading-relaxed">
                  {safeguardOn
                    ? "Targeted events still fire only when their real prerequisites have occurred, and raising a target's traffic raises its upstream funnel proportionally."
                    : "Targeted routes/events move independently of their prerequisites and dependents — a downstream spike with no upstream rise, or a sensitive-event burst. Use deliberately to shape an anomaly / exploit run."}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Segment scope ────────────────────────────────────────────────────── */}
      <div className="pt-3 border-t border-zinc-100">
        <button
          type="button"
          onClick={() => setShowSegment((p) => !p)}
          className="text-xs font-black uppercase text-violet-600 hover:text-violet-800 cursor-pointer"
        >
          {showSegment ? "Hide" : "Show"} segment scope
          {value?.segment && Object.keys(value.segment).length > 0 && (
            <span className="ml-2 inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-[10px] text-violet-700">
              {Object.entries(value.segment).map(([k, v]) => `${k}=${v}`).join(" · ")}
            </span>
          )}
        </button>
        {showSegment && (
          <div className="mt-3 space-y-4 border border-violet-100 rounded-2xl p-4 bg-violet-50/40">
            <p className="text-xs text-zinc-600 font-medium leading-relaxed">
              Confine the targets and mix to matching sessions. Leave blank to affect all
              traffic. Scoping is what gives root-cause analysis something to find.
            </p>
            <div className="space-y-2">
              <Label className="text-xs font-black uppercase text-zinc-400">device_type</Label>
              <Input
                placeholder="mobile / desktop / tablet"
                value={value?.segment?.device_type || ""}
                onChange={(e: ChangeEvent<HTMLInputElement>) => patchSegment("device_type", e.target.value)}
                disabled={disabled}
                className="h-11 rounded-2xl font-bold border-zinc-100 bg-white"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs font-black uppercase text-zinc-400">location (country)</Label>
              <Input
                placeholder="India / USA / United Kingdom"
                value={value?.segment?.location || ""}
                onChange={(e: ChangeEvent<HTMLInputElement>) => patchSegment("location", e.target.value)}
                disabled={disabled}
                className="h-11 rounded-2xl font-bold border-zinc-100 bg-white"
              />
              <p className="text-[11px] text-zinc-500 font-medium">
                `location` holds a country value. There is no `country` dimension.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ── Population mix ───────────────────────────────────────────────────── */}
      <div className="pt-3 border-t border-zinc-100">
        <button
          type="button"
          onClick={() => setShowMix((p) => !p)}
          className="text-xs font-black uppercase text-violet-600 hover:text-violet-800 cursor-pointer"
        >
          {showMix ? "Hide" : "Show"} population mix
          {hasMix && (
            <span className="ml-2 inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-[10px] text-violet-700">
              active
            </span>
          )}
        </button>
        {showMix && (
          <div className="mt-3 space-y-4 border border-violet-100 rounded-2xl p-4 bg-violet-50/40">
            <p className="text-xs text-zinc-600 font-medium leading-relaxed">
              Relative weights over the device / country a generated session picks. Blank =
              use the default mix. This changes who is in the population, not any rate.
            </p>
            <div className="space-y-2">
              <Label className="text-xs font-black uppercase text-zinc-400">device weight</Label>
              <div className="grid grid-cols-3 gap-2">
                {DEVICE_KEYS.map((k) => (
                  <div key={k} className="space-y-1">
                    <span className="text-[10px] font-bold text-zinc-500">{k}</span>
                    <Input
                      type="number" min={0} step="1"
                      value={mix.deviceWeights?.[k] ?? ""}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => patchMix("deviceWeights", k, e.target.value)}
                      disabled={disabled}
                      className="h-10 rounded-xl font-bold border-zinc-100 bg-white text-xs"
                    />
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-xs font-black uppercase text-zinc-400">country weight</Label>
              <div className="grid grid-cols-2 gap-2">
                {COUNTRY_KEYS.map((k) => (
                  <div key={k} className="space-y-1">
                    <span className="text-[10px] font-bold text-zinc-500">{k}</span>
                    <Input
                      type="number" min={0} step="1"
                      value={mix.countryWeights?.[k] ?? ""}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => patchMix("countryWeights", k, e.target.value)}
                      disabled={disabled}
                      className="h-10 rounded-xl font-bold border-zinc-100 bg-white text-xs"
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
