'use client';

/**
 * Grafana-flavoured panels for the intelligence report.
 *
 * What is actually borrowed from Grafana is not the look, it is three conventions that make a
 * dense panel readable at a glance:
 *
 *   1. A panel has CHROME: a title strip, a thin border, and a footer naming where the data came
 *      from. A chart floating on a page gives a reader nowhere to check what they are looking at.
 *   2. A series carries its own SUMMARY STATISTICS in the legend (min, mean, max, last), so the
 *      shape and the numbers are read together instead of by hovering point by point.
 *   3. A magnitude is shown as a BAR GAUGE with explicit thresholds, not as a bare number. The
 *      threshold is the judgement, so it should be visible rather than implied by a colour.
 *
 * Every panel takes data already fetched by its caller. Nothing here queries, so a panel and the
 * sentence beside it cannot disagree.
 */

import React, { memo, useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertTriangle, Database } from 'lucide-react';
import { EASE, FONT, INK, compact } from './theme';

/* ── chrome ──────────────────────────────────────────────────────────────────────────────── */

export function Panel({
  title,
  subtitle,
  right,
  footer,
  children,
  className = '',
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.42, ease: EASE }}
      className={`flex flex-col overflow-hidden rounded-xl border ${className}`}
      style={{ borderColor: INK.hairline, background: INK.surface }}
    >
      <header
        className="flex items-center gap-2 px-4 py-2.5"
        style={{ borderBottom: `1px solid ${INK.hairline}`, background: INK.sunken }}
      >
        <div className="min-w-0">
          <h4
            className="truncate text-[12.5px] font-semibold"
            style={{ color: INK.textSoft, fontFamily: FONT.sans, letterSpacing: 0 }}
          >
            {title}
          </h4>
          {subtitle && (
            <p className="truncate text-[10.5px]" style={{ color: INK.textFaint }}>
              {subtitle}
            </p>
          )}
        </div>
        {right && <div className="ml-auto shrink-0">{right}</div>}
      </header>

      <div className="flex-1">{children}</div>

      {footer && (
        <footer
          className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[10.5px]"
          style={{ borderTop: `1px solid ${INK.hairline}`, color: INK.textFaint, fontFamily: FONT.mono }}
        >
          {footer}
        </footer>
      )}
    </motion.section>
  );
}

export function SourceChip({ source }: { source: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]"
      style={{ background: INK.surface, color: INK.textFaint, fontFamily: FONT.mono, border: `1px solid ${INK.hairline}` }}
    >
      <Database className="h-2.5 w-2.5" />
      {source}
    </span>
  );
}

/* ── statistics ──────────────────────────────────────────────────────────────────────────── */

export interface Stats {
  min: number;
  max: number;
  mean: number;
  last: number;
}

export function summarise(values: number[]): Stats {
  if (!values.length) return { min: 0, max: 0, mean: 0, last: 0 };
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    mean: sum / values.length,
    last: values[values.length - 1],
  };
}

/** The legend Grafana puts under a series: the four numbers that describe its shape. */
export function StatLegend({ stats, unit = '' }: { stats: Stats; unit?: string }) {
  const cells: [string, number][] = [
    ['min', stats.min],
    ['mean', stats.mean],
    ['max', stats.max],
    ['last', stats.last],
  ];
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1">
      {cells.map(([label, value]) => (
        <span key={label} className="flex items-baseline gap-1.5">
          <span className="text-[10px] tracking-wider uppercase" style={{ color: INK.textFaint }}>
            {label}
          </span>
          <span
            className="text-[11.5px]"
            style={{ color: INK.textSoft, fontFamily: FONT.mono, fontVariantNumeric: 'tabular-nums' }}
          >
            {compact(value)}
            {unit}
          </span>
        </span>
      ))}
    </div>
  );
}

/* ── bar gauge ───────────────────────────────────────────────────────────────────────────── */

export interface GaugeRow {
  label: string;
  value: number;
  sub?: string;
}

