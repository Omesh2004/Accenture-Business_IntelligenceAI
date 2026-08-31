/**
 * Loading skeleton components for every page in the dashboard.
 * Uses shimmer animation via animate-pulse on a gradient background.
 * Each skeleton matches the approximate dimensions of its corresponding widget.
 */

import React from 'react';

/* ─────────────── Base Primitives ─────────────── */

function SkeletonBlock({ className = '' }: { className?: string }) {
  return (
    <div
      className={`animate-pulse bg-linear-to-r from-gray-100 via-gray-200 to-gray-100 bg-size-[400%_100%] rounded-lg ${className}`}
      style={{ animation: 'shimmer 1.8s infinite linear' }}
    />
  );
}

/* ─────────────── Small Widgets ─────────────── */

export function KPICardSkeleton() {
  return (
    <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 flex flex-col justify-between h-26">
      <div className="flex items-center gap-2 mb-3">
        <SkeletonBlock className="w-4 h-4 rounded" />
        <SkeletonBlock className="h-4 w-24" />
      </div>
      <div className="flex justify-between items-end">
        <SkeletonBlock className="h-8 w-20" />
        <SkeletonBlock className="h-6 w-16" />
      </div>
    </div>
  );
}

export function ChartSkeleton({ height = 'h-64' }: { height?: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-5 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <SkeletonBlock className="h-5 w-40" />
        <SkeletonBlock className="h-7 w-32 rounded-lg" />
      </div>
      <SkeletonBlock className={`w-full ${height}`} />
    </div>
  );
}

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-5 shadow-sm">
      <SkeletonBlock className="h-5 w-40 mb-4" />
      <div className="space-y-3">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-4">
            <SkeletonBlock className="h-4 w-28" />
            <SkeletonBlock className="h-4 flex-1" />
            <SkeletonBlock className="h-4 w-12" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function HeatmapTableSkeleton({ rows = 8, cols = 7 }: { rows?: number; cols?: number }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
      {/* Legend and Description */}
      <div className="px-5 pt-5 pb-4 border-b border-gray-100 space-y-3">
        <SkeletonBlock className="h-4 w-64" />
        <div className="flex items-center gap-2 pt-2">
          <SkeletonBlock className="h-3 w-20" />
          <div className="flex h-3 items-center gap-0.5">
            {Array.from({ length: 11 }).map((_, i) => (
              <div key={i} className="h-3 w-3 bg-gray-100 rounded-sm" />
            ))}
          </div>
          <SkeletonBlock className="h-3 w-16" />
        </div>
      </div>

      {/* Table Structure */}
      <div className="px-5 py-4 max-w-full overflow-x-auto">
        <table className="w-full min-w-[920px] table-fixed lg:min-w-full border-collapse">
          <colgroup>
            <col style={{ width: '16%' }} />
            {Array.from({ length: cols }).map((_, i) => (
              <col key={`col-${i}`} style={{ width: `${78 / cols}%` }} />
            ))}
            <col style={{ width: '6%' }} />
          </colgroup>

          <thead className="sticky top-0 z-10">
            <tr className="bg-white/95 backdrop-blur-sm">
              <th className="sticky left-0 z-20 border-b border-gray-100 bg-white px-3 py-3 text-left">
                <SkeletonBlock className="h-3 w-12" />
              </th>
              {Array.from({ length: cols }).map((_, i) => (
                <th
                  key={`header-${i}`}
                  className="border-b border-gray-100 px-1 py-3 text-center"
                >
                  <SkeletonBlock className="h-3 w-14 mx-auto" />
                </th>
              ))}
              <th className="border-b border-gray-100 px-3 py-3 text-right">
                <SkeletonBlock className="h-3 w-10" />
              </th>
            </tr>
          </thead>

          <tbody>
            {Array.from({ length: rows }).map((_, rowIdx) => (
              <tr key={rowIdx} className="group align-middle border-b border-gray-50">
                <td className="sticky left-0 z-20 border-r border-gray-100 bg-white px-3 py-3">
                  <SkeletonBlock className="h-3 w-16" />
                </td>
                {Array.from({ length: cols }).map((_, colIdx) => (
                  <td key={`cell-${rowIdx}-${colIdx}`} className="p-0">
                    <div className="flex h-11 w-full items-center justify-center border-r border-gray-50 bg-gray-100">
                      <SkeletonBlock className="h-3 w-6" />
                    </div>
                  </td>
                ))}
                <td className="border-l border-gray-100 px-3 py-3">
                  <SkeletonBlock className="h-3 w-10" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SidebarSkeleton() {
  return (
    <div className="w-56 bg-white border-r border-gray-100 p-4 space-y-6">
      <SkeletonBlock className="h-8 w-32 mb-8" />
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <SkeletonBlock className="w-5 h-5 rounded" />
          <SkeletonBlock className="h-4 w-24" />
        </div>
      ))}
    </div>
  );
}

/* ─────────────── Page-Level Skeletons ─────────────── */

/** Main /dashboard page skeleton */
export function DashboardSkeleton() {
  return (
    <div className="animate-in fade-in duration-300 space-y-6">
      {/* KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <KPICardSkeleton key={i} />
        ))}
      </div>

      {/* Traffic + Real-Time */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <ChartSkeleton height="h-72" />
        </div>
        <ChartSkeleton height="h-72" />
      </div>

      {/* AI Insights */}
      <ChartSkeleton height="h-24" />

      {/* Location Map */}
      <ChartSkeleton height="h-96" />

      {/* Bottom row: Pages + Device + Acquisition */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <ChartSkeleton height="h-52" />
        <ChartSkeleton height="h-52" />
        <ChartSkeleton height="h-52" />
      </div>

      {/* Secondary KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <KPICardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

/** /features page skeleton */
export function FeaturePageSkeleton() {
  return (
    <div className="animate-in fade-in duration-300 space-y-6">
      {/* Info Cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-gray-100 bg-white px-4 py-3 space-y-2">
            <div className="flex items-center gap-2">
              <SkeletonBlock className="h-3.5 w-3.5 rounded" />
              <SkeletonBlock className="h-3 w-20" />
            </div>
            <SkeletonBlock className="h-4 w-28" />
          </div>
        ))}
      </div>

      {/* Filter & Controls Row */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <SkeletonBlock className="h-9 w-40 rounded-lg" />
          <SkeletonBlock className="h-9 w-32 rounded-lg" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SkeletonBlock className="h-6 w-32 rounded-md" />
          <SkeletonBlock className="h-6 w-28 rounded-md" />
          <SkeletonBlock className="h-6 w-36 rounded-md" />
        </div>
      </div>

      {/* Feature Usage & Top Features Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ChartSkeleton height="h-72" />
        <ChartSkeleton height="h-72" />
      </div>

      {/* Heatmap Table */}
      <HeatmapTableSkeleton rows={8} cols={7} />
    </div>
  );
}

/** /funnel page skeleton */
export function FunnelPageSkeleton() {
  return (
    <div className="animate-in fade-in duration-300 space-y-6">
      <ChartSkeleton height="h-96" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartSkeleton height="h-64" />
        <ChartSkeleton height="h-64" />
      </div>
    </div>
  );
}

/** /tenants page skeleton */
export function TenantsPageSkeleton() {
  return (
    <div className="animate-in fade-in duration-300 space-y-8">
      {/* Hero */}
      <div className="rounded-4xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-3 w-full max-w-3xl">
            <SkeletonBlock className="h-3 w-48" />
            <SkeletonBlock className="h-9 w-96" />
            <SkeletonBlock className="h-4 w-full" />
            <SkeletonBlock className="h-4 w-5/6" />
          </div>
          <div className="h-12 w-64 rounded-full border border-gray-200 bg-gray-100 p-1.5">
            <SkeletonBlock className="h-full w-full rounded-full" />
          </div>
        </div>
        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-gray-200 bg-white p-4">
              <SkeletonBlock className="h-3 w-20" />
              <SkeletonBlock className="h-6 w-28 mt-3" />
              <SkeletonBlock className="h-4 w-24 mt-2" />
            </div>
          ))}
        </div>
      </div>

      {/* Overview KPI cards */}
      <div className="space-y-4">
        <SkeletonBlock className="h-6 w-72" />
        <SkeletonBlock className="h-4 w-2/3" />
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <SkeletonBlock className="h-4 w-32" />
                <SkeletonBlock className="h-6 w-24 rounded-full" />
              </div>
              <div className="mt-5 grid grid-cols-2 gap-4">
                <SkeletonBlock className="h-20 w-full" />
                <SkeletonBlock className="h-20 w-full" />
              </div>
              <SkeletonBlock className="h-2 w-full mt-4" />
              <div className="mt-3 flex justify-between">
                <SkeletonBlock className="h-3 w-28" />
                <SkeletonBlock className="h-3 w-24" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Trend */}
      <div className="space-y-4">
        <SkeletonBlock className="h-6 w-64" />
        <SkeletonBlock className="h-4 w-2/3" />
        <ChartSkeleton height="h-80" />
      </div>

      {/* Tables */}
      <div className="space-y-4">
        <SkeletonBlock className="h-6 w-72" />
        <SkeletonBlock className="h-4 w-2/3" />
        <TableSkeleton rows={10} />
      </div>

      <div className="space-y-4">
        <SkeletonBlock className="h-6 w-72" />
        <SkeletonBlock className="h-4 w-2/3" />
        <TableSkeleton rows={8} />
      </div>

      {/* Bottom cards */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <SkeletonBlock className="h-4 w-28" />
            <SkeletonBlock className="h-20 w-full mt-4" />
            <SkeletonBlock className="h-2 w-full mt-4" />
          </div>
        ))}
      </div>

      {/* Insights */}
      <div className="space-y-4">
        <SkeletonBlock className="h-6 w-60" />
        <SkeletonBlock className="h-4 w-2/3" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <SkeletonBlock className="h-3 w-32" />
              <SkeletonBlock className="h-4 w-full mt-4" />
              <SkeletonBlock className="h-4 w-5/6 mt-2" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** /license-usage page skeleton */
export function LicensePageSkeleton() {
  return (
    <div className="animate-in fade-in duration-300 space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <KPICardSkeleton key={i} />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TableSkeleton rows={6} />
        <TableSkeleton rows={6} />
      </div>
    </div>
  );
}

/** /governance, /user-journey, /settings, /predictive, /transparency pages */
export function GenericPageSkeleton() {
  return (
    <div className="animate-in fade-in duration-300 space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <KPICardSkeleton key={i} />
        ))}
      </div>
      <ChartSkeleton height="h-72" />
      <TableSkeleton rows={5} />
    </div>
  );
}

