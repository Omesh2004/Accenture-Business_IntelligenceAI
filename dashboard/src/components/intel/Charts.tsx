'use client';

/**
 * The charts an answer can draw.
 *
 * Every series here arrives on the answer payload, built by the agent from a figure a tool
 * actually observed. Nothing in this file fetches, and nothing computes a new number: a chart
 * that re-queries and a sentence that quotes a stored figure are two reads of a moving table, and
 * the mismatch between them is invisible because both look authoritative.
 *
 * Animation is transform and opacity only, plus SVG path length, so a panel of six charts
 * composites on the GPU instead of costing layout on every frame.
 */
import React, { useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  Area, AreaChart, CartesianGrid, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip,
  XAxis, YAxis,
} from 'recharts';
import type { AgentVisual } from '@/types';

const BRAND = '#5b21e0';
const BRAND_SOFT = '#a78bfa';
const FALL = '#f82768';
const RISE = '#0f9d76';
const EASE = [0.22, 1, 0.36, 1] as const;

/** Values arrive in the metric's own units. A ratio is shown as a percentage, nothing else is. */
function fmt(unit: string, v: number): string {
  if (unit === 'ratio') return `${(v * 100).toFixed(1)}%`;
  if (unit === '%') return `${v.toFixed(1)}%`;
  if (unit === 'money' || unit === 'usd') return `$${Math.round(v).toLocaleString()}`;
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (abs >= 10) return v.toFixed(1).replace(/\.0$/, '');
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(abs < 0.01 ? 4 : 3);
}

function shorten(label: string, n = 26): string {
  return label.length > n ? `${label.slice(0, n - 1)}…` : label;
}

function Frame({ visual, children }: { visual: AgentVisual; children: React.ReactNode }) {
  return (
    <motion.figure
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: EASE }}
      className="surface p-4"
    >
      <figcaption className="mb-3">
        <span className="block text-[length:var(--step--1)] font-medium text-slate-800">{visual.title}</span>
        {visual.subtitle && (
          <span className="block text-[length:var(--step--1a)] text-slate-400">{visual.subtitle}</span>
        )}
      </figcaption>
      {children}
      <span className="mt-3 flex items-center gap-1.5 text-[length:var(--step--2)] text-slate-400">
        <span className="chip">{visual.source}</span>
        {visual.gate && <span>via {visual.gate}</span>}
      </span>
    </motion.figure>
  );
}

/* ── delta: expected against observed, two bars ─────────────────────────────────────────────── */

function Delta({ visual }: { visual: AgentVisual }) {
  const max = Math.max(...visual.series.map((s) => Math.abs(s.value))) || 1;
  return (
    <div className="space-y-2.5">
      {visual.series.map((s, i) => (
        <div key={s.label} className="flex items-center gap-3">
          <span className="w-20 shrink-0 text-[length:var(--step--1a)] text-slate-500">{s.label}</span>
          <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
            <motion.span
              className="block h-full rounded-full"
              style={{ background: i === 0 ? BRAND_SOFT : BRAND }}
              initial={{ width: 0 }}
              animate={{ width: `${(Math.abs(s.value) / max) * 100}%` }}
              transition={{ duration: 0.7, delay: 0.08 + i * 0.1, ease: EASE }}
            />
          </span>
          <span className="num w-24 shrink-0 text-right text-[length:var(--step--1)] text-slate-800">
            {fmt(visual.unit, s.value)}
          </span>
        </div>
      ))}
      {visual.pct_change != null && (
        <p className="pt-1 text-[length:var(--step--1a)] text-slate-500">
          A change of {Number(visual.pct_change).toFixed(1)}%.
        </p>
      )}
    </div>
  );
}

/* ── bars: ranked drivers ───────────────────────────────────────────────────────────────────── */

