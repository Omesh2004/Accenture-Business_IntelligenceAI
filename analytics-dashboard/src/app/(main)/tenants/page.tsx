'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useRealtimeEvents } from '@/hooks/useRealtimeEvents';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import ChartContainer from '@/components/ChartContainer';
import { TenantsPageSkeleton } from '@/components/Skeletons';
import { dashboardAPI } from '@/lib/api';
import { APP_REGISTRY, APP_SUITES, TENANT_LABELS, TENANT_TO_APP } from '@/lib/feature-map';
import { useDashboardData } from '@/hooks/useDashboard';
import { useSession } from 'next-auth/react';
import { useAppSelector } from '@/lib/store';

type TenantKey = { id: string; name: string; accent: string; subtle: string };

type ComparisonTenant = Awaited<ReturnType<typeof dashboardAPI.getTenantComparison>>['tenants'][number];
type KpiMetrics = Awaited<ReturnType<typeof dashboardAPI.getKPIMetrics>>;
type SecondaryMetrics = Awaited<ReturnType<typeof dashboardAPI.getSecondaryKPIMetrics>>;
type FunnelRows = Awaited<ReturnType<typeof dashboardAPI.getFunnelData>>;
type TrafficRows = Awaited<ReturnType<typeof dashboardAPI.getTrafficData>>;
type ComparisonTrendPoint = NonNullable<ComparisonTenant['trend']>[number];

