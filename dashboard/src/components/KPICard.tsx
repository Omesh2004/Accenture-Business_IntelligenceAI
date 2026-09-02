'use client';

/**
 * One KPI: an icon tile, the reading, a sparkline and the direction it moved.
 *
 * The sparkline is the same series the chart below the row plots, so the two cannot disagree.
 * Where there is no series the card simply drops the sparkline rather than drawing a flat line,
 * which would read as "no movement" instead of "not loaded".
 */

import React, { memo, useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  Activity, AlertTriangle, Banknote, Clock, Globe, Landmark, Layers, ShieldCheck,
  TrendingDown, TrendingUp, Users,
} from 'lucide-react';
import { KPIMetric } from '@/types';
import type { SeriesPoint } from '@/hooks/useKpiSeries';

const ICONS: Record<string, React.ElementType> = {
  activity: Activity, layers: Layers, clock: Clock, 'alert-triangle': AlertTriangle,
  globe: Globe, users: Users, 'trending-down': TrendingDown, 'trending-up': TrendingUp,
  'shield-check': ShieldCheck, landmark: Landmark, banknote: Banknote,
};

/** Metrics where a rise is the bad direction, so the colour follows meaning not sign. */
const RISE_IS_BAD = new Set(['transaction_failure_rate', 'error-rate', 'bounce-rate']);

/** A minimal path. No axes, no grid: at this size they would be noise, not information. */
function Spark({ points, colour }: { points: SeriesPoint[]; colour: string }) {
  const d = useMemo(() => {
    if (points.length < 2) return '';
    const values = points.map((p) => p.value);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const span = hi - lo || 1;
    const w = 200;
    const h = 32;
    return points
      .map((p, i) => {
        const x = (i / (points.length - 1)) * w;
        // Headroom top and bottom so a peak is not clipped by the stroke.
        const y = h - 3 - ((p.value - lo) / span) * (h - 6);
        return `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
  }, [points]);

  if (!d) return <span className="h-8 flex-1" />;
  return (
    <svg viewBox="0 0 200 32" preserveAspectRatio="none" className="h-8 flex-1"
         aria-hidden focusable="false">
      <motion.path
        d={d} fill="none" stroke={colour} strokeWidth={1.75}
        strokeLinecap="round" strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 0.85, ease: [0.22, 1, 0.36, 1] }}
      />
    </svg>
  );
}

function KPICard({ metric, spark = [] }: { metric: KPIMetric; spark?: SeriesPoint[] }) {
  const Icon = ICONS[metric.icon] || Activity;
  const rose = metric.changeDirection === 'up';
  const good = RISE_IS_BAD.has(metric.id) ? !rose : rose;
  const Arrow = rose ? TrendingUp : TrendingDown;
  const colour = good ? 'var(--rise)' : 'var(--fall)';

  return (
    <div id={`kpi-card-${metric.id}`} className="surface lift-card p-5">
      <div className="mb-3.5 flex items-center gap-2.5">
        <span className="icon-tile"><Icon className="h-[15px] w-[15px]" /></span>
        <span className="min-w-0 flex-1 truncate text-[10.5px] font-semibold uppercase tracking-[0.13em] text-slate-500">
          {metric.label}
        </span>
        {metric.simulated && (
          <span className="chip chip-warn"
                title={metric.simulatedNote || 'This figure is modelled, not measured.'}>
            Simulated
          </span>
        )}
      </div>

      <p className="num mb-4 text-slate-900" style={{ fontSize: 'var(--step-3)', fontWeight: 600,
                                                      letterSpacing: '-0.02em', lineHeight: 1.05 }}>
        {metric.value}
      </p>

      <div className="flex items-center gap-4">
        <Spark points={spark} colour={good ? 'var(--brand)' : 'var(--fall)'} />
        <span className={`delta shrink-0 text-[12.5px] font-medium ${good ? 'delta-up' : 'delta-down'}`}
              style={{ color: colour }}>
          <Arrow className="h-3.5 w-3.5" />
          {metric.change}%
        </span>
      </div>
    </div>
  );
}

export default memo(KPICard);
