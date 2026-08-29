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

interface Template {
  id: string
  label: string
  /** What the operator should expect to see move, in plain language. */
  expect: string
  /** The starting-point override this template fills the controls with. */
  build: () => BehaviorPayload | null
}

/**
 * Templates are pre-filled targeting setups. Every id below is a real canonical event or
 * route from the catalog; the backend drops anything it does not recognise. Numbers scale
 * the generator's baseline rates (BASELINE_BEHAVIOR in simulationBehavior.ts).
 */
export const TEMPLATES: Template[] = [
  {
    id: "baseline",
    label: "Baseline — no change",
    expect: "Normal traffic. Use this to establish history before introducing a movement.",
    build: () => null,
  },
  {
    id: "kyc_drop_segment",
    label: "KYC completions fall — mobile users in India",
    expect:
      "loan.kyc_completed.success thinned to ~20%, scoped to device_type=mobile AND location=India. Starts hold; loan applications dip downstream a few days later.",
    build: () => ({
      windowDays: 5,
      segment: { device_type: "mobile", location: "India" },
      targets: [{ kind: "event", id: "loan.kyc_completed.success", traffic: 0.2 }],
    }),
  },
  {
    id: "kyc_drop_global",
    label: "KYC completions fall — all traffic",
    expect:
      "loan.kyc_completed.success thinned everywhere, with no single segment to blame — a harder case to explain than the scoped one.",
    build: () => ({
      windowDays: 5,
      targets: [{ kind: "event", id: "loan.kyc_completed.success", traffic: 0.25 }],
    }),
  },
  {
    id: "kyc_failures",
    label: "KYC verification fails more often (rejections)",
    expect:
      "Starts hold steady but loan.kyc failures rise ~4x and completions fall, so the funnel narrows at verification rather than at entry.",
    build: () => ({
      windowDays: 5,
      targets: [{ kind: "event", id: "loan.kyc.failure", failure: 4 }],
    }),
  },
  {
    id: "approval_slowdown",
    label: "Loan approvals slow down",
    expect:
      "loan.approved.success thinned to ~25% while loan.applied.success holds (a reduction does not drag its funnel down), so the drop is at the approval step, not demand.",
    build: () => ({
      windowDays: 6,
      targets: [{ kind: "event", id: "loan.approved.success", traffic: 0.25 }],
    }),
  },
  {
    id: "demand_spike",
    label: "Loan demand spikes",
    expect:
      "loan.applied.success x4; the KYC steps that feed it rise proportionally (safeguard on), and approvals follow at the usual rate.",
    build: () => ({
      windowDays: 5,
      targets: [{ kind: "event", id: "loan.applied.success", traffic: 4 }],
    }),
  },
  {
    id: "shift_mobile",
    label: "Population shifts to mobile",
    expect:
      "The device mix moves without any rate changing. Aggregate KPIs may barely move while the population underneath them changes — a genuinely harder inference.",
    build: () => ({ windowDays: 6, mix: { deviceWeights: { mobile: 9, desktop: 1, tablet: 1 } } }),
  },
  {
    id: "shift_india",
    label: "Population shifts to India",
    expect: "The geography mix concentrates on location=India, again with no rate change.",
    build: () => ({ windowDays: 6, mix: { countryWeights: { India: 9, USA: 1, "United Kingdom": 1 } } }),
  },
  {
    id: "pro_collapse",
    label: "Pro conversions collapse",
    expect:
      "features.unlock failure raised ~6x, so far fewer users go pro and pro_revenue falls downstream. Its figures are modelled per conversion — the event count is the real quantity.",
    build: () => ({
      windowDays: 5,
      targets: [{ kind: "event", id: "features.unlock.failed", failure: 6 }],
    }),
  },
  {
    id: "pro_errors",
    label: "Pro feature errors spike",
    expect:
      "Failure raised ~6x on every pro feature route, so .failure events rise sharply against flat .success events — the split between them is the signal.",
    build: () => ({
      windowDays: 4,
      targets: [
        { kind: "route", id: "/pro-feature?id=crypto-trading", failure: 6 },
        { kind: "route", id: "/pro-feature?id=wealth-management-pro", failure: 6 },
        { kind: "route", id: "/pro-feature?id=bulk-payroll-processing", failure: 6 },
        { kind: "route", id: "/pro-feature?id=ai-insights", failure: 6 },
      ],
    }),
  },
  {
    id: "role_violations",
    label: "Unauthorized access burst",
    expect:
      "auth.role.violation (baseline rate 0) injected in volume with the realism safeguard OFF — a categorical anomaly unconnected to normal traffic.",
    build: () => ({
      windowDays: 3,
      targets: [{ kind: "event", id: "auth.role.violation", traffic: 12 }],
      relaxJourney: true,
    }),
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
