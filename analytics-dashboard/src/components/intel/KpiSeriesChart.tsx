'use client';

/**
 * The metric's real daily path, drawn from `/intelligence/series`.
 *
 * Every other figure on this page is a scalar: an observed value, an expected value, a share.
 * None of them show whether the reported week is unusual against the weeks before it, which is the
 * first thing a reader wants to judge for themselves. This is the only component on the page that
 * answers that, and it answers it from the Metric Layer, which is the same code that produced the number
 * in the narrative, so the line and the sentence cannot disagree.
 *
 * Two honesty rules are enforced by the server and surfaced here:
 *   * `unit: 'count'` on a ratio contract means the rate could not be scored and the numerator is
 *     being plotted instead. The axis label says so rather than letting a count read as a rate.
 *   * `forecast_withheld` means the stored band is on a different scale from this series. The band
 *     is then not drawn at all, and the reason is shown, because a chart cannot caveat itself.
 */

import React, { memo, useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertTriangle, TrendingDown, TrendingUp } from 'lucide-react';
import { EASE, FONT, INK, compact } from './theme';
import type { KpiSeries } from '@/types';

function shortDate(iso: string) {
  const [, m, d] = iso.split('-');
  return `${d} ${['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m)]}`;
}

function KpiSeriesChart({ series, height = 220 }: { series: KpiSeries; height?: number }) {
  const data = useMemo(
    () => (series.points || []).map((p) => ({ ...p, label: shortDate(p.date) })),
    [series.points],
  );

  const { last, prev, delta, peak } = useMemo(() => {
    const v = data.map((d) => d.value);
    return {
      last: v.at(-1) ?? 0,
      prev: v.at(-2) ?? 0,
      delta: (v.at(-1) ?? 0) - (v.at(-2) ?? 0),
      peak: v.length ? Math.max(...v) : 0,
    };
  }, [data]);

  if (!data.length) {
    return (
      <div
        className="rounded-2xl border p-5 text-[13px]"
        style={{ borderColor: INK.hairline, background: INK.surface, color: INK.textFaint }}
      >
        No series is available for this metric.
      </div>
    );
  }

  const rose = delta >= 0;
  const band = series.forecast;
  const isRate = series.unit === 'ratio';

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: EASE }}
      className="overflow-hidden rounded-2xl border"
      style={{ borderColor: INK.hairline, background: INK.surface }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4">
        <div>
          <p
            className="text-[10.5px] tracking-[0.16em] uppercase"
            style={{ color: INK.textFaint, fontFamily: FONT.sans }}
          >
            {series.days}-day path
          </p>
          <h4
            className="mt-0.5 text-[19px] leading-tight"
            style={{ color: INK.text, fontFamily: FONT.display }}
          >
            {series.name}
          </h4>
          <p className="mt-0.5 text-[11px]" style={{ color: INK.textFaint }}>
            {isRate ? 'rate' : `counting ${series.measure || 'events'}`} · one point per UTC day
          </p>
        </div>
        <div className="text-right">
          <p
            className="text-[26px] leading-none"
            style={{ color: INK.text, fontFamily: FONT.mono, fontVariantNumeric: 'tabular-nums' }}
          >
            {compact(last)}
          </p>
          <p
            className="mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
            style={{
              color: rose ? INK.positive : INK.danger,
              background: rose ? INK.positiveSoft : INK.dangerSoft,
            }}
          >
            {rose ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {rose ? '+' : ''}
            {compact(delta)} vs {compact(prev)}
          </p>
        </div>
      </div>

      <div className="mt-3 px-1" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 6, right: 16, bottom: 4, left: 4 }}>
            <defs>
              <linearGradient id="intelArea" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={INK.accentLine} stopOpacity={0.26} />
                <stop offset="100%" stopColor={INK.accentLine} stopOpacity={0.02} />
              </linearGradient>
            </defs>

            {/* The stored band is ONE scalar pair for the whole horizon, so it is drawn flat and
                labelled as a band, and never interpolated into a curve it does not contain. */}
            {band && (
              <ReferenceArea
                y1={band.lower}
                y2={band.upper}
                fill={INK.accent}
                fillOpacity={0.06}
                stroke="none"
              />
            )}
            {band && (
              <ReferenceLine
                y={band.point}
                stroke={INK.accent}
                strokeDasharray="4 4"
                strokeOpacity={0.55}
                label={{
                  value: `expected ${compact(band.point)}`,
                  position: 'insideTopRight',
                  fill: INK.accent,
                  fontSize: 10,
                }}
              />
            )}

            <CartesianGrid stroke={INK.hairline} strokeDasharray="0" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: INK.textFaint, fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              minTickGap={26}
            />
            <YAxis
              tick={{ fill: INK.textFaint, fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              width={46}
              tickFormatter={(v) => compact(Number(v))}
              domain={isRate ? [0, 1] : ['auto', 'auto']}
            />
            <Tooltip
              cursor={{ stroke: INK.hairlineStrong }}
              contentStyle={{
                background: INK.surface,
                border: `1px solid ${INK.hairline}`,
                borderRadius: 10,
                fontSize: 12,
                fontFamily: FONT.sans,
                color: INK.text,
                boxShadow: '0 6px 24px rgba(18,19,26,.08)',
              }}
              formatter={(v: unknown) => [compact(Number(v)), isRate ? 'rate' : 'value']}
              labelFormatter={(_l, p) => (p?.[0]?.payload as { date?: string })?.date ?? ''}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke={INK.accentLine}
              strokeWidth={2}
              fill="url(#intelArea)"
              dot={false}
              activeDot={{ r: 4, fill: INK.accentLine, stroke: INK.surface, strokeWidth: 2 }}
              animationDuration={900}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-5 py-2.5 text-[11px]"
        style={{ borderColor: INK.hairline, color: INK.textFaint }}
      >
        <span style={{ fontFamily: FONT.mono }}>peak {compact(peak)}</span>
        <span style={{ fontFamily: FONT.mono }}>{data.length} days</span>
        <span style={{ fontFamily: FONT.mono }}>{series.source}</span>
        {band && <span style={{ fontFamily: FONT.mono }}>band · {band.method}</span>}
        {series.forecast_withheld && (
          <span
            className="inline-flex items-center gap-1"
            style={{ color: INK.caution }}
            title={series.forecast_withheld}
          >
            <AlertTriangle className="h-3 w-3" />
            band withheld: {series.forecast_withheld}
          </span>
        )}
      </div>
    </motion.div>
  );
}

export default memo(KpiSeriesChart);
