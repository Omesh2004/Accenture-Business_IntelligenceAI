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
import { dashboardAPI } from '@/lib/api';

const KPIS = [
  { id: 'signups', label: 'New Account Signups', unit: 'count' },
  { id: 'kyc_completion_rate', label: 'KYC Completion Rate', unit: 'rate' },
  { id: 'loan_approval_volume', label: 'Loan Approval Volume', unit: 'count' },
  { id: 'revenue', label: 'Revenue', unit: 'money' },
  { id: 'transaction_failure_rate', label: 'Transaction Failure Rate', unit: 'rate' },
] as const;

type Point = { date: string; value: number };
type Series = { points: Point[]; kind: string; anomalyFrom?: string };

function fmt(unit: string, v: number): string {
  if (unit === 'rate') return `${(v * 100).toFixed(1)}%`;
  if (unit === 'money') return `$${Math.round(v).toLocaleString()}`;
  return Math.round(v).toLocaleString();
}

/** A rate is derived from its two counts at read time; a count or money sums its fundamentals. */
function toPoints(d: {
  dates?: string[]; kind?: string; fundamentals?: Record<string, number[]>;
}, unit: string): Point[] {
  const dates = d.dates || [];
  const f = d.fundamentals || {};
  const names = Object.keys(f);
  if (!dates.length || !names.length) return [];
  return dates.map((date, i) => {
    let value = 0;
    if (unit === 'rate' && names.length >= 2) {
      const [num, den] = d.kind === 'rate' && names.includes('kyc_completed')
        ? ['kyc_completed', 'kyc_started']
        : ['txn_failed', 'txn_total'];
      const dv = Number(f[den]?.[i] ?? 0);
      value = dv > 0 ? Number(f[num]?.[i] ?? 0) / dv : 0;
    } else {
      value = names.reduce((a, n) => a + Number(f[n]?.[i] ?? 0), 0);
    }
    return { date, value };
  });
}

/** Where the level shifts: the first day the trailing week departs from the earlier median. */
function anomalyStart(points: Point[]): string | undefined {
  if (points.length < 12) return undefined;
  const head = points.slice(0, Math.max(4, points.length - 7)).map((p) => p.value).sort((a, b) => a - b);
  const med = head[Math.floor(head.length / 2)] || 0;
  if (!med) return undefined;
  for (let i = points.length - 7; i < points.length; i++) {
    if (Math.abs(points[i].value - med) / med > 0.35) return points[i].date;
  }
  return undefined;
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
      const out: Record<string, Series> = {};
      await Promise.all(KPIS.filter((k) => permitted.includes(k.id)).map(async (k) => {
        const d = await dashboardAPI.getMetricSeries(tenant, k.id, days);
        if (!d) return;
        const points = toPoints(d, k.unit);
        out[k.id] = { points, kind: d.kind, anomalyFrom: anomalyStart(points) };
      }));
      if (!cancelled) { setSeries(out); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [tenant, days, persona]);

  return (
    <div className="reveal-stagger grid grid-cols-1 lg:grid-cols-2 gap-4">
      {KPIS.filter((k) => allowed.includes(k.id)).map((k) => {
        const s = series[k.id];
        const pts = s?.points || [];
        const last = pts.length ? pts[pts.length - 1].value : 0;
        const moved = Boolean(s?.anomalyFrom);
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
                        <stop offset="0%" stopColor={moved ? '#dc2626' : '#1a73e8'} stopOpacity={0.22} />
                        <stop offset="100%" stopColor={moved ? '#dc2626' : '#1a73e8'} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="2 4" stroke="#eef1f5" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#94a3b8' }}
                           tickFormatter={(d: string) => d.slice(5)} minTickGap={26} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} width={44} axisLine={false} tickLine={false}
                           tickFormatter={(v: number) => (k.unit === 'rate' ? `${Math.round(v * 100)}%` : `${v >= 1000 ? `${Math.round(v / 1000)}k` : Math.round(v)}`)} />
                    <Tooltip
                      formatter={(v: unknown) => fmt(k.unit, Number(v ?? 0))}
                      contentStyle={{ borderRadius: 10, border: '1px solid #e5e7eb', fontSize: 12 }} />
                    {s?.anomalyFrom && (
                      <ReferenceArea x1={s.anomalyFrom} x2={pts[pts.length - 1].date}
                                     fill="#dc2626" fillOpacity={0.06} />
                    )}
                    <Area type="monotone" dataKey="value" strokeWidth={2}
                          stroke={moved ? '#dc2626' : '#1a73e8'} fill={`url(#g-${k.id})`}
                          isAnimationActive animationDuration={900} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full grid place-items-center text-sm text-gray-400">
                  {loading ? 'Loading series' : 'No series for this window'}
                </div>
              )}
            </div>
            {moved && (
              <p className="mt-2 text-xs text-red-700">
                Movement detected from {s?.anomalyFrom}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
