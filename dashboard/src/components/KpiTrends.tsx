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
 * Split the series so the days outside the expected range are drawn in their own colour.
 *
 * With no usable band nothing is marked. An earlier version fell back to colouring the whole
 * scored window, so a metric that simply had no forecast on record came out entirely crimson --
 * "every day was outside", which is the opposite of what an absent band means.
 *
 * Both parts keep the boundary point, otherwise the two lines meet with a visible gap.
 */
export function markWindow(points: SeriesPoint[], win?: MovedWindow): Marked[] {
  const lower = win?.lower;
  const upper = win?.upper;
  const hasBand = lower != null && upper != null && upper > lower;
  if (!hasBand) return points.map((p) => ({ ...p, normal: p.value, inWindow: null }));

  const breaches = (p: SeriesPoint) => p.value < lower! || p.value > upper!;
  return points.map((p, i) => {
    const here = breaches(p);
    const near = (i > 0 && breaches(points[i - 1]))
              || (i + 1 < points.length && breaches(points[i + 1]));
    return { ...p, normal: here ? null : p.value, inWindow: here || near ? p.value : null };
  });
}

/** How many days sat outside, for the caption. */
export function breachCount(points: Marked[]): number {
  return points.filter((p) => p.inWindow != null && p.normal == null).length;
}

function Legend() {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-7 gap-y-2
                    text-[length:var(--step--1)] text-slate-500">
      <span className="inline-flex items-center gap-2">
        <span className="inline-block h-3 w-6 rounded border"
              style={{ background: 'rgb(91 33 224 / 0.08)',
                       borderColor: 'rgb(91 33 224 / 0.28)' }} />
        Expected range
      </span>
      <span className="inline-flex items-center gap-2">
        <span className="inline-block h-0.5 w-6 rounded" style={{ background: INSIDE }} />
        Within range
      </span>
      <span className="inline-flex items-center gap-2">
        <span className="inline-block h-0.5 w-6 rounded" style={{ background: OUTSIDE }} />
        Outside range
      </span>
    </div>
  );
}

