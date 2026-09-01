'use client';

/**
 * The five governed KPIs as daily paths.
 *
 * A KPI card gives one number; a movement is only legible as a shape. Each chart draws the days
 * that fell OUTSIDE the expected range in their own colour, because the engine's anomaly window is
 * the whole period it scored, and shading all of a seven-day chart marks everything and says
 * nothing.
 */
import React, { useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  Area, AreaChart, CartesianGrid, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { KPI_SPECS, type KpiSeries, type SeriesPoint } from '@/hooks/useKpiSeries';
import type { MovedWindow } from '@/lib/api';

const INSIDE = '#5b21e0';
const OUTSIDE = '#f82768';

type Marked = SeriesPoint & { inWindow: number | null; normal: number | null };

export function fmt(unit: string, v: number): string {
  if (unit === 'rate') return `${(v * 100).toFixed(1)}%`;
  if (unit === 'money') return `$${Math.round(v).toLocaleString()}`;
  return Math.round(v).toLocaleString();
}

/**
 * Split the series so the part that actually moved is drawn in its own colour. Both parts keep
 * the boundary point, otherwise the two lines meet with a visible gap.
 */
export function markWindow(points: SeriesPoint[], win?: MovedWindow): Marked[] {
  const hasBand = win && win.lower != null && win.upper != null && win.upper > win.lower;
  const inRange = (d: string) =>
    Boolean(win?.start) && d >= win!.start && (!win!.end || d < win!.end);
  const breaches = (p: SeriesPoint) =>
    hasBand ? (p.value < win!.lower! || p.value > win!.upper!) && inRange(p.date) : inRange(p.date);

  if (!win?.start) return points.map((p) => ({ ...p, normal: p.value, inWindow: null }));
  return points.map((p, i) => {
    const here = breaches(p);
    const near = (i > 0 && breaches(points[i - 1]))
              || (i + 1 < points.length && breaches(points[i + 1]));
    return { ...p, normal: here ? null : p.value, inWindow: here || near ? p.value : null };
  });
}

/** The first and last day that actually breached, for the shaded band and the caption. */
export function breachSpan(points: Marked[]): [string, string] | null {
  const hit = points.filter((p) => p.inWindow != null && p.normal == null);
  return hit.length ? [hit[0].date, hit[hit.length - 1].date] : null;
}

function Legend() {
  return (
    <div className="mb-3.5 flex flex-wrap items-center gap-x-6 gap-y-2 text-[11.5px] text-slate-500">
      <span className="inline-flex items-center gap-2">
        <span className="inline-block h-0.5 w-6 rounded" style={{ background: INSIDE }} />
        Inside the expected range
      </span>
      <span className="inline-flex items-center gap-2">
        <span className="inline-block h-0.5 w-6 rounded" style={{ background: OUTSIDE }} />
        Days outside the expected range
      </span>
      <span className="inline-flex items-center gap-2">
        <span className="inline-block h-3 w-6 rounded"
              style={{ background: 'rgb(248 39 104 / 0.10)' }} />
        The days it was outside
      </span>
    </div>
  );
}

export default function KpiTrends(
  { series, allowed, loading }:
  { series: Record<string, KpiSeries>; allowed: string[]; loading?: boolean },
) {
  const cards = useMemo(
    () => KPI_SPECS.filter((k) => allowed.includes(k.id)).map((k) => {
      const s = series[k.id];
      const pts = markWindow(s?.points || [], s?.window);
      return { spec: k, pts, win: s?.window, span: breachSpan(pts) };
    }),
    [series, allowed],
  );

  return (
    <>
      <Legend />
      <div className="rise-stagger grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-4">
        {cards.map(({ spec: k, pts, win, span }) => {
          const last = pts.length ? pts[pts.length - 1].value : 0;
          const onScreen = Boolean(win?.start && span);
          return (
            <div key={k.id} className="surface lift-card p-5">
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <span className="truncate text-[10.5px] font-semibold uppercase
                                 tracking-[0.13em] text-slate-500">
                  {k.label}
                </span>
                <span className="num shrink-0 text-slate-900"
                      style={{ fontSize: 'var(--step-1)', fontWeight: 600 }}>
                  {pts.length ? fmt(k.unit, last) : 'No data'}
                </span>
              </div>

              <div style={{ height: 128 }}>
                {pts.length ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={pts} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id={`fill-${k.id}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={INSIDE} stopOpacity={0.20} />
                          <stop offset="100%" stopColor={INSIDE} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="2 5" stroke="#f0f0f6" vertical={false} />
                      <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#9b95ad' }}
                             tickFormatter={(d: string) => d.slice(5)} minTickGap={24}
                             axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: '#9b95ad' }} width={42}
                             axisLine={false} tickLine={false}
                             tickFormatter={(v: number) => (k.unit === 'rate'
                               ? `${Math.round(v * 100)}%`
                               : v >= 1000 ? `${Math.round(v / 1000)}k` : `${Math.round(v)}`)} />
                      <Tooltip
                        formatter={(v: unknown, n: unknown) => [fmt(k.unit, Number(v ?? 0)),
                          n === 'inWindow' ? 'Outside the range' : 'Inside the range']}
                        contentStyle={{ borderRadius: 12, border: '1px solid var(--hairline)',
                                        fontSize: 12, boxShadow: 'var(--shadow-card)' }} />
                      {onScreen && (
                        <ReferenceArea x1={span![0]} x2={span![1]} fill={OUTSIDE}
                                       fillOpacity={0.07} />
                      )}
                      <Area type="monotone" dataKey="normal" strokeWidth={2} connectNulls={false}
                            stroke={INSIDE} fill={`url(#fill-${k.id})`}
                            isAnimationActive animationDuration={800} />
                      <Area type="monotone" dataKey="inWindow" strokeWidth={2.4}
                            connectNulls={false} stroke={OUTSIDE} fill="none"
                            isAnimationActive animationDuration={800} />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="grid h-full place-items-center text-[12.5px] text-slate-400">
                    {loading ? 'Loading series' : 'No series for this window'}
                  </div>
                )}
              </div>

              {onScreen ? (
                <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                          transition={{ delay: 0.5 }}
                          className="mt-2 text-[11.5px]" style={{ color: OUTSIDE }}>
                  Outside the expected range
                  {win!.lower != null && win!.upper != null
                    ? ` of ${fmt(k.unit, win!.lower)} to ${fmt(k.unit, win!.upper)}`
                    : ''}
                  {span![0] === span![1] ? ` on ${span![0]}` : ` from ${span![0]} to ${span![1]}`}
                </motion.p>
              ) : win?.start ? (
                <p className="mt-2 text-[11.5px] text-slate-400">
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
