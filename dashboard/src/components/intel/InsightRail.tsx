'use client';

/**
 * The summary rail: the reading, its path, the drivers behind it, and which tables it came from.
 *
 * Everything here is drawn from the answer payload the agent returned, so the rail and the
 * conversation beside it can never quote two different numbers for the same metric.
 */
import React, { useMemo } from 'react';
import { motion } from 'framer-motion';
import { Area, AreaChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { Database, TrendingDown, TrendingUp } from 'lucide-react';
import type { AgentAnswer } from '@/types';

const BRAND = '#5b21e0';
const FALL = '#f82768';
const RISE = '#0f9d76';
const EASE = [0.22, 1, 0.36, 1] as const;

function fmt(unit: string, v: number): string {
  if (unit === 'ratio') return `${(v * 100).toFixed(1)}%`;
  if (unit === 'percent') return `${v.toFixed(1)}%`;
  if (Math.abs(v) >= 1000) return Math.round(v).toLocaleString();
  return Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3);
}

function pretty(id: string): string {
  return id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** How hard a driver is pulling, as a word rather than a number the reader must rank themselves. */
function weight(share: number): { label: string; cls: string } {
  if (share >= 20) return { label: 'High', cls: 'chip-high' };
  if (share >= 8) return { label: 'Medium', cls: 'chip-warn' };
  return { label: 'Low', cls: 'chip' };
}

export default function InsightRail({ answer }: { answer: AgentAnswer }) {
  const claims = useMemo(() => {
    const out: Record<string, { value: number; unit: string }> = {};
    for (const c of answer.evidence || []) {
      if (typeof c.value === 'number') out[c.claim_id] = { value: c.value, unit: c.unit || '' };
    }
    return out;
  }, [answer.evidence]);

  const trend = (answer.visuals || []).find((v) => v.kind === 'trend');
  const drivers = (answer.visuals || []).find((v) => v.kind === 'bars' && v.gate === 'localize');
  const sources = useMemo(() => {
    const seen = new Set<string>();
    return (answer.citations || []).filter((c) => {
      if (!c.source || seen.has(c.source)) return false;
      seen.add(c.source);
      return true;
    });
  }, [answer.citations]);

  const observed = claims.observed;
  const baseline = claims.baseline;
  const pct = claims.pct_change?.value;
  const fell = observed && baseline ? observed.value < baseline.value : false;
  const Arrow = fell ? TrendingDown : TrendingUp;

  const path = useMemo(
    () => (trend?.series || []).map((s) => ({ date: s.label, value: s.value })),
    [trend],
  );

  if (!answer.kpi_id && !sources.length) return null;

  return (
    <motion.aside
      initial={{ opacity: 0, x: 14 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.5, ease: EASE }}
      className="w-[360px] shrink-0 space-y-4 overflow-y-auto border-l border-slate-100
                 bg-slate-50/50 p-5 2xl:w-[400px]"
      aria-label="Insight summary"
    >
      <span className="block text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
        Insight summary
      </span>

      {answer.kpi_id && (
        <section className="surface p-5">
          <span className="block text-[13px] font-medium text-slate-600">
            {pretty(answer.kpi_id)}
          </span>
          <div className="mt-1.5 flex items-baseline gap-2.5">
            <span className="num text-slate-900"
                  style={{ fontSize: 'var(--step-4)', fontWeight: 600, letterSpacing: '-0.03em' }}>
              {observed ? fmt(observed.unit, observed.value) : '--'}
            </span>
            {pct != null && (
              <span className="delta text-[12.5px] font-medium"
                    style={{ color: fell ? FALL : RISE }}>
                <Arrow className="h-3.5 w-3.5" />
                {Math.abs(pct).toFixed(1)}%
              </span>
            )}
          </div>
          {baseline && (
            <p className="mt-1 text-[11.5px] text-slate-400">
              against an expected {fmt(baseline.unit, baseline.value)}
            </p>
          )}

          {path.length > 1 && (
            <div className="mt-4" style={{ height: 150 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={path} margin={{ top: 4, right: 2, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="rail-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={BRAND} stopOpacity={0.26} />
                      <stop offset="100%" stopColor={BRAND} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#b3adc2' }} minTickGap={30}
                         tickFormatter={(d: string) => d.slice(5)} axisLine={false}
                         tickLine={false} />
                  <YAxis hide domain={['dataMin', 'dataMax']} />
                  {trend?.upper != null && (
                    <ReferenceLine y={Number(trend.upper)} stroke="#c9bdf0" strokeDasharray="3 4" />
                  )}
                  {trend?.lower != null && (
                    <ReferenceLine y={Number(trend.lower)} stroke="#c9bdf0" strokeDasharray="3 4" />
                  )}
                  <Area type="monotone" dataKey="value" stroke={BRAND} strokeWidth={2}
                        fill="url(#rail-fill)" isAnimationActive animationDuration={800} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>
      )}

      {drivers && drivers.series.length > 0 && (
        <section className="surface p-5">
          <span className="mb-3 block text-[10.5px] font-semibold uppercase tracking-[0.16em]
                           text-slate-500">
            Key drivers
          </span>
          <ul className="space-y-3">
            {drivers.series.slice(0, 4).map((s, i) => {
              const w = weight(s.value);
              return (
                <motion.li
                  key={`${s.label}-${i}`}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, delay: 0.05 * i, ease: EASE }}
                  className="flex items-center gap-2 text-[12.5px]"
                >
                  <span className="min-w-0 flex-1 truncate text-slate-600" title={s.label}>
                    {s.label}
                  </span>
                  <span className="num shrink-0 font-medium" style={{ color: 'var(--brand)' }}>
                    {s.value.toFixed(1)}%
                  </span>
                  <span className={`shrink-0 ${w.cls}`}>{w.label}</span>
                </motion.li>
              );
            })}
          </ul>
        </section>
      )}

      {sources.length > 0 && (
        <section className="surface p-5">
          <span className="mb-3 block text-[10.5px] font-semibold uppercase tracking-[0.16em]
                           text-slate-500">
            Evidence sources
          </span>
          <ul className="space-y-3">
            {sources.map((c) => (
              <li key={`${c.tool}-${c.source}`}
                  className="flex items-center gap-2 text-[12px] text-slate-600">
                <Database className="h-3.5 w-3.5 shrink-0 text-slate-300" />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{c.source}</span>
                <span className="shrink-0 text-[10.5px] text-slate-400">{c.tool}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </motion.aside>
  );
}