/**
 * Horizontal bars against a shared scale, with the value printed at the end of each.
 *
 * Ranked contributions were shown as a percentage plus a thin progress bar per card, which made
 * every row look equally important until you read the number. A shared axis puts rank 1 and rank 5
 * on the same scale, so the ordering is visible before any figure is read.
 */
export function BarGauge({
  rows,
  unit = '%',
  thresholds = [
    { at: 0, color: INK.accentLine },
    { at: 25, color: INK.accent },
    { at: 50, color: INK.signal },
  ],
  max,
}: {
  rows: GaugeRow[];
  unit?: string;
  thresholds?: { at: number; color: string }[];
  max?: number;
}) {
  const ceiling = max ?? Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  const colorFor = (v: number) =>
    [...thresholds].reverse().find((t) => Math.abs(v) >= t.at)?.color ?? thresholds[0].color;

  return (
    <div className="space-y-2.5 px-4 py-3.5">
      {rows.map((row, i) => (
        <div key={`${row.label}-${i}`} className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
          <div className="min-w-0">
            <p className="truncate text-[12.5px]" style={{ color: INK.text }}>
              {row.label}
            </p>
            {row.sub && (
              <p className="truncate text-[10px] tracking-wider uppercase" style={{ color: INK.textFaint }}>
                {row.sub}
              </p>
            )}
          </div>
          <span
            className="self-center text-[13px] font-semibold"
            style={{ color: INK.text, fontFamily: FONT.mono, fontVariantNumeric: 'tabular-nums' }}
          >
            {compact(row.value)}
            {unit}
          </span>
          <div
            className="col-span-2 h-2 overflow-hidden rounded-[3px]"
            style={{ background: INK.sunken }}
          >
            <motion.div
              className="h-full rounded-[3px]"
              style={{ background: colorFor(row.value) }}
              initial={{ width: 0 }}
              animate={{ width: `${Math.min((Math.abs(row.value) / ceiling) * 100, 100)}%` }}
              transition={{ duration: 0.7, delay: 0.06 * i, ease: EASE }}
            />
          </div>
        </div>
      ))}
      {!rows.length && (
        <p className="py-6 text-center text-[12.5px]" style={{ color: INK.textFaint }}>
          No rows to display.
        </p>
      )}
    </div>
  );
}

/* ── time series ─────────────────────────────────────────────────────────────────────────── */

export interface SeriesPoint {
  date: string;
  value: number;
}