/** /predictive page skeleton */
export function PredictivePageSkeleton() {
  return (
    <div className="animate-in fade-in duration-300 space-y-6">
      {/* Header Section */}
      <div className="flex justify-between items-center flex-wrap gap-4">
        <div className="flex-1">
          <SkeletonBlock className="h-6 w-72 mb-2" />
          <SkeletonBlock className="h-4 w-96" />
        </div>
        <SkeletonBlock className="h-10 w-56" />
      </div>

      {/* KPI Cards (5 cards) */}
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <article key={i} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <SkeletonBlock className="h-3 w-24 mb-2" />
            <SkeletonBlock className="h-8 w-16 mt-2" />
          </article>
        ))}
      </section>

      {/* Opportunity Radar + Model Pulse Section */}
      <section className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <article className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm xl:col-span-2">
          <SkeletonBlock className="h-5 w-48 mb-3" />
          <SkeletonBlock className="h-4 w-96 mb-4" />
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="rounded-lg border border-gray-200 bg-gray-100 p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <SkeletonBlock className="h-4 w-32" />
                  <SkeletonBlock className="h-5 w-20 rounded-full" />
                </div>
                <SkeletonBlock className="h-2 w-full" />
                <div className="mt-2 flex items-center justify-between">
                  <SkeletonBlock className="h-3 w-20" />
                  <SkeletonBlock className="h-3 w-24" />
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <SkeletonBlock className="h-5 w-40 mb-4" />
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="rounded-lg border border-gray-200 bg-gray-100 p-3">
                <SkeletonBlock className="h-3 w-28 mb-2" />
                <SkeletonBlock className="h-6 w-20 mt-1" />
              </div>
            ))}
          </div>
        </article>
      </section>

      {/* Anomaly Alerts Section *)}
      <div className="rounded-xl border border-gray-200 bg-white mt-6">
        <div className="px-6 py-4 border-b border-gray-200">
          <SkeletonBlock className="h-5 w-40 mb-2" />
          <SkeletonBlock className="h-3 w-56" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                {Array.from({ length: 4 }).map((_, i) => (
                  <th key={i} className="px-6 py-3">
                    <SkeletonBlock className="h-3 w-20" />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 3 }).map((_, i) => (
                <tr key={i} className="border-b border-gray-100">
                  {Array.from({ length: 4 }).map((_, j) => (
                    <td key={j} className="px-6 py-4">
                      <SkeletonBlock className="h-3 w-24" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Predictions Table */}
      <div className="rounded-xl border border-gray-200 bg-white">
        <div className="px-6 py-4 border-b border-gray-200">
          <SkeletonBlock className="h-5 w-48 mb-2" />
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-[1200px] w-full">
            <thead className="text-[13px] text-gray-500 font-medium border-y border-gray-200 bg-gray-100/50">
              <tr>
                {Array.from({ length: 7 }).map((_, i) => (
                  <th key={i} className="px-4 py-3">
                    <SkeletonBlock className="h-3 w-20" />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="border-b border-gray-100">
                  {Array.from({ length: 7 }).map((_, j) => (
                    <td key={j} className="px-4 py-3">
                      <SkeletonBlock className="h-3 w-24" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Score Legend */}
      <div className="flex items-center justify-evenly flex-wrap gap-4 text-xs text-gray-500 p-4 bg-white rounded-lg border border-gray-200">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <SkeletonBlock className="w-3 h-3 rounded-full" />
            <SkeletonBlock className="h-3 w-32" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** /ai-report page skeleton */
export function AIReportPageSkeleton() {
  return (
    <div className="animate-in fade-in duration-300 space-y-4">
      <SkeletonBlock className="h-8 w-64 mb-6" />
      {Array.from({ length: 6 }).map((_, i) => (
        <SkeletonBlock key={i} className={`h-4 w-${i % 3 === 2 ? '3/4' : 'full'}`} />
      ))}
      <SkeletonBlock className="h-4 w-1/2 mt-4" />
    </div>
  );
}
