"use client"

/**
 * Behaviour controls for the admin simulation console.
 *
 * Picking a scenario changes how the generated users BEHAVE, not what gets written about
 * them. Nothing records that a movement was introduced -- the only trace is the shape of the
 * events themselves, which is what makes this a fair test of an intelligence layer.
 *
 * Two properties make a change detectable, and both are surfaced here:
 *   - Window: the change applies only to the last N days. Earlier days run at baseline, so
 *     there is something for the movement to be measured against.
 *   - Segment: the change can be confined to e.g. mobile traffic from India, so the movement
 *     concentrates in one cell instead of shifting everything uniformly.
 */

import { useMemo, useState, type ChangeEvent } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export interface BehaviorPayload {
  windowDays: number
  segment?: { device_type?: string; location?: string }
  kyc?: { startRate?: number; progressMultiplier?: number; successRate?: number }
  loans?: { applicationMultiplier?: number; approvalRate?: number }
  mix?: {
    deviceWeights?: Record<string, number>
    countryWeights?: Record<string, number>
    channelWeights?: Record<string, number>
  }
  pro?: { conversionMultiplier?: number; errorRate?: number; roleViolationRate?: number }
}

interface Scenario {
  id: string
  label: string
  /** What the operator should expect to see move, in plain language. */
  expect: string
  build: () => BehaviorPayload | null
}

/**
 * Baselines mirror BASELINE_BEHAVIOR in the backend's simulationBehavior.ts. They are shown
 * so the operator can see what a knob is moving away from.
 */
export const SCENARIOS: Scenario[] = [
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
      "kyc_completion_rate drops sharply, concentrated in device_type=mobile AND location=India. Loan applications dip downstream a few days later.",
    build: () => ({
      windowDays: 5,
      segment: { device_type: "mobile", location: "India" },
      kyc: { progressMultiplier: 0.06 },
    }),
  },
  {
    id: "kyc_drop_global",
    label: "KYC completions fall — all traffic",
    expect:
      "kyc_completion_rate drops everywhere. Detectable, but with no single segment to blame — a harder case to explain than the scoped one.",
    build: () => ({ windowDays: 5, kyc: { progressMultiplier: 0.08 } }),
  },
  {
    id: "kyc_failures",
    label: "KYC starts succeed less often (more rejections)",
    expect:
      "Starts hold steady but loan.kyc_failed.failure rises and completions fall, so the funnel narrows at verification rather than at entry.",
    build: () => ({ windowDays: 5, kyc: { successRate: 0.35 } }),
  },
  {
    id: "approval_slowdown",
    label: "Loan approvals slow down",
    expect:
      "loan_approval_volume falls while loan.applied.success holds, so the drop is at the approval step, not demand.",
    build: () => ({ windowDays: 6, loans: { approvalRate: 0.18 } }),
  },
  {
    id: "demand_spike",
    label: "Loan demand spikes",
    expect: "loan.applied.success rises well above its band; approvals follow at the usual rate.",
    build: () => ({ windowDays: 5, loans: { applicationMultiplier: 0.6 } }),
  },
  {
    id: "shift_mobile",
    label: "Traffic shifts to mobile",
    expect:
      "The device mix moves without any rate changing. Aggregate KPIs may barely move while the population underneath them changes — a genuinely harder inference.",
    build: () => ({ windowDays: 6, mix: { deviceWeights: { mobile: 9, desktop: 1, tablet: 1 } } }),
  },
  {
    id: "shift_india",
    label: "Traffic shifts to India",
    expect: "The geography mix concentrates on location=India, again with no rate change.",
    build: () => ({ windowDays: 6, mix: { countryWeights: { India: 9, USA: 1, "United Kingdom": 1 } } }),
  },
  {
    id: "pro_collapse",
    label: "Pro conversions collapse",
    expect:
      "pro_revenue falls. Remember its figures are modelled at a fixed rate per conversion — the event count is the real quantity.",
    build: () => ({ windowDays: 5, pro: { conversionMultiplier: 0.1 } }),
  },
  {
    id: "pro_errors",
    label: "Pro feature errors spike",
    expect:
      "Pro .failure events rise sharply against flat .success events, so the split between them is the signal.",
    build: () => ({ windowDays: 4, pro: { errorRate: 0.45 } }),
  },
  {
    id: "role_violations",
    label: "Unauthorized access burst",
    expect:
      "auth.role.violation appears in volume — a categorical anomaly rather than a KPI movement.",
    build: () => ({ windowDays: 3, pro: { roleViolationRate: 0.35 } }),
  },
]

interface BehaviorControlsProps {
  value: BehaviorPayload | null
  onChange: (next: BehaviorPayload | null) => void
  scenarioId: string
  onScenarioChange: (id: string) => void
  disabled?: boolean
}

export function BehaviorControls({
  value,
  onChange,
  scenarioId,
  onScenarioChange,
  disabled,
}: BehaviorControlsProps) {
  const [showAdvanced, setShowAdvanced] = useState(false)

  const active = useMemo(
    () => SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0],
    [scenarioId]
  )

  const handleScenario = (id: string) => {
    onScenarioChange(id)
    const scenario = SCENARIOS.find((s) => s.id === id)
    onChange(scenario ? scenario.build() : null)
  }

  const patchWindow = (e: ChangeEvent<HTMLInputElement>) => {
    if (!value) return
    const windowDays = Math.max(1, Math.min(Number(e.target.value) || 1, 60))
    onChange({ ...value, windowDays })
  }

  const patchSegment = (key: "device_type" | "location", raw: string) => {
    if (!value) return
    const segment = { ...(value.segment || {}) }
    if (raw.trim()) segment[key] = raw.trim()
    else delete segment[key]
    onChange({ ...value, segment: Object.keys(segment).length ? segment : undefined })
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label className="text-xs font-black uppercase text-zinc-400">What should change?</Label>
        <Select value={scenarioId} onValueChange={handleScenario} disabled={disabled}>
          <SelectTrigger className="h-12 rounded-2xl font-bold border-zinc-100">
            <SelectValue placeholder="Pick a behaviour" />
          </SelectTrigger>
          <SelectContent className="rounded-2xl border-zinc-100 max-h-[380px]">
            {SCENARIOS.map((scenario) => (
              <SelectItem key={scenario.id} value={scenario.id} className="font-bold">
                {scenario.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-zinc-500 font-medium leading-relaxed">{active.expect}</p>
      </div>

      {value && (
        <>
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

          <button
            type="button"
            onClick={() => setShowAdvanced((prev) => !prev)}
            className="text-xs font-black uppercase text-violet-600 hover:text-violet-800 cursor-pointer"
          >
            {showAdvanced ? "Hide" : "Show"} segment scope
          </button>

          {showAdvanced && (
            <div className="space-y-4 border border-violet-100 rounded-2xl p-4 bg-violet-50/40">
              <p className="text-xs text-zinc-600 font-medium leading-relaxed">
                Confine the change to matching sessions. Leave blank to affect all traffic.
                Scoping is what gives root-cause analysis something to find.
              </p>
              <div className="space-y-2">
                <Label className="text-xs font-black uppercase text-zinc-400">device_type</Label>
                <Input
                  placeholder="mobile / desktop / tablet"
                  value={value.segment?.device_type || ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => patchSegment("device_type", e.target.value)}
                  disabled={disabled}
                  className="h-11 rounded-2xl font-bold border-zinc-100 bg-white"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-black uppercase text-zinc-400">location (country)</Label>
                <Input
                  placeholder="India / USA / United Kingdom"
                  value={value.segment?.location || ""}
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
        </>
      )}
    </div>
  )
}
