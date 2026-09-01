'use client';

/**
 * The five governed KPIs as daily series, read from the Metric API.
 *
 * A KPI card gives one number; a movement is only legible as a shape. Each chart marks its own
 * anomaly window so a spike or a drop is visible without reading the axis.
 */
import React, { useEffect, useState } from 'react';
import {
  Area, AreaChart, CartesianGrid, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { dashboardAPI, type MovedWindow } from '@/lib/api';

const KPIS = [
  { id: 'signups', label: 'New Account Signups', unit: 'count', pick: ['accounts_opened'] },
  { id: 'kyc_completion_rate', label: 'KYC Completion Rate', unit: 'rate',
    pick: ['kyc_completed', 'kyc_started'] },
  { id: 'loan_approval_volume', label: 'Loan Approval Volume', unit: 'count',
    pick: ['loans_approved'] },
  { id: 'revenue', label: 'Revenue', unit: 'money',
    pick: ['fee_revenue', 'interest_accrued', 'pro_revenue'] },
  { id: 'transaction_failure_rate', label: 'Transaction Failure Rate', unit: 'rate',
    pick: ['txn_failed', 'txn_total'] },
] as const;

type Point = { date: string; value: number; inWindow?: number | null; normal?: number | null };
type Series = { points: Point[]; kind: string; window?: MovedWindow };

function fmt(unit: string, v: number): string {
  if (unit === 'rate') return `${(v * 100).toFixed(1)}%`;
  if (unit === 'money') return `$${Math.round(v).toLocaleString()}`;
  return Math.round(v).toLocaleString();
}

/** A rate is derived from its two counts at read time; a count or money sums its fundamentals. */
function toPoints(
  d: { dates?: string[]; fundamentals?: Record<string, number[]> },
  unit: string, pick: readonly string[],
): Point[] {
  const dates = d.dates || [];
  const f = d.fundamentals || {};
  if (!dates.length) return [];
  return dates.map((date, i) => {
    let value = 0;
    if (unit === 'rate') {
      const [num, den] = pick;
      const dv = Number(f[den]?.[i] ?? 0);
      value = dv > 0 ? Number(f[num]?.[i] ?? 0) / dv : 0;
    } else {
      // Money sums its declared lines; a count charts only its own fundamental.
      value = pick.reduce((a, n) => a + Number(f[n]?.[i] ?? 0), 0);
    }
    return { date, value };
  });
}

/** Split the series so the part that actually moved is drawn in its own colour.
 *
 * The engine's anomaly window is the whole period it scored, so shading all of it on a chart of
 * the same length marks everything and tells the reader nothing. What is worth marking is the
 * DAYS that fell outside the expected range the movement was scored against. Where no band was
 * recorded the scored window is the honest fallback.
 *
 * Both parts keep the boundary point, otherwise the two lines meet with a visible gap.
 */
function markWindow(points: Point[], win?: MovedWindow): Point[] {
  const hasBand = win && win.lower != null && win.upper != null && win.upper > win.lower;
  const inWindowRange = (d: string) =>
    Boolean(win?.start) && d >= win!.start && (!win!.end || d < win!.end);
  const breaches = (p: Point) =>
    hasBand ? (p.value < win!.lower! || p.value > win!.upper!) && inWindowRange(p.date)
            : inWindowRange(p.date);

  if (!win?.start) return points.map((p) => ({ ...p, normal: p.value, inWindow: null }));
  return points.map((p, i) => {
    const here = breaches(p);
    const near = (i > 0 && breaches(points[i - 1]))
              || (i + 1 < points.length && breaches(points[i + 1]));
    return { ...p, normal: here ? null : p.value, inWindow: here || near ? p.value : null };
  });
}

/** The first and last day that actually breached, for the shaded band and the caption. */
function breachSpan(points: Point[]): [string, string] | null {
  const hit = points.filter((p) => p.inWindow != null && p.normal == null);
  return hit.length ? [hit[0].date, hit[hit.length - 1].date] : null;
}

export default function KpiTrends(
  { tenant = 'nexabank', days = 30, persona = 'analyst' }:
  { tenant?: string; days?: number; persona?: string },
) {
  const [series, setSeries] = useState<Record<string, Series>>({});
  const [allowed, setAllowed] = useState<string[]>(KPIS.map((k) => k.id));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const visible = await dashboardAPI.getVisibleKpis([tenant], days, persona);
      const permitted = visible.length ? visible : KPIS.map((k) => k.id);
      if (!cancelled) setAllowed(permitted);
      // A chart marks only the window the engine actually scored.
      const moved = await dashboardAPI.getMovedKpis([tenant], days);
      const out: Record<string, Series> = {};
      await Promise.all(KPIS.filter((k) => permitted.includes(k.id)).map(async (k) => {
        const d = await dashboardAPI.getMetricSeries(tenant, k.id, days);
        if (!d) return;
        const win = moved[k.id];
        out[k.id] = { points: markWindow(toPoints(d, k.unit, k.pick), win), kind: d.kind, window: win };
      }));
      if (!cancelled) { setSeries(out); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [tenant, days, persona]);

  return (
    <>
      {/* The two colours carry meaning, so they are stated rather than left to be inferred. */}
      <div className="flex flex-wrap items-center gap-5 mb-3 text-xs text-gray-600">
        <span className="inline-flex items-center gap-2">
          <span className="inline-block w-6 h-0.5 rounded" style={{ background: '#7500c0' }} />
          Inside the expected range
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="inline-block w-6 h-0.5 rounded" style={{ background: '#c2185b' }} />
          Days outside the expected range
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="inline-block w-6 h-3 rounded" style={{ background: 'rgba(194,24,91,0.10)' }} />
          The days it was outside
        </span>
      </div>
    <div className="reveal-stagger grid grid-cols-1 lg:grid-cols-2 gap-4">
      {KPIS.filter((k) => allowed.includes(k.id)).map((k) => {
        const s = series[k.id];
        const pts = s?.points || [];
        const last = pts.length ? pts[pts.length - 1].value : 0;
        const win = s?.window;
        // Only days that breached, and only where they are actually on screen.
        const span = breachSpan(pts);
        const onScreen = Boolean(win?.start && span);
        return (
          <div key={k.id} className="lift bg-white rounded-xl border border-gray-200/90 p-5">
            <div className="flex items-baseline justify-between mb-3">
              <span className="eyebrow">{k.label}</span>
              <span className="num text-gray-900" style={{ fontSize: 'var(--step-1)', fontWeight: 600 }}>
                {pts.length ? fmt(k.unit, last) : 'No data'}
              </span>
            </div>
            <div style={{ height: 132 }}>
              {pts.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={pts} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id={`g-${k.id}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#7500c0" stopOpacity={0.20} />
                        <stop offset="100%" stopColor="#7500c0" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="2 4" stroke="#eef1f5" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#94a3b8' }}
                           tickFormatter={(d: string) => d.slice(5)} minTickGap={26} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} width={44} axisLine={false} tickLine={false}
                           tickFormatter={(v: number) => (k.unit === 'rate' ? `${Math.round(v * 100)}%` : `${v >= 1000 ? `${Math.round(v / 1000)}k` : Math.round(v)}`)} />
                    <Tooltip
                      formatter={(v: unknown, n: unknown) =>
                        [fmt(k.unit, Number(v ?? 0)),
                         n === 'inWindow' ? 'In the scored window' : 'Baseline']}
                      contentStyle={{ borderRadius: 10, border: '1px solid #e5e7eb', fontSize: 12 }} />
                    {onScreen && (
                      <ReferenceArea x1={span![0]} x2={span![1]}
                                     fill="#c2185b" fillOpacity={0.07} />
                    )}
                    {/* Two series over the same points: the baseline, and the scored window. */}
                    <Area type="monotone" dataKey="normal" strokeWidth={2} connectNulls={false}
                          stroke="#7500c0" fill={`url(#g-${k.id})`}
                          isAnimationActive animationDuration={900} />
                    <Area type="monotone" dataKey="inWindow" strokeWidth={2.5} connectNulls={false}
                          stroke="#c2185b" fill="none"
                          isAnimationActive animationDuration={900} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full grid place-items-center text-sm text-gray-400">
                  {loading ? 'Loading series' : 'No series for this window'}
                </div>
              )}
            </div>
            {onScreen ? (
              <p className="mt-2 text-xs" style={{ color: '#c2185b' }}>
                Outside the expected range
                {win!.lower != null && win!.upper != null
                  ? ` of ${fmt(k.unit, win!.lower)} to ${fmt(k.unit, win!.upper)}`
                  : ''}
                {span![0] === span![1] ? ` on ${span![0]}` : ` from ${span![0]} to ${span![1]}`}
                {win!.severity ? `, graded ${win!.severity}` : ''}
              </p>
            ) : win?.start ? (
              <p className="mt-2 text-xs text-gray-500">
                Movement recorded over {String(win.start).slice(0, 10)} to{' '}
                {String(win.end).slice(0, 10)}, but no day in this view breached the range
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
    </>
  );
}
