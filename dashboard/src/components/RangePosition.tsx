'use client';

/**
 * Where each metric sits against the range it was scored on, on one shared axis.
 *
 * The charts above answer "what shape was it" one metric at a time. This answers "which of these
 * needs me first", which is the question a reader arrives with and the one a grid of five charts
 * makes them work out for themselves.
 *
 * Every metric has its own units, so the axis is the DISTANCE from the range, normalised: the
 * band occupies the middle regardless of whether the metric counts dollars or a ratio. That is
 * the only thing that makes five different metrics comparable on one line.
 */
import React, { useMemo } from 'react';
import { motion } from 'framer-motion';
import { KPI_SPECS, type KpiSeries } from '@/hooks/useKpiSeries';
import { fmt } from './KpiTrends';

const INSIDE = '#5b21e0';
const OUTSIDE = '#f82768';
const EASE = [0.22, 1, 0.36, 1] as const;

export default function RangePosition(
  { series, allowed }: { series: Record<string, KpiSeries>; allowed: string[] },
) {
  const rows = useMemo(
    () => KPI_SPECS.filter((k) => allowed.includes(k.id)).map((k) => {
      const s = series[k.id];
      const pts = s?.points || [];
      const now = pts.length ? pts[pts.length - 1].value : null;
      const lower = s?.window?.lower;
      const upper = s?.window?.upper;
      const hasBand = lower != null && upper != null && upper > lower;
      if (now == null || !hasBand) return { spec: k, now, lower, upper, hasBand: false, pos: 0.5 };

      // 0 and 1 are the edges of the band. Outside it the value runs past those, clamped at a
      // band-width beyond each edge so one extreme metric cannot flatten the rest.
      const width = upper! - lower!;
      const raw = (now - lower!) / width;
      return { spec: k, now, lower, upper, hasBand: true,
               pos: Math.max(-1, Math.min(2, raw)) };
    }),
    [series, allowed],
  );

  const usable = rows.filter((r) => r.hasBand);
  if (usable.length < 2) return null;

  // The track runs from one band-width below the range to one above, so the band is the middle
  // third and "outside" is visibly outside rather than merely near an edge.
  const toPct = (p: number) => ((p + 1) / 3) * 100;

  return (
    <div className="surface p-5">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h3 className="text-[15px]">Where each metric sits against its range</h3>
        <span className="text-[11.5px] text-slate-400">
          {usable.filter((r) => r.pos < 0 || r.pos > 1).length} of {usable.length} outside
        </span>
      </div>
      <p className="mb-5 text-[11.5px] text-slate-400">
        Each metric on its own scale, lined up so the expected range is the same place for all of
        them. Distance from the band is comparable; the raw numbers are not.
      </p>

      <div className="space-y-4">
        {usable.map((r, i) => {
          const outside = r.pos < 0 || r.pos > 1;
          return (
            <div key={r.spec.id} className="flex items-center gap-4">
              <span className="w-[38%] shrink-0 truncate text-[12.5px] text-slate-600">
                {r.spec.label}
              </span>

              <span className="relative h-7 flex-1">
                {/* The band. */}
                <span className="absolute inset-y-2 rounded"
                      style={{ left: `${toPct(0)}%`, width: `${toPct(1) - toPct(0)}%`,
                               background: 'rgb(91 33 224 / 0.10)',
                               border: '1px dashed rgb(91 33 224 / 0.30)' }} />
                {/* The baseline the marker travels along. */}
                <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2"
                      style={{ background: 'var(--hairline)' }} />
                {/* The reading. */}
                <motion.span
                  className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2
                             rounded-full ring-2 ring-white"
                  style={{ background: outside ? OUTSIDE : INSIDE }}
                  initial={{ left: `${toPct(0.5)}%`, scale: 0 }}
                  animate={{ left: `${toPct(r.pos)}%`, scale: 1 }}
                  transition={{ duration: 0.7, delay: 0.06 * i, ease: EASE }}
                />
              </span>

              <span className="num w-24 shrink-0 text-right text-[12.5px] font-medium"
                    style={{ color: outside ? OUTSIDE : 'var(--color-slate-700)' }}>
                {fmt(r.spec.unit, r.now!)}
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-5 flex items-center gap-4 border-t border-slate-100 pt-3
                      text-[11px] text-slate-400">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: INSIDE }} />
          inside the range
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: OUTSIDE }} />
          outside it
        </span>
      </div>
    </div>
  );
}