function shortDate(iso: string) {
  const [, m, d] = iso.split('-');
  const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[Number(m)] ?? ''}`;
}

export const TimeSeriesPanel = memo(function TimeSeriesPanel({
  title,
  subtitle,
  points,
  unit = '',
  isRate = false,
  band,
  bandWithheld,
  source,
  height = 200,
}: {
  title: string;
  subtitle?: string;
  points: SeriesPoint[];
  unit?: string;
  isRate?: boolean;
  band?: { point: number; lower: number; upper: number; method: string };
  bandWithheld?: string;
  source: string;
  height?: number;
}) {
  const data = useMemo(
    () => points.map((p) => ({ ...p, label: shortDate(p.date) })),
    [points],
  );
  const stats = useMemo(() => summarise(points.map((p) => p.value)), [points]);
  const gradientId = useMemo(() => `ts-${title.replace(/\W+/g, '')}`, [title]);

  if (!points.length) {
    return (
      <Panel title={title} subtitle={subtitle}>
        <p className="px-4 py-10 text-center text-[12.5px]" style={{ color: INK.textFaint }}>
          No series is available for this metric.
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      title={title}
      subtitle={subtitle}
      right={
        <span
          className="text-[18px]"
          style={{ color: INK.text, fontFamily: FONT.mono, fontVariantNumeric: 'tabular-nums' }}
        >
          {compact(stats.last)}
          {unit}
        </span>
      }
      footer={
        <>
          <StatLegend stats={stats} unit={unit} />
          <span className="ml-auto flex items-center gap-2">
            {band && <span>band · {band.method}</span>}
            <SourceChip source={source} />
          </span>
          {bandWithheld && (
            <span className="flex w-full items-center gap-1" style={{ color: INK.caution }}>
              <AlertTriangle className="h-3 w-3 shrink-0" />
              forecast band withheld: {bandWithheld}
            </span>
          )}
        </>
      }
    >
      <div style={{ height }} className="px-1 pt-3">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 6, right: 18, bottom: 2, left: 2 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={INK.accentLine} stopOpacity={0.28} />
                <stop offset="100%" stopColor={INK.accentLine} stopOpacity={0.02} />
              </linearGradient>
            </defs>

            {/* One stored row means one flat band. It is never interpolated into a curve. */}
            {band && (
              <ReferenceArea y1={band.lower} y2={band.upper} fill={INK.accent} fillOpacity={0.06} stroke="none" />
            )}
            {band && (
              <ReferenceLine
                y={band.point}
                stroke={INK.accent}
                strokeDasharray="3 4"
                strokeOpacity={0.6}
                label={{
                  value: `expected ${compact(band.point)}`,
                  position: 'insideTopRight',
                  fill: INK.accent,
                  fontSize: 10,
                }}
              />
            )}

            <CartesianGrid stroke={INK.hairline} vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: INK.textFaint, fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              minTickGap={28}
            />
            <YAxis
              tick={{ fill: INK.textFaint, fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              width={52}
              tickFormatter={(v) => compact(Number(v))}
              domain={isRate ? [0, 1] : ['auto', 'auto']}
            />
            <Tooltip
              cursor={{ stroke: INK.hairlineStrong, strokeDasharray: '3 3' }}
              contentStyle={{
                background: INK.surface,
                border: `1px solid ${INK.hairline}`,
                borderRadius: 8,
                fontSize: 12,
                fontFamily: FONT.sans,
                color: INK.text,
                boxShadow: '0 8px 28px rgba(18,19,26,.10)',
              }}
              formatter={(v: unknown) => [`${compact(Number(v))}${unit}`, isRate ? 'rate' : 'value']}
              labelFormatter={(_l, p) => (p?.[0]?.payload as { date?: string })?.date ?? ''}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke={INK.accentLine}
              strokeWidth={1.75}
              fill={`url(#${gradientId})`}
              dot={false}
              activeDot={{ r: 3.5, fill: INK.accentLine, stroke: INK.surface, strokeWidth: 2 }}
              animationDuration={900}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
});

/* ── categorical ─────────────────────────────────────────────────────────────────────────── */

export function CategoryBars({
  rows,
  unit = '',
  colors,
  height = 150,
}: {
  rows: { label: string; value: number }[];
  unit?: string;
  colors: string[];
  height?: number;
}) {
  const data = useMemo(
    () =>
      rows.map((r) => ({
        ...r,
        short: r.label.replace(/^the /, '').slice(0, 14),
      })),
    [rows],
  );

  return (
    <div style={{ height }} className="px-1 pt-3">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 6, bottom: 0, left: 6 }}>
          <CartesianGrid stroke={INK.hairline} vertical={false} />
          <XAxis
            dataKey="short"
            tick={{ fill: INK.textFaint, fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            interval={0}
          />
          <YAxis
            tick={{ fill: INK.textFaint, fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={38}
            tickFormatter={(v) => compact(Number(v))}
          />
          <Tooltip
            cursor={{ fill: '#00000008' }}
            contentStyle={{
              background: INK.surface,
              border: `1px solid ${INK.hairline}`,
              borderRadius: 8,
              fontSize: 12,
              color: INK.text,
              boxShadow: '0 8px 28px rgba(18,19,26,.10)',
            }}
            formatter={(v) => [`${compact(Number(v))}${unit}`, 'share'] as [string, string]}
            labelFormatter={(_l, p) => (p?.[0]?.payload as { label?: string })?.label ?? ''}
          />
          <Bar dataKey="value" radius={[3, 3, 0, 0]} animationDuration={800}>
            {data.map((_, i) => (
              <Cell key={i} fill={colors[i % colors.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
