'use client';

/** The dashboard: who is reading, what each KPI reads now, how it moved, and what needs them first. */

import React, { useMemo, useState } from 'react';
import { useDashboardData } from '@/hooks/useDashboard';
import { useKpiSeries } from '@/hooks/useKpiSeries';
import { DashboardSkeleton } from '@/components/Skeletons';
import KPICard from '@/components/KPICard';
import KpiTrends from '@/components/KpiTrends';
import MetricTable from '@/components/MetricTable';
import RangePosition from '@/components/RangePosition';
import PersonaLens, { type PersonaId } from '@/components/PersonaLens';

export default function DashboardContent() {
  // The lens the whole page is read through. Server-validated on every request.
  const [persona, setPersona] = useState<PersonaId>('analyst');
  const { isLoading, kpiMetrics, timeRange } = useDashboardData(persona);

  // The range selector drives every panel, charts included.
  const rangeDays = Number(String(timeRange).replace(/[^0-9]/g, '')) || 30;

  // One fetch of the five series, shared by the cards, the charts, the table and the range
  // panel, so a sparkline can never disagree with the chart underneath it.
  const { data: seriesData, isLoading: seriesLoading } =
    useKpiSeries('nexabank', rangeDays, persona);
  const series = useMemo(() => seriesData?.series || {}, [seriesData]);
  const allowed = useMemo(
    () => seriesData?.allowed || kpiMetrics.map((m) => m.id),
    [seriesData, kpiMetrics],
  );

  if (isLoading && kpiMetrics.length === 0) return <DashboardSkeleton />;

  return (
    <div className="relative space-y-8">
      <PersonaLens persona={persona} onChange={setPersona} />

      <section id="kpi-section" aria-label="Key performance indicators">
        <div className="rise-stagger grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {kpiMetrics.map((metric) => (
            <KPICard key={metric.id} metric={metric} spark={series[metric.id]?.points} />
          ))}
        </div>
      </section>

      <section className="rise" aria-label="Where each metric sits against its range">
        <RangePosition series={series} allowed={allowed} />
      </section>

      <section className="rise" id="kpi-trends" aria-label="How each KPI moved">
        <h3 className="mb-1">What moved most</h3>
        <p className="mb-4 text-[length:var(--step--1)] text-slate-400">
          The three metrics furthest from where they were expected, daily over the last{' '}
          {rangeDays} days. Every metric is in the table below.
        </p>
        <KpiTrends series={series} allowed={allowed} loading={seriesLoading} />
      </section>

      <section className="rise" aria-label="Every metric at a glance">
        <MetricTable series={series} allowed={allowed} days={rangeDays} />
      </section>
    </div>
  );
}
