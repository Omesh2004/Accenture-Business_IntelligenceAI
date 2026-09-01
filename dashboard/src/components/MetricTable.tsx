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

function Path({ points, colour }: { points: { value: number }[]; colour: string }) {
  const d = useMemo(() => {
    if (points.length < 2) return '';
    const values = points.map((p) => p.value);
    const lo = Math.min(...values);
    const span = (Math.max(...values) - lo) || 1;
    return points
      .map((p, i) => {
        const x = (i / (points.length - 1)) * 100;
        const y = 24 - ((p.value - lo) / span) * 24;
        return `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
  }, [points]);

  if (!d) return <span className="block h-6" />;
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="h-6 w-full" aria-hidden>
      <motion.path
        d={d} fill="none" stroke={colour} strokeWidth={1.5}
        strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"
        initial={{ pathLength: 0 }} animate={{ pathLength: 1 }}
        transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
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
      // Against the start of the window on screen, which is the period the header names.
      const then = pts.length ? pts[0].value : 0;
      const change = then ? ((now - then) / Math.abs(then)) * 100 : 0;
      const rose = change >= 0;
      return { spec: k, pts, now, change: Math.abs(change), rose,
               good: RISE_IS_BAD.has(k.id) ? !rose : rose };
    }),
    [series, allowed],
  );

  if (!rows.length) return null;

  return (
    <div className="surface overflow-hidden">
      <div className="hidden grid-cols-[minmax(160px,1.4fr)_120px_minmax(200px,2fr)_110px] gap-4
                      border-b border-slate-100 px-6 py-3.5 text-[10.5px] font-semibold
                      uppercase tracking-[0.13em] text-slate-500 md:grid">
        <span>Metric</span>
        <span>Current</span>
        <span>Trend (last {days} days)</span>
        <span className="text-right">Change</span>
      </div>

      {rows.map(({ spec: k, pts, now, change, rose, good }, i) => {
        const Arrow = rose ? TrendingUp : TrendingDown;
        const colour = good ? 'var(--rise)' : 'var(--fall)';
        return (
          <motion.div
            key={k.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.03 * i, ease: [0.22, 1, 0.36, 1] }}
            className="grid grid-cols-2 items-center gap-4 border-b border-slate-100 px-6 py-4
                       transition-colors last:border-b-0 hover:bg-slate-50/70
                       md:grid-cols-[minmax(160px,1.4fr)_120px_minmax(200px,2fr)_110px]"
          >
            <span className="truncate text-[13.5px] text-slate-700">{k.label}</span>
            <span className="num text-right text-[15px] font-semibold text-slate-900 md:text-left">
              {pts.length ? fmt(k.unit, now) : '--'}
            </span>
            <span className="col-span-2 md:col-span-1">
              <Path points={pts} colour={good ? 'var(--brand)' : 'var(--fall)'} />
            </span>
            <span className="col-span-2 flex items-center justify-end gap-1 text-[13px] font-medium
                             md:col-span-1"
                  style={{ color: colour }}>
              <Arrow className="h-3.5 w-3.5" />
              {change.toFixed(1)}%
            </span>
          </motion.div>
        );
      })}
    </div>
  );
}