function Bars({ visual }: { visual: AgentVisual }) {
  const max = Math.max(...visual.series.map((s) => Math.abs(s.value))) || 1;
  return (
    <div className="space-y-2">
      {visual.series.map((s, i) => (
        <div key={`${s.label}-${i}`} className="flex items-center gap-3">
          <span className="w-[42%] shrink-0 truncate text-[length:var(--step--1a)] text-slate-600"
                title={s.label}>
            {shorten(s.label, 32)}
          </span>
          <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
            <motion.span
              className="block h-full rounded-full"
              style={{ background: `color-mix(in srgb, ${BRAND} ${100 - i * 13}%, #ffffff)` }}
              initial={{ width: 0 }}
              animate={{ width: `${(Math.abs(s.value) / max) * 100}%` }}
              transition={{ duration: 0.65, delay: 0.06 + i * 0.07, ease: EASE }}
            />
          </span>
          <span className="num w-14 shrink-0 text-right text-[length:var(--step--1)] text-slate-800">
            {fmt(visual.unit, s.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── trend: the daily path, with the scored window and the expected band ────────────────────── */

function Trend({ visual }: { visual: AgentVisual }) {
  const data = useMemo(
    () => visual.series.map((s) => ({ date: s.label, value: s.value })),
    [visual.series],
  );
  const hasBand = visual.lower != null && visual.upper != null;
  const start = (visual.window_start || '').slice(0, 10);
  const end = (visual.window_end || '').slice(0, 10);
  const inView = start && data.some((d) => d.date >= start);

  return (
    <div style={{ height: 168 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={`t-${visual.tool}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={BRAND} stopOpacity={0.24} />
              <stop offset="100%" stopColor={BRAND} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="2 5" stroke="#f0f0f6" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#9b95ad' }} minTickGap={26}
                 tickFormatter={(d: string) => d.slice(5)} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 10, fill: '#9b95ad' }} width={44} axisLine={false}
                 tickLine={false} tickFormatter={(v: number) => fmt(visual.unit, v)} />
          <Tooltip
            formatter={(v: unknown) => [fmt(visual.unit, Number(v ?? 0)), 'Reading']}
            contentStyle={{ borderRadius: 12, border: '1px solid var(--hairline)', fontSize: 12,
                            boxShadow: 'var(--shadow-card)' }} />
          {/* The band the reading was scored against, so "outside the range" is visible. */}
          {hasBand && (
            <ReferenceArea y1={Number(visual.lower)} y2={Number(visual.upper)}
                           fill={BRAND} fillOpacity={0.07} />
          )}
          {hasBand && (
            <ReferenceLine y={Number(visual.upper)} stroke={BRAND_SOFT} strokeDasharray="3 4" />
          )}
          {hasBand && (
            <ReferenceLine y={Number(visual.lower)} stroke={BRAND_SOFT} strokeDasharray="3 4" />
          )}
          {inView && <ReferenceArea x1={start} x2={end} fill={FALL} fillOpacity={0.06} />}
          <Area type="monotone" dataKey="value" stroke={BRAND} strokeWidth={2}
                fill={`url(#t-${visual.tool})`} isAnimationActive animationDuration={850} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ── band: where the reading fell against the expected range ────────────────────────────────── */

function Band({ visual }: { visual: AgentVisual }) {
  const lower = visual.series.find((s) => s.label === 'Lower')?.value ?? 0;
  const upper = visual.series.find((s) => s.label === 'Upper')?.value ?? 0;
  const point = visual.series.find((s) => s.label === 'Forecast')?.value ?? 0;
  const observed = visual.observed;

  // The scale runs a little past whichever end the reading sits outside, so a breach is visible
  // rather than pinned to the edge of the track.
  const values = [lower, upper, point, ...(observed != null ? [observed] : [])];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.1 || 1;
  const min = lo - pad;
  const span = hi + pad - min || 1;
  const pct = (v: number) => ((v - min) / span) * 100;
  const outside = observed != null && (observed < lower || observed > upper);

  return (
    <div className="pt-1 pb-5">
      <div className="relative h-2.5 rounded-full bg-slate-100">
        <motion.span
          className="absolute inset-y-0 rounded-full"
          style={{ background: 'color-mix(in srgb, #5b21e0 22%, #ffffff)',
                   left: `${pct(lower)}%` }}
          initial={{ width: 0 }}
          animate={{ width: `${pct(upper) - pct(lower)}%` }}
          transition={{ duration: 0.6, ease: EASE }}
        />
        <span className="absolute inset-y-[-3px] w-[2px] rounded"
              style={{ left: `${pct(point)}%`, background: BRAND_SOFT }} />
        {observed != null && (
          <motion.span
            className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full
                       ring-2 ring-white"
            style={{ left: `${pct(observed)}%`, background: outside ? FALL : RISE }}
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ duration: 0.4, delay: 0.35, ease: EASE }}
          />
        )}
      </div>
      <div className="mt-2.5 flex justify-between text-[length:var(--step--1a)] text-slate-500">
        <span className="num">{fmt(visual.unit, lower)}</span>
        <span className="num">
          {observed != null ? (
            <span style={{ color: outside ? FALL : RISE }}>
              read {fmt(visual.unit, observed)}
            </span>
          ) : (
            <>expected {fmt(visual.unit, point)}</>
          )}
        </span>
        <span className="num">{fmt(visual.unit, upper)}</span>
      </div>
    </div>
  );
}

/* ── waterfall: from expected to observed, one step per driver ──────────────────────────────── */

function Waterfall({ visual }: { visual: AgentVisual }) {
  const steps = visual.series;

  // Horizontal, one row per step.
  //
  // Drawn as vertical columns the labels had a card-width divided by eight to live in, so every
  // one of them truncated to "aut..." and the chart said nothing at all. A driver's NAME is the
  // finding; a bar that cannot be labelled is decoration. Rows give the name a full line, and the
  // running level reads down the page the way the arithmetic does.
  const levels = steps.map((s) => (s.role === 'start' || s.role === 'end' ? s.value : s.at ?? 0));
  const lo = Math.min(...levels);
  const hi = Math.max(...levels);
  const span = (hi - lo) || 1;
  const x = (v: number) => ((v - lo) / span) * 100;

  return (
    <div className="space-y-1.5">
      {steps.map((s, i) => {
        const anchor = s.role === 'start' || s.role === 'end';
        const to = anchor ? s.value : s.at ?? 0;
        const from = anchor ? lo : to - s.value;
        const left = Math.min(x(from), x(to));
        const width = Math.max(1.5, Math.abs(x(to) - x(from)));
        const colour = anchor ? BRAND
          : s.role === 'rest' ? '#cbc4dd'
          : s.value < 0 ? FALL : RISE;
        return (
          <div key={`${s.label}-${i}`} className="flex items-center gap-3">
            <span className="w-[40%] shrink-0 truncate text-[length:var(--step--1a)] text-slate-600"
                  title={s.label}>
              {s.label}
            </span>
            <span className="relative h-4 flex-1 rounded bg-slate-50">
              <motion.span
                className="absolute inset-y-[3px] rounded-[3px]"
                style={{ background: colour, opacity: anchor ? 1 : 0.9 }}
                initial={{ left: `${left}%`, width: 0 }}
                animate={{ left: `${left}%`, width: `${width}%` }}
                transition={{ duration: 0.5, delay: 0.04 + i * 0.06, ease: EASE }}
              />
            </span>
            <span className="num w-20 shrink-0 text-right text-[length:var(--step--1)]"
                  style={{ color: anchor ? 'var(--color-slate-700)' : colour }}>
              {anchor ? fmt(visual.unit, s.value)
                      : `${s.value > 0 ? '+' : ''}${fmt(visual.unit, s.value)}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ── donut: how much of the movement is accounted for ───────────────────────────────────────── */

function Donut({ visual }: { visual: AgentVisual }) {
  const share = Math.max(0, Math.min(100, visual.series[0]?.value ?? 0));
  const r = 42;
  const c = 2 * Math.PI * r;
  return (
    // Stacks under the ring on a narrow card. Side by side in 220px the sentence wrapped to one
    // word a line, which is how "of the movement sits in the segments named above" ended up
    // reading as a column of fragments.
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
      <div className="relative shrink-0">
        <svg viewBox="0 0 110 110" className="h-[104px] w-[104px] -rotate-90">
          <circle cx="55" cy="55" r={r} fill="none" stroke="#efecf7" strokeWidth={12} />
          <motion.circle
            cx="55" cy="55" r={r} fill="none" stroke={BRAND} strokeWidth={12}
            strokeLinecap="round" strokeDasharray={c}
            initial={{ strokeDashoffset: c }}
            animate={{ strokeDashoffset: c - (share / 100) * c }}
            transition={{ duration: 0.9, ease: EASE }}
          />
        </svg>
        {/* The figure belongs in the ring it describes, not beside it. */}
        <span className="absolute inset-0 grid place-items-center">
          <span className="num text-slate-900"
                style={{ fontSize: 'var(--step-1)', fontWeight: 600 }}>
            {share.toFixed(0)}%
          </span>
        </span>
      </div>
      <p className="text-center text-[length:var(--step--1)] leading-relaxed text-slate-500
                    sm:text-left">
        of the movement sits in the segments named above. The rest is spread too thin across the
        cube to attribute to any one of them.
      </p>
    </div>
  );
}

export default function Chart({ visual }: { visual: AgentVisual }) {
  const body = (() => {
    switch (visual.kind) {
      case 'delta': return <Delta visual={visual} />;
      case 'trend': return <Trend visual={visual} />;
      case 'band': return <Band visual={visual} />;
      case 'waterfall': return <Waterfall visual={visual} />;
      case 'donut': return <Donut visual={visual} />;
      default: return <Bars visual={visual} />;
    }
  })();
  return <Frame visual={visual}>{body}</Frame>;
}