export default function KpiTrends(
  { series, allowed, loading }:
  { series: Record<string, KpiSeries>; allowed: string[]; loading?: boolean },
) {
  // Every governed metric gets a chart, ordered so the ones that left their range come first.
  // Capping the list hid two of the five the product claims to track, which is a strange thing
  // for a page whose whole job is the portfolio.
  const cards = useMemo(() => {
    const built = KPI_SPECS.filter((k) => allowed.includes(k.id)).map((k) => {
      const s = series[k.id];
      const pts = markWindow(s?.points || [], s?.window);
      return { spec: k, pts, win: s?.window, outside: breachCount(pts) };
    });
    const swing = (c: (typeof built)[number]) => {
      if (c.pts.length < 2) return 0;
      const first = c.pts[0].value;
      const last = c.pts[c.pts.length - 1].value;
      return first ? Math.abs((last - first) / first) : 0;
    };
    return [...built].sort((a, b) => (b.outside - a.outside) || (swing(b) - swing(a)));
  }, [series, allowed]);

  return (
    <>
      <Legend />
      {/* Three across on a desktop, stacking down to one. Any narrower and the date axis -- the
          one thing a reader needs from a daily series -- stops being readable. */}
      <div className="rise-stagger grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {cards.map(({ spec: k, pts, win, outside }) => {
          const last = pts.length ? pts[pts.length - 1].value : 0;
          const lower = win?.lower;
          const upper = win?.upper;
          const hasBand = lower != null && upper != null && upper > lower;
          return (
            <div key={k.id} className="surface lift-card p-5">
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <span className="truncate text-[length:var(--step--2)] font-semibold uppercase
                                 tracking-[0.13em] text-slate-500">
                  {k.label}
                </span>
                <span className="num shrink-0 text-slate-900"
                      style={{ fontSize: 'var(--step-1)', fontWeight: 600 }}>
                  {pts.length ? fmt(k.unit, last) : 'No data'}
                </span>
              </div>

              <p className="mb-3 text-[length:var(--step--1a)]"
                 style={{ color: outside ? OUTSIDE : 'var(--color-slate-400)' }}>
                {!hasBand
                  ? 'No forecast band recorded for this range yet'
                  : outside === 0
                    ? `Every day inside ${fmt(k.unit, lower!)} to ${fmt(k.unit, upper!)}`
                    : `${outside} of ${pts.length} days outside `
                      + `${fmt(k.unit, lower!)} to ${fmt(k.unit, upper!)}`}
              </p>

              <div style={{ height: 200 }}>
                {pts.length ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={pts} margin={{ top: 8, right: 14, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id={`fill-${k.id}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={INSIDE} stopOpacity={0.18} />
                          <stop offset="100%" stopColor={INSIDE} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="2 5" stroke="#f0f0f6" vertical={false} />
                      <XAxis dataKey="date" tick={{ fontSize: 10.5, fill: '#9b95ad' }}
                             tickFormatter={(d: string) => d.slice(5)} minTickGap={18}
                             interval="preserveStartEnd" padding={{ left: 4, right: 4 }}
                             axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 10.5, fill: '#9b95ad' }} width={42}
                             axisLine={false} tickLine={false} domain={['auto', 'auto']}
                             tickFormatter={(v: number) => (k.unit === 'rate'
                               ? `${Math.round(v * 100)}%`
                               : v >= 1000 ? `${Math.round(v / 1000)}k` : `${Math.round(v)}`)} />
                      {/* One row, one verdict. The two Areas overlap by design -- markWindow
                          also marks the points either side of a breach so the red segment joins
                          up -- so the default tooltip listed the same reading twice, once as
                          "Outside the range" and once as "Inside the range". The band itself
                          settles it, so the verdict is computed here rather than read off
                          whichever series happened to be under the cursor. */}
                      <Tooltip
                        content={({ active, payload, label }) => {
                          if (!active || !payload?.length) return null;
                          const row = payload[0].payload as Marked;
                          const value = row.normal ?? row.inWindow;
                          if (value == null) return null;
                          const out = hasBand && (value < lower! || value > upper!);
                          return (
                            <div className="rounded-xl border bg-white px-3 py-2 shadow-[var(--shadow-card)]"
                                 style={{ borderColor: 'var(--hairline)' }}>
                              <p className="text-[length:var(--step--1a)] text-slate-400">{String(label)}</p>
                              <p className="num text-[length:var(--step--1)] font-semibold text-slate-900">
                                {fmt(k.unit, value)}
                              </p>
                              {hasBand && (
                                <p className="text-[length:var(--step--1a)]"
                                   style={{ color: out ? OUTSIDE : INSIDE }}>
                                  {out ? 'outside the expected range' : 'within the expected range'}
                                </p>
                              )}
                            </div>
                          );
                        }} />

                      {/* The range itself, drawn as the region it is. A reader can then SEE the
                          line leave it, instead of being told in a caption which days did. */}
                      {hasBand && (
                        <ReferenceArea y1={lower!} y2={upper!} fill={INSIDE} fillOpacity={0.08}
                                       stroke={INSIDE} strokeOpacity={0.22} strokeDasharray="3 4" />
                      )}

                      <Area type="monotone" dataKey="normal" strokeWidth={2.2}
                            connectNulls={false} stroke={INSIDE} fill={`url(#fill-${k.id})`}
                            isAnimationActive animationDuration={800} />
                      <Area type="monotone" dataKey="inWindow" strokeWidth={2.6}
                            connectNulls={false} stroke={OUTSIDE} fill="none"
                            isAnimationActive animationDuration={800} />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="grid h-full place-items-center text-[length:var(--step--1)] text-slate-400">
                    {loading ? 'Loading series' : 'No series for this window'}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
