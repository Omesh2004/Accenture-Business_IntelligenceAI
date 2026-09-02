'use client';

/**
 * Every governed metric on one row: the reading, its path, and how far it moved.
 *
 * The cards above answer "what is it now" and the charts answer "what shape was it". This answers
 * "which of them should I look at first", which is the question a reader actually arrives with.
 * Same series as both, so no row can contradict the chart above it.
 */
import React, { useMemo } from 'react';
import { motion } from 'framer-motion';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { KPI_SPECS, type KpiSeries } from '@/hooks/useKpiSeries';
import { fmt } from './KpiTrends';

/** A rise is the bad direction here, so colour follows meaning rather than sign. */
const RISE_IS_BAD = new Set(['transaction_failure_rate']);

/**
 * The path, drawn into a fixed box at a fixed ratio.
 *
 * An earlier version stretched a 100x24 viewBox to whatever width the column happened to be and
 * held the stroke at a constant device width with `non-scaling-stroke`. The geometry was then
 * scaled unevenly while the stroke was not, so the same line looked heavy in one row and hairline
 * in the next. A fixed box makes every row identical.
 */
function Path({ points, colour }: { points: { value: number }[]; colour: string }) {
  const W = 260;
  const H = 30;
  const d = useMemo(() => {
    if (points.length < 2) return '';
    const values = points.map((p) => p.value);
    const lo = Math.min(...values);
    const span = (Math.max(...values) - lo) || 1;
    return points
      .map((p, i) => {
        const x = (i / (points.length - 1)) * W;
        // Headroom top and bottom so a peak is not clipped by the stroke width.
        const y = H - 4 - ((p.value - lo) / span) * (H - 8);
        return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }, [points]);

  if (!d) return <span className="block" style={{ height: H }} />;
  return (
    // `width: 100%` as a style rather than a class, so the SVG fills the cell whatever the
    // breakpoint. An animated `pathLength` used to draw these: on a re-render the tween
    // restarted from zero, and with five rows re-rendering as the series loaded the line was
    // routinely left part-drawn, which read as a chart that stopped halfway through the window.
    // The path is static now and the row itself carries the entrance.
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden
         style={{ width: '100%', height: H, display: 'block' }}>
      <path
        d={d} fill="none" stroke={colour} strokeWidth={1.85} vectorEffect="non-scaling-stroke"
        strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

export default function MetricTable(
  { series, allowed, days }:
  { series: Record<string, KpiSeries>; allowed: string[]; days: number },
) {
  const rows = useMemo(
    () => KPI_SPECS.filter((k) => allowed.includes(k.id)).map((k) => {
      const pts = series[k.id]?.points || [];
      const now = pts.length ? pts[pts.length - 1].value : 0;
      // The end of the window against the start of it, each averaged over a third of the days
      // that actually carry data.
      //
      // Two single days cannot do this job. Against day one of a 90-day range every row read
      // 0.0%, because the range reaches back before the bank existed and day one was a real
      // zero. Against the first day that HAS data it read 3575%, because that day is the
      // ramp-up edge and four accounts is not a baseline. Averaging both ends is stable and
      // says what a reader means by "how much has this moved".
      const live = pts.filter((p) => p.value !== 0);
      const mean = (xs: typeof live) =>
        (xs.length ? xs.reduce((a, p) => a + p.value, 0) / xs.length : 0);
      const slice = Math.max(1, Math.floor(live.length / 3));
      const then = mean(live.slice(0, slice));
      const later = mean(live.slice(-slice));
      const change = then ? ((later - then) / Math.abs(then)) * 100 : 0;
      const rose = change >= 0;
      return { spec: k, pts, now, change: Math.abs(change), rose,
               good: RISE_IS_BAD.has(k.id) ? !rose : rose };
    }),
    [series, allowed],
  );

  if (!rows.length) return null;

  return (
    // Scrolls inside its own card on a narrow screen rather than forcing the page sideways.
    <div className="surface overflow-x-auto">
      <table className="w-full min-w-[620px] table-fixed border-collapse">
        <thead>
          <tr className="border-b border-slate-100 text-[length:var(--step--2)] font-semibold uppercase
                         tracking-[0.13em] text-slate-500">
            <th className="w-[32%] px-6 py-3.5 text-left font-semibold">Metric</th>
            <th className="w-[15%] px-3 py-3.5 text-right font-semibold">Current</th>
            {/* The trend column takes whatever is left, so the line always spans the cell. */}
            <th className="px-6 py-3.5 text-center font-semibold">Trend (last {days} days)</th>
            <th className="w-[15%] px-6 py-3.5 text-right font-semibold">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ spec: k, pts, now, change, rose, good }, i) => {
            const Arrow = rose ? TrendingUp : TrendingDown;
            const colour = good ? 'var(--rise)' : 'var(--fall)';
            return (
              <motion.tr
                key={k.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.03 * i, ease: [0.22, 1, 0.36, 1] }}
                className="border-b border-slate-100 transition-colors last:border-b-0
                           hover:bg-slate-50/70"
              >
                <td className="truncate px-6 py-4 text-[length:var(--step--1)] text-slate-700">{k.label}</td>
                <td className="num px-3 py-4 text-right text-[length:var(--step--0a)] font-semibold text-slate-900">
                  {pts.length ? fmt(k.unit, now) : '--'}
                </td>
                <td className="px-6 py-4 align-middle">
                  <Path points={pts} colour={good ? 'var(--brand)' : 'var(--fall)'} />
                </td>
                <td className="px-6 py-4 text-right text-[length:var(--step--1)] font-medium"
                    style={{ color: colour }}>
                  <span className="inline-flex items-center justify-end gap-1">
                    <Arrow className="h-3.5 w-3.5" />
                    {change.toFixed(1)}%
                  </span>
                </td>
              </motion.tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