function toTitleCase(value: string): string {
  return value
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function humanizeFeature(featureName: string): string {
  const cleaned = featureName
    .replace(/^(free|pro)\./, '')
    .replace(/\.(view|success|failed|action|access)$/i, '')
    .replace(/[._-]+/g, ' ')
    .trim();

  return cleaned ? toTitleCase(cleaned) : featureName;
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

function formatCurrency(value: number): string {
  return `Rs ${value.toLocaleString('en-IN')}`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0m 0s';
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

function parseDuration(value: string): number {
  const match = value.match(/(?:(\d+)m)?\s*(?:(\d+)s)?/i);
  if (!match) return 0;
  const minutes = Number(match[1] || 0);
  const seconds = Number(match[2] || 0);
  return minutes * 60 + seconds;
}

function toMetricMap(items: KpiMetrics | SecondaryMetrics): Record<string, string> {
  return (items || []).reduce<Record<string, string>>((acc, metric) => {
    acc[metric.label] = metric.value;
    return acc;
  }, {});
}

function toNumber(value?: string | number | null): number {
  if (typeof value === 'number') return value;
  if (!value) return 0;
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function getComparisonWinner(left: number, right: number, higherIsBetter = true): 'left' | 'right' | 'tie' {
  if (left === right) return 'tie';
  if (higherIsBetter) return left > right ? 'left' : 'right';
  return left < right ? 'left' : 'right';
}

function hasAnyLoading(queries: Array<{ isLoading: boolean }>): boolean {
  return queries.some((query) => query.isLoading);
}

function ComparisonMetricCard({
  title,
  left,
  right,
  formatValue,
  higherIsBetter = true,
}: {
  title: string;
  left: TenantKey & { value: number };
  right: TenantKey & { value: number };
  formatValue: (value: number) => string;
  higherIsBetter?: boolean;
}) {
  const winner = getComparisonWinner(left.value, right.value, higherIsBetter);
  const winnerTenant = winner === 'left' ? left : winner === 'right' ? right : null;
  const delta = left.value - right.value;
  const deltaPct = right.value === 0 ? 0 : Math.abs((delta / right.value) * 100);
  const total = Math.max(left.value + right.value, 1);
  const leftWidth = (left.value / total) * 100;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
          <p className="mt-1 text-[11px] text-slate-400">Blue marks the stronger tenant.</p>
        </div>
        <div className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          {winnerTenant ? `${winnerTenant.name} leads` : 'Even'}
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-4">
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{left.name}</p>
          <p className="num mt-2 text-2xl font-semibold text-slate-900">{formatValue(left.value)}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{right.name}</p>
          <p className="num mt-2 text-2xl font-semibold text-slate-900">{formatValue(right.value)}</p>
        </div>
      </div>

      <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full bg-[#1a73e8]" style={{ width: `${leftWidth}%` }} />
      </div>

      <div className="mt-3 flex items-center justify-between text-[11px] text-slate-500">
        <span>
          Delta {delta >= 0 ? '+' : '-'}{formatValue(Math.abs(delta))}
        </span>
        <span>{deltaPct.toFixed(1)}% difference</span>
      </div>
    </div>
  );
}

function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500">{description}</p>
      </div>
      {action}
    </div>
  );
}

export default function TenantsPage() {
  const { rangeParam, timeRange, activeAppId } = useDashboardData();
  const { data: session } = useSession();
  const selectedTenants = useAppSelector((state) => state.dashboard.selectedTenants);
  const [trendMode, setTrendMode] = useState<'events' | 'users'>('events');
  const { lastEvent } = useRealtimeEvents({ maxEvents: 1 });
  const lastRealtimeRefetchAt = useRef(0);

  const activeSuite = useMemo(() => {
    if (activeAppId) {
      const routeSuite = APP_SUITES.find((suite) => suite.id === activeAppId);
      if (routeSuite) {
        return routeSuite;
      }
    }

    const selectedTenant = (selectedTenants || []).find((tenantId) => TENANT_TO_APP[String(tenantId).toLowerCase()]);
    const selectedAppId = selectedTenant ? TENANT_TO_APP[String(selectedTenant).toLowerCase()] : null;
    if (selectedAppId) {
      return APP_SUITES.find((suite) => suite.id === selectedAppId) || APP_SUITES[0];
    }

    const adminApps: string[] = (session?.user?.adminApps || [])
      .map((appId) => TENANT_TO_APP[String(appId).toLowerCase()] || String(appId).toLowerCase());
    const adminAppSet = new Set(adminApps);
    const adminSuite = APP_SUITES.find((suite) => adminAppSet.has(suite.id));
    return adminSuite || APP_SUITES[0];
  }, [activeAppId, selectedTenants, session]);

  const TENANTS = useMemo<TenantKey[]>(() => {
    const palette = [
      { accent: '#1a73e8', subtle: '#93c5fd' },
      { accent: '#0f172a', subtle: '#64748b' },
    ];

    return activeSuite.tenantIds.slice(0, 2).map((tenantId, index) => ({
      id: tenantId,
      name: TENANT_LABELS[tenantId] || APP_REGISTRY[tenantId]?.displayName || toTitleCase(tenantId),
      accent: palette[index]?.accent || '#1a73e8',
      subtle: palette[index]?.subtle || '#93c5fd',
    }));
  }, [activeSuite]);

  const comparisonQuery = useQuery({
    queryKey: ['tenant-comparison', rangeParam, TENANTS.map((tenant) => tenant.id).join(',')],
    queryFn: () => dashboardAPI.getTenantComparison(TENANTS.map((tenant) => tenant.id), rangeParam),
    staleTime: 20 * 1000,
    refetchInterval: 20 * 1000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  const trafficQuery = useQuery({
    queryKey: ['tenant-traffic', rangeParam, TENANTS.map((tenant) => tenant.id).join(',')],
    queryFn: () => dashboardAPI.getTrafficData(TENANTS.map((tenant) => tenant.id), rangeParam),
    staleTime: 20 * 1000,
    refetchInterval: 20 * 1000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  const kpiQueries = useQueries({
    queries: TENANTS.map((tenant) => ({
      queryKey: ['tenant-kpis', tenant.id, rangeParam],
      queryFn: () => dashboardAPI.getKPIMetrics([tenant.id], rangeParam),
      staleTime: 20 * 1000,
      refetchInterval: 20 * 1000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    })),
  });

  const secondaryQueries = useQueries({
    queries: TENANTS.map((tenant) => ({
      queryKey: ['tenant-secondary-kpis', tenant.id, rangeParam],
      queryFn: () => dashboardAPI.getSecondaryKPIMetrics([tenant.id], rangeParam),
      staleTime: 20 * 1000,
      refetchInterval: 20 * 1000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    })),
  });

  const licenseQueries = useQueries({
    queries: TENANTS.map((tenant) => ({
      queryKey: ['tenant-license-usage', tenant.id, rangeParam],
      queryFn: () => dashboardAPI.getLicenseUsage([tenant.id], rangeParam),
      staleTime: 20 * 1000,
      refetchInterval: 20 * 1000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    })),
  });

  const retentionQueries = useQueries({
    queries: TENANTS.map((tenant) => ({
      queryKey: ['tenant-retention', tenant.id, rangeParam],
      queryFn: () => dashboardAPI.getRetentionData([tenant.id], rangeParam),
      staleTime: 20 * 1000,
      refetchInterval: 20 * 1000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    })),
  });

  const funnelQueries = useQueries({
    queries: TENANTS.map((tenant) => ({
      queryKey: ['tenant-funnel', tenant.id, rangeParam],
      queryFn: () => dashboardAPI.getFunnelData([tenant.id], rangeParam),
      staleTime: 20 * 1000,
      refetchInterval: 20 * 1000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    })),
  });

  // Real-time refetch trigger with 4-second throttle
  useEffect(() => {
    if (!lastEvent) return;
    const now = Date.now();
    if (now - lastRealtimeRefetchAt.current < 4000) return;
    lastRealtimeRefetchAt.current = now;
    void comparisonQuery.refetch();
    void trafficQuery.refetch();
    [...kpiQueries, ...secondaryQueries, ...licenseQueries, ...retentionQueries, ...funnelQueries].forEach(q => {
      if (q.refetch) void q.refetch();
    });
  }, [lastEvent, comparisonQuery, trafficQuery, kpiQueries, secondaryQueries, licenseQueries, retentionQueries, funnelQueries]);

  const isLoading =
    comparisonQuery.isLoading ||
    trafficQuery.isLoading ||
    hasAnyLoading(kpiQueries) ||
    hasAnyLoading(secondaryQueries) ||
    hasAnyLoading(licenseQueries) ||
    hasAnyLoading(retentionQueries) ||
    hasAnyLoading(funnelQueries);

  const comparisonTenants: ComparisonTenant[] = comparisonQuery.data?.tenants || [];
  const trafficData = useMemo<TrafficRows>(() => trafficQuery.data || [], [trafficQuery.data]);

  const tenantSnapshots = TENANTS.map((tenant, index) => {
    const comparison = comparisonTenants.find((item: ComparisonTenant) => item.id === tenant.id) || null;
    const kpiMap = toMetricMap(kpiQueries[index].data || []);
    const secondaryMap = toMetricMap(secondaryQueries[index].data || []);
    const license = licenseQueries[index].data || { summary: { total_licensed: 0, total_used: 0, waste_pct: 0 }, licensed: [], unused_licensed: [], unlicensed_used: [] };
    const retention = retentionQueries[index].data || [];
    const funnel = funnelQueries[index].data || [];

    return {
      ...tenant,
      comparison,
      kpiMap,
      secondaryMap,
      license,
      retention,
      funnel,
    };
  });

  const leftTenant = tenantSnapshots[0];
  const rightTenant = tenantSnapshots[1];
  const leftTenantId = leftTenant?.id || 'left';
  const rightTenantId = rightTenant?.id || 'right';

  const trendChartData = useMemo(() => {
    if (trendMode === 'users') {
      const rows = trafficData || [];
      return rows.map((row: TrafficRows[number]) => ({
        date: String(row.date),
        [leftTenantId]: toNumber((row as Record<string, string | number>)[`${leftTenantId}_visitors`]),
        [rightTenantId]: toNumber((row as Record<string, string | number>)[`${rightTenantId}_visitors`]),
      }));
    }

    const dateSet = new Set<string>();
    tenantSnapshots.forEach((tenant) => {
      (tenant.comparison?.trend || []).forEach((point: ComparisonTrendPoint) => dateSet.add(point.date));
    });

    return Array.from(dateSet)
      .sort()
      .map((date) => ({
        date,
        [leftTenantId]: toNumber(tenantSnapshots[0].comparison?.trend.find((point) => point.date === date)?.events),
        [rightTenantId]: toNumber(tenantSnapshots[1].comparison?.trend.find((point) => point.date === date)?.events),
      }));
  }, [tenantSnapshots, trafficData, trendMode, leftTenantId, rightTenantId]);

  const featureRows = useMemo(() => {
    const featureMap = new Map<string, {
      feature: string;
      left: { usage: number; users: number; totalUsers: number };
      right: { usage: number; users: number; totalUsers: number };
    }>();

    tenantSnapshots.forEach((tenant) => {
      const totalUsers = tenant.license.summary?.total_users || tenant.comparison?.unique_users || 1;
      const allRows = [...tenant.license.licensed, ...tenant.license.unused_licensed];

      allRows.forEach((row) => {
        if ((row.plan_tier || '').toLowerCase() !== 'enterprise') return;
        const current = featureMap.get(row.feature_name) || {
          feature: row.feature_name,
          left: { usage: 0, users: 0, totalUsers: 0 },
          right: { usage: 0, users: 0, totalUsers: 0 },
        };

        const side = tenant.id === leftTenantId ? 'left' : 'right';
        current[side] = {
          usage: row.usage_count || 0,
          users: row.unique_users || 0,
          totalUsers,
        };
        featureMap.set(row.feature_name, current);
      });
    });

    return Array.from(featureMap.values())
      .map((row) => {
        const leftAdoption = row.left.totalUsers > 0 ? (row.left.users / row.left.totalUsers) * 100 : 0;
        const rightAdoption = row.right.totalUsers > 0 ? (row.right.users / row.right.totalUsers) * 100 : 0;
        const winner = getComparisonWinner(leftAdoption, rightAdoption, true);
        const winnerLabel = winner === 'left' ? leftTenant?.name || 'Left' : winner === 'right' ? rightTenant?.name || 'Right' : 'Even';
        const maxUsage = Math.max(row.left.usage, row.right.usage, 1);
        return {
          feature: row.feature,
          label: humanizeFeature(row.feature),
          leftUsage: row.left.usage,
          rightUsage: row.right.usage,
          leftUsers: row.left.users,
          rightUsers: row.right.users,
          leftAdoption,
          rightAdoption,
          winner: winnerLabel,
          maxUsage,
          insight:
            leftAdoption < 10 && rightAdoption < 10
              ? 'Underused in both tenants.'
              : winner === 'left'
                ? `${leftTenant?.name || 'Left'} leads by ${(leftAdoption - rightAdoption).toFixed(1)} points.`
                : winner === 'right'
                  ? `${rightTenant?.name || 'Right'} leads by ${(rightAdoption - leftAdoption).toFixed(1)} points.`
                  : 'Both tenants are evenly matched.',
        };
      })
      .sort((a, b) => Math.max(b.leftUsage, b.rightUsage) - Math.max(a.leftUsage, a.rightUsage));
  }, [tenantSnapshots, leftTenantId, leftTenant, rightTenant]);

  const topUtilizationRows = useMemo(() => {
    return [...featureRows]
      .map((row) => ({
        ...row,
        combinedUsage: row.leftUsage + row.rightUsage,
        utilizationGap: Math.abs(row.leftAdoption - row.rightAdoption),
      }))
      .sort((a, b) => b.combinedUsage - a.combinedUsage)
      .slice(0, 6);
  }, [featureRows]);

  const funnelRows = useMemo(() => {
    const steps = new Set<string>();
    tenantSnapshots.forEach((tenant) => tenant.funnel.forEach((step: FunnelRows[number]) => steps.add(step.label)));

    return Array.from(steps).map((stepLabel, index) => {
      const leftStep = tenantSnapshots[0].funnel.find((step: FunnelRows[number]) => step.label === stepLabel);
      const rightStep = tenantSnapshots[1].funnel.find((step: FunnelRows[number]) => step.label === stepLabel);
      const leftBase = tenantSnapshots[0].funnel[0]?.value || 1;
      const rightBase = tenantSnapshots[1].funnel[0]?.value || 1;
      const leftRate = leftStep ? (leftStep.value / leftBase) * 100 : 0;
      const rightRate = rightStep ? (rightStep.value / rightBase) * 100 : 0;
      return {
        step: stepLabel,
        index: index + 1,
        leftRate,
        rightRate,
        leftDropOff: leftStep?.dropOff ?? 0,
        rightDropOff: rightStep?.dropOff ?? 0,
        leftUsers: leftStep?.value ?? 0,
        rightUsers: rightStep?.value ?? 0,
        winner: getComparisonWinner(leftRate, rightRate, true),
      };
    });
  }, [tenantSnapshots]);

  const retentionSummary = tenantSnapshots.map((tenant) => {
    const latest = tenant.retention[0] || null;
    const averageRetention = tenant.retention.length
      ? tenant.retention.reduce((sum: number, row: any) => sum + ((row.month2 + row.month3) / 2), 0) / tenant.retention.length
      : 0;

    return {
      ...tenant,
      sessionSeconds: parseDuration(tenant.secondaryMap['Avg. Session Time'] || '0m 0s'),
      eventsPerUser: tenant.comparison ? tenant.comparison.total_events / Math.max(tenant.comparison.unique_users, 1) : 0,
      retentionPct: latest ? Math.max(averageRetention, (latest.month2 + latest.month3) / 2) : 0,
    };
  });

  const performanceSummary = tenantSnapshots.map((tenant) => {
    const avgResponseTime = toNumber(tenant.kpiMap['Avg. Response Time'] || tenant.kpiMap['Avg Response Time']);
    const errorRate = toNumber(tenant.kpiMap['Error Rate']);
    return {
      ...tenant,
      avgResponseTime,
      errorRate,
      successRate: Math.max(0, 100 - errorRate),
    };
  });

  const insights = useMemo(() => {
    const items: { title: string; message: string }[] = [];
    const revenueDelta = toNumber(leftTenant.license.summary.estimated_revenue) - toNumber(rightTenant.license.summary.estimated_revenue);
    const wasteDelta = toNumber(leftTenant.license.summary.waste_pct) - toNumber(rightTenant.license.summary.waste_pct);
    const growthDelta = toNumber(leftTenant.comparison?.growth_rate) - toNumber(rightTenant.comparison?.growth_rate);

    const topFeatureGap = featureRows.find((row: any) => Math.max(row.leftAdoption, row.rightAdoption) >= 20 && Math.abs(row.leftAdoption - row.rightAdoption) >= 15);
    const underusedFeature = featureRows.find((row: any) => row.leftAdoption < 10 && row.rightAdoption < 10);

    items.push({
      title: 'Revenue Opportunity',
      message:
        revenueDelta === 0
          ? 'Both tenants are generating the same estimated revenue in the selected period.'
          : `${revenueDelta > 0 ? (leftTenant?.name || 'Left') : (rightTenant?.name || 'Right')} is generating ${formatCurrency(Math.abs(revenueDelta))} more estimated revenue than its peer.`,
    });

    items.push({
      title: 'License Waste',
      message:
        wasteDelta === 0
          ? 'Both tenants are using licensed features at similar rates.'
          : `${wasteDelta > 0 ? (leftTenant?.name || 'Left') : (rightTenant?.name || 'Right')} has ${formatPercent(Math.abs(wasteDelta))} higher license waste, signaling unused paid capacity.`,
    });

    if (topFeatureGap) {
      items.push({
        title: 'Feature Adoption Gap',
        message: `${humanizeFeature(topFeatureGap.feature)} has a clear adoption lead in ${topFeatureGap.leftAdoption > topFeatureGap.rightAdoption ? (leftTenant?.name || 'Left') : (rightTenant?.name || 'Right')}.`,
      });
    }

    if (underusedFeature) {
      items.push({
        title: 'Underused Feature',
        message: `${humanizeFeature(underusedFeature.feature)} is rarely used in both tenants and should be reviewed for packaging or placement.`,
      });
    }

    items.push({
      title: 'Growth Direction',
      message:
        growthDelta === 0
          ? 'Both tenants are growing at a similar pace.'
          : `${growthDelta > 0 ? (leftTenant?.name || 'Left') : (rightTenant?.name || 'Right')} is growing faster by ${Math.abs(growthDelta).toFixed(1)} percentage points.`,
    });

    const performanceGap = performanceSummary[0] && performanceSummary[1]
      ? performanceSummary[0].avgResponseTime - performanceSummary[1].avgResponseTime
      : 0;

    items.push({
      title: 'Performance Gap',
      message:
        performanceGap === 0
          ? 'Response times are aligned across both tenants.'
          : `${performanceGap < 0 ? (leftTenant?.name || 'Left') : (rightTenant?.name || 'Right')} has the faster average response time by ${Math.abs(performanceGap).toFixed(0)} ms.`,
    });

    return items.slice(0, 5);
  }, [featureRows, leftTenant, performanceSummary, rightTenant]);

  if (isLoading) {
    return <TenantsPageSkeleton />;
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <section className="rounded-4xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-slate-400">Multi-tenant comparison</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">Tenant Performance Comparison</h1>
            <p className="mt-3 text-sm leading-6 text-slate-500">
              Compare {leftTenant?.name || 'Tenant A'} and {rightTenant?.name || 'Tenant B'} across usage, adoption, retention, performance, and revenue opportunity.
              The layout is intentionally minimal: blue indicates strength, slate indicates the comparison baseline.
            </p>
          </div>

          <div className="rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-600">
            {timeRange}
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {TENANTS.map((tenant) => (
            <div key={tenant.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Tenant</p>
              <p className="mt-2 text-lg font-semibold text-slate-900">{tenant.name}</p>
              <p className="mt-1 text-sm text-slate-500">{tenant.id}</p>
            </div>
          ))}
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Focus</p>
            <p className="mt-2 text-lg font-semibold text-slate-900">Revenue and adoption</p>
            <p className="mt-1 text-sm text-slate-500">Normalized feature mapping only, no raw event names.</p>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <SectionHeader
          title="Overview KPI Comparison"
          description="Side-by-side KPI comparison for the selected time range. Each card highlights the winning tenant and the delta between the two."
        />
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <ComparisonMetricCard
            title="Total Users"
            left={{ ...leftTenant, value: toNumber(leftTenant.license.summary.total_users) }}
            right={{ ...rightTenant, value: toNumber(rightTenant.license.summary.total_users) }}
            formatValue={formatCount}
          />
          <ComparisonMetricCard
            title="Active Users"
            left={{ ...leftTenant, value: toNumber(leftTenant.comparison?.unique_users || leftTenant.license.summary.total_users) }}
            right={{ ...rightTenant, value: toNumber(rightTenant.comparison?.unique_users || rightTenant.license.summary.total_users) }}
            formatValue={formatCount}
          />
          <ComparisonMetricCard
            title="Total Events"
            left={{ ...leftTenant, value: toNumber(leftTenant.comparison?.total_events) }}
            right={{ ...rightTenant, value: toNumber(rightTenant.comparison?.total_events) }}
            formatValue={formatCount}
          />
          <ComparisonMetricCard
            title="Pro Feature Adoption"
            left={{ ...leftTenant, value: toNumber(leftTenant.license.summary.pro_adoption_pct) }}
            right={{ ...rightTenant, value: toNumber(rightTenant.license.summary.pro_adoption_pct) }}
            formatValue={formatPercent}
          />
          <ComparisonMetricCard
            title="License Utilization"
            left={{ ...leftTenant, value: 100 - toNumber(leftTenant.license.summary.waste_pct) }}
            right={{ ...rightTenant, value: 100 - toNumber(rightTenant.license.summary.waste_pct) }}
            formatValue={formatPercent}
          />
          <ComparisonMetricCard
            title="Estimated Revenue"
            left={{ ...leftTenant, value: toNumber(leftTenant.license.summary.estimated_revenue) }}
            right={{ ...rightTenant, value: toNumber(rightTenant.license.summary.estimated_revenue) }}
            formatValue={formatCurrency}
          />
        </div>
      </section>

      <section className="space-y-4">
        <SectionHeader
          title="Traffic and Usage Trends"
          description="Track how events and active users move over time. Use the toggle to switch between event volume and user volume while keeping the comparison structure unchanged."
          action={
            <div className="flex items-center rounded-full border border-slate-200 bg-white p-1 shadow-sm">
              {(['events', 'users'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setTrendMode(mode)}
                  className={`rounded-full cursor-pointer px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] transition-colors ${
                    trendMode === mode ? 'bg-[#1a73e8] text-white' : 'text-slate-500 hover:text-slate-900'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          }
        />
        <ChartContainer title={trendMode === 'events' ? 'Event Trend' : 'User Trend'} id="tenant-trend-chart">
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trendChartData} margin={{ top: 8, right: 20, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 12 }} axisLine={{ stroke: '#cbd5e1' }} tickLine={false} />
                <YAxis tick={{ fill: '#64748b', fontSize: 12 }} axisLine={{ stroke: '#cbd5e1' }} tickLine={false} />
                <Tooltip
                  contentStyle={{ borderRadius: '12px', borderColor: '#e2e8f0', background: '#ffffff' }}
                  labelStyle={{ color: '#0f172a', fontWeight: 600 }}
                />
                <Line type="monotone" dataKey={leftTenantId} name={leftTenant?.name || leftTenantId} stroke="#1a73e8" strokeWidth={3} dot={false} activeDot={{ r: 4 }} />
                <Line type="monotone" dataKey={rightTenantId} name={rightTenant?.name || rightTenantId} stroke="#334155" strokeWidth={3} dot={false} activeDot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Growth lead</p>
              <p className="mt-2 text-sm font-semibold text-slate-900">
                {(toNumber(leftTenant.comparison?.growth_rate) - toNumber(rightTenant.comparison?.growth_rate)) >= 0 ? leftTenant.name : rightTenant.name}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Trend divergence</p>
              <p className="mt-2 text-sm font-semibold text-slate-900">
                {Math.abs(toNumber(leftTenant.comparison?.growth_rate) - toNumber(rightTenant.comparison?.growth_rate)).toFixed(1)} percentage points
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Current snapshot</p>
              <p className="mt-2 text-sm font-semibold text-slate-900">Events and users are pulled directly from tenant-scoped APIs.</p>
            </div>
          </div>
        </ChartContainer>
      </section>

      <section className="space-y-4">
        <SectionHeader
          title="Feature Adoption Comparison"
          description="Normalized pro features only. Each row compares adoption percentage, usage count, active users, and the winning tenant."
        />
        <ChartContainer title="Feature Adoption Matrix" id="feature-adoption-matrix">
          <div className="overflow-x-auto">
            <table className="w-full min-w-245 text-left">
              <thead>
                <tr className="border-b border-slate-200 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                  <th className="pb-3 pr-4">Feature</th>
                  <th className="pb-3 pr-4">{leftTenant?.name || 'Left'}</th>
                  <th className="pb-3 pr-4">{rightTenant?.name || 'Right'}</th>
                  <th className="pb-3 pr-4">Winner</th>
                  <th className="pb-3">Insight</th>
                </tr>
              </thead>
              <tbody>
                {featureRows.slice(0, 10).map((row) => (
                  <tr key={row.feature} className="border-b border-slate-100 last:border-0 align-top">
                    <td className="py-4 pr-4">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">{row.label}</p>
                        <p className="mt-1 text-[11px] text-slate-400">{row.feature}</p>
                      </div>
                    </td>
                    <td className="py-4 pr-4">
                      <div className="space-y-2">
                        <p className="text-sm font-semibold text-slate-900">{formatPercent(row.leftAdoption)}</p>
                        <p className="text-[11px] text-slate-500">{formatCount(row.leftUsers)} active users</p>
                        <p className="text-[11px] text-slate-400">{formatCount(row.leftUsage)} usage events</p>
                      </div>
                    </td>
                    <td className="py-4 pr-4">
                      <div className="space-y-2">
                        <p className="text-sm font-semibold text-slate-900">{formatPercent(row.rightAdoption)}</p>
                        <p className="text-[11px] text-slate-500">{formatCount(row.rightUsers)} active users</p>
                        <p className="text-[11px] text-slate-400">{formatCount(row.rightUsage)} usage events</p>
                      </div>
                    </td>
                    <td className="py-4 pr-4">
                      <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                        {row.winner}
                      </span>
                    </td>
                    <td className="py-4 text-sm leading-6 text-slate-600">{row.insight}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartContainer>
      </section>

      <section className="space-y-4">
        <SectionHeader
          title="Pro Feature Utilization"
          description="Focuses on paid capabilities and flags where license capacity is not converting into actual usage."
        />
        <ChartContainer title="Utilization and Opportunity" id="pro-utilization">
          <div className="space-y-4">
            {topUtilizationRows.map((row) => (
              <div key={row.feature} className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{row.label}</p>
                    <p className="mt-1 text-[11px] text-slate-400">Combined usage across both tenants</p>
                  </div>
                  <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">{row.winner}</span>
                    <span className="rounded-full border border-slate-200 bg-white px-3 py-1">Gap {row.utilizationGap.toFixed(1)} pts</span>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.18em] text-slate-400">
                      <span>{leftTenant?.name || 'Left'}</span>
                      <span>{formatPercent(row.leftAdoption)}</span>
                    </div>
                    <div className="mt-2 h-2 rounded-full bg-slate-100">
                      <div className="h-full rounded-full bg-[#1a73e8]" style={{ width: `${Math.min(row.leftAdoption, 100)}%` }} />
                    </div>
                    <p className="mt-2 text-xs text-slate-500">{formatCount(row.leftUsers)} active users, {formatCount(row.leftUsage)} usage events</p>
                  </div>
                  <div>
                    <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.18em] text-slate-400">
                      <span>{rightTenant?.name || 'Right'}</span>
                      <span>{formatPercent(row.rightAdoption)}</span>
                    </div>
                    <div className="mt-2 h-2 rounded-full bg-slate-100">
                      <div className="h-full rounded-full bg-slate-700" style={{ width: `${Math.min(row.rightAdoption, 100)}%` }} />
                    </div>
                    <p className="mt-2 text-xs text-slate-500">{formatCount(row.rightUsers)} active users, {formatCount(row.rightUsage)} usage events</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </ChartContainer>
      </section>

      <section className="space-y-4">
        <SectionHeader
          title="Funnel Comparison"
          description="Login-to-conversion analysis for both tenants. The table emphasizes step-by-step conversion and drop-off differences."
        />
        <ChartContainer title="Conversion Funnel" id="tenant-funnel">
          <div className="overflow-x-auto">
            <table className="w-full min-w-225 text-left">
              <thead>
                <tr className="border-b border-slate-200 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                  <th className="pb-3 pr-4">Step</th>
                  <th className="pb-3 pr-4">{leftTenant?.name || 'Left'} Conversion</th>
                  <th className="pb-3 pr-4">{rightTenant?.name || 'Right'} Conversion</th>
                  <th className="pb-3 pr-4">Drop-off</th>
                  <th className="pb-3">Winner</th>
                </tr>
              </thead>
              <tbody>
                {funnelRows.map((row) => (
                  <tr key={row.step} className="border-b border-slate-100 last:border-0">
                    <td className="py-4 pr-4">
                      <p className="text-sm font-semibold text-slate-900">{row.step}</p>
                      <p className="mt-1 text-[11px] text-slate-400">Step {row.index}</p>
                    </td>
                    <td className="py-4 pr-4">
                      <div className="space-y-2">
                        <p className="text-sm font-semibold text-slate-900">{formatPercent(row.leftRate)}</p>
                        <div className="h-1.5 rounded-full bg-slate-100"><div className="h-full rounded-full bg-[#1a73e8]" style={{ width: `${Math.min(row.leftRate, 100)}%` }} /></div>
                        <p className="text-[11px] text-slate-500">{formatCount(row.leftUsers)} users</p>
                      </div>
                    </td>
                    <td className="py-4 pr-4">
                      <div className="space-y-2">
                        <p className="text-sm font-semibold text-slate-900">{formatPercent(row.rightRate)}</p>
                        <div className="h-1.5 rounded-full bg-slate-100"><div className="h-full rounded-full bg-slate-700" style={{ width: `${Math.min(row.rightRate, 100)}%` }} /></div>
                        <p className="text-[11px] text-slate-500">{formatCount(row.rightUsers)} users</p>
                      </div>
                    </td>
                    <td className="py-4 pr-4 text-sm text-slate-600">
                      {leftTenant?.name || 'Left'} {row.leftDropOff.toFixed(1)}% / {rightTenant?.name || 'Right'} {row.rightDropOff.toFixed(1)}%
                    </td>
                    <td className="py-4">
                      <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                        {row.winner === 'left' ? (leftTenant?.name || 'Left') : row.winner === 'right' ? (rightTenant?.name || 'Right') : 'Even'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartContainer>
      </section>

      <section className="space-y-4">
        <SectionHeader
          title="User Behavior Insights"
          description="Behavioral context derived from session time, events per user, and retention."
        />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {retentionSummary.map((tenant) => (
            <div key={tenant.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-sm font-semibold text-slate-900">{tenant.name}</p>
              <div className="mt-4 space-y-4">
                <div>
                  <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.18em] text-slate-400">
                    <span>Avg session length</span>
                    <span>{formatDuration(tenant.sessionSeconds)}</span>
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.18em] text-slate-400">
                    <span>Events per user</span>
                    <span>{tenant.eventsPerUser.toFixed(1)}</span>
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.18em] text-slate-400">
                    <span>Retention</span>
                    <span>{formatPercent(tenant.retentionPct)}</span>
                  </div>
                  <div className="mt-2 h-2 rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-[#1a73e8]" style={{ width: `${Math.min(tenant.retentionPct, 100)}%` }} />
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <SectionHeader
          title="Performance Metrics"
          description="Operational health metrics for both tenants. Lower response time and error rate are better; success rate is derived from error rate."
        />
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          {[
            {
              label: 'Avg Response Time',
              left: performanceSummary[0].avgResponseTime,
              right: performanceSummary[1].avgResponseTime,
              format: (value: number) => `${value.toFixed(0)} ms`,
              higherIsBetter: false,
            },
            {
              label: 'Error Rate',
              left: performanceSummary[0].errorRate,
              right: performanceSummary[1].errorRate,
              format: formatPercent,
              higherIsBetter: false,
            },
            {
              label: 'Success Rate',
              left: performanceSummary[0].successRate,
              right: performanceSummary[1].successRate,
              format: formatPercent,
              higherIsBetter: true,
            },
          ].map((metric) => (
            <ComparisonMetricCard
              key={metric.label}
              title={metric.label}
              left={{ ...leftTenant, value: metric.left }}
              right={{ ...rightTenant, value: metric.right }}
              formatValue={metric.format}
              higherIsBetter={metric.higherIsBetter}
            />
          ))}
        </div>
      </section>

      <section className="space-y-4 pb-4">
        <SectionHeader
          title="Anomalies and Insights"
          description="Actionable, data-driven observations generated from the comparison itself. No fallback copy and no fabricated metrics."
        />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {insights.map((insight) => (
            <div key={insight.title} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">{insight.title}</p>
              <p className="mt-3 text-sm leading-6 text-slate-700">{insight.message}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
