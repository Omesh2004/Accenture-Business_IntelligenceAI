"use client";

import React, { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { dashboardAPI } from '@/lib/api';
import { useDashboardData } from '@/hooks/useDashboard';
import { useRealtimeEvents } from '@/hooks/useRealtimeEvents';
import { TableSkeleton, KPICardSkeleton, ChartSkeleton, LicensePageSkeleton } from '@/components/Skeletons';

import {
  Key,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Loader2,
  Users,
  DollarSign,
  Shield,
  Zap,
  BarChart3,
  ArrowUpRight,
  ArrowDownRight,
  Crown,
  RefreshCw,
  Sparkles,
  Activity,
  Bitcoin,
  Scale,
  Briefcase,
  FileText
} from 'lucide-react';


import ChartContainer from '@/components/ChartContainer';
import { toast } from 'sonner';

/* ─── Types ─── */

interface TrendPoint { date: string; count: number }

interface LicensedFeature {
  feature_name: string;
  display_name: string;
  plan_tier: string;
  is_used: boolean;
  usage_count: number;
  unique_users: number;
  usage_pct: number;
  trend: TrendPoint[];
}

interface UnlicensedFeature {
  feature_name: string;
  display_name: string;
  usage_count: number;
  unique_users: number;
  usage_pct: number;
}

interface LicenseSummary {
  total_licensed: number;
  total_used: number;
  total_used_licensed: number;
  waste_pct: number;
  pro_users: number;
  total_users: number;
  pro_adoption_pct: number;
  estimated_revenue: number;
  wow_change: number;
}

interface LicenseData {
  summary: LicenseSummary;
  licensed: LicensedFeature[];
  unused_licensed: LicensedFeature[];
  unlicensed_used: UnlicensedFeature[];
}

/* ─── Helpers ─── */

const FEATURE_LABELS: Record<string, { label: string; description: string }> = {
  'pro.crypto_trade_execution.success': { label: 'Crypto Trade execution', description: 'Real-time crypto buy/sell execution' },
  'pro.crypto_trade_execution.failed': { label: 'Crypto Trade Failed', description: 'Unsuccessful trade attempt' },
  'pro.crypto_price_feeds.view': { label: 'Crypto Price feeds', description: 'Live asset price monitoring' },
  'pro.crypto_portfolio.view': { label: 'Crypto Portfolio', description: 'User digital asset holdings' },
  'pro.wealth_rebalance.success': { label: 'Wealth Rebalancing', description: 'AI-driven portfolio rebalancing' },
  'pro.wealth_rebalance.failed': { label: 'Rebalancing Failed', description: 'Unsuccessful portfolio adjustment' },
  'pro.wealth_insights.view': { label: 'Investment Insights', description: 'Personalized wealth analytics' },
  'pro.payroll_batch.success': { label: 'Payroll Batch Process', description: 'Mass salary disbursement processing' },
  'pro.payroll_batch.failed': { label: 'Payroll Batch Failed', description: 'Failed salary bulk operation' },
  'pro.payroll_payees.view': { label: 'Payroll Payee List', description: 'Viewing payroll recipients' },
  'pro.payroll_search.success': { label: 'Payroll Search', description: 'Searching for new payroll payees' },
  'pro.payroll_search.failed': { label: 'Payroll Search Failed', description: 'Search operation timeout/failure' },
  'pro.finance_library_book.access': { label: 'Premium Library Access', description: 'Downloaded financial resources' },
  'pro.finance_library_stats.view': { label: 'Financial Statistics', description: 'Advanced financial data visualization' },
  'pro.features.view': { label: 'Pro Feature Explorer', description: 'Browsing available platform upgrades' },
  'pro.features_unlock.success': { label: 'Feature Activation', description: 'Successful license entitlement gain' },
  'pro.features_unlock.failed': { label: 'Activation Failed', description: 'Insufficient funds or verification error' },
};

function featureLabel(name: string): string {
  let label = FEATURE_LABELS[name]?.label;
  if (label) return label;

  // Clean technical prefixes
  let cleaned = name
    .replace(/^pro\./i, '')
    .replace(/^core\./i, '')
    .replace(/^auth\./i, '')
    .replace(/^payroll-pro\./i, '');

  // If dot-separated, take segments
  const parts = cleaned.split('.');
  if (parts.length > 1) {
    cleaned = parts.slice(-2).join(' ');
  }

  return cleaned.replace(/[._-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function featureDescription(name: string): string {
  return FEATURE_LABELS[name]?.description || 'Enterprise feature';
}

function formatCurrency(n: number): string {
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  if (n >= 1000) return `₹${(n / 1000).toFixed(1)}K`;
  return `₹${n.toLocaleString('en-IN')}`;
}

/* ─── Sparkline Mini Chart ─── */
function Sparkline({ data, color = '#7C3AED', height = 32 }: { data: TrendPoint[]; color?: string; height?: number }) {
  if (!data || data.length < 2) {
    return <div className="text-xs text-gray-300 italic">No trend data</div>;
  }
  const vals = data.map(d => d.count);
  const max = Math.max(...vals, 1);
  const min = Math.min(...vals, 0);
  const range = max - min || 1;
  const w = 100;
  const points = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * w;
    const y = height - ((v - min) / range) * (height - 4);
    return `${x},${y}`;
  }).join(' ');

  return (
    <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} className="overflow-visible">
      <defs>
        <linearGradient id={`grad-${color.replace('#', '')}`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <polygon
        points={`0,${height} ${points} ${w},${height}`}
        fill={`url(#grad-${color.replace('#', '')})`}
      />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ─── Donut Chart ─── */
function DonutChart({ value, max, label, color }: { value: number; max: number; label: string; color: string }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;

  return (
    <div className="flex flex-col items-center">
      <div className="relative w-24 h-24">
        <svg className="w-24 h-24 -rotate-90" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r={radius} fill="none" stroke="#F3F4F6" strokeWidth="8" />
          <circle
            cx="50" cy="50" r={radius} fill="none"
            stroke={color} strokeWidth="8"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            className="transition-all duration-1000 ease-out"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-bold text-gray-900">{Math.round(pct)}%</span>
        </div>
      </div>
      <span className="text-xs text-gray-500 mt-2 text-center">{label}</span>
    </div>
  );
}

/* ─── Usage Bar ─── */
function UsageBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
      <div
        className="h-2 rounded-full transition-all duration-700 ease-out"
        style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: color }}
      />
    </div>
  );
}


/* ═══════════════════════════ MAIN PAGE ═══════════════════════════ */

export default function LicenseUsagePage() {
  const { tenantsParam, rangeParam, selectedTenants, timeRange } = useDashboardData();
  const { lastEvent } = useRealtimeEvents({ maxEvents: 1 });
  const lastRealtimeRefetchAt = useRef(0);
  const [seeding, setSeeding] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'licensed' | 'free'>('overview');

  const { data, isLoading: loading, isFetching, refetch: fetchData } = useQuery({
    queryKey: ['licenseUsage', tenantsParam, rangeParam],
    queryFn: () => dashboardAPI.getLicenseUsage(tenantsParam, rangeParam),
    staleTime: 20 * 1000,
    refetchInterval: 20 * 1000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  const { data: proUsersData, isLoading: proUsersLoading, refetch: refetchProUsers } = useQuery({
    queryKey: ['proUsers', tenantsParam, rangeParam],
    queryFn: () => dashboardAPI.getProUsers(tenantsParam, rangeParam),
    staleTime: 20 * 1000,
    refetchInterval: 20 * 1000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (!lastEvent) return;
    const now = Date.now();
    if (now - lastRealtimeRefetchAt.current < 5000) return;
    lastRealtimeRefetchAt.current = now;
    void fetchData();
    void refetchProUsers();
  }, [lastEvent, fetchData, refetchProUsers]);

  const summary = (data as LicenseData | undefined)?.summary;
  const hasWastedLicenses = (summary?.waste_pct || 0) > 20;
  // Use canonical licensed list — deduplicated by feature_name
  const seenFeatures = new Set<string>();
  const licensedFeatures = [...((data as LicenseData | undefined)?.licensed || []), ...((data as LicenseData | undefined)?.unused_licensed || [])].filter(f => {
    if (seenFeatures.has(f.feature_name)) return false;
    seenFeatures.add(f.feature_name);
    return true;
  });
  const unlicensedFeatures = (data as LicenseData | undefined)?.unlicensed_used || [];
  const sortedLicensedFeatures = [...licensedFeatures].sort((a, b) => b.usage_count - a.usage_count);
  const sortedUnlicensedFeatures = [...unlicensedFeatures].sort((a, b) => b.usage_count - a.usage_count);
  const hasData = licensedFeatures.length > 0;

  /* ─── Seed Handler ─── */
  const handleSeedLicenses = async () => {
    try {
      setSeeding(true);
      const features = [
        { feature_name: "pro.crypto-trading.trade_execute", is_licensed: true, plan_tier: "enterprise" },
        { feature_name: "pro.wealth-management.rebalance", is_licensed: true, plan_tier: "enterprise" },
        { feature_name: "pro.payroll-pro.batch_process", is_licensed: true, plan_tier: "enterprise" },
        { feature_name: "pro.finance-library.book_access", is_licensed: true, plan_tier: "enterprise" },
      ];
      await dashboardAPI.syncLicenses(tenantsParam, features);
      await fetchData();
      toast.success('Enterprise licenses synced successfully');
    } catch {
      toast.error('Failed to sync licenses');
    } finally {
      setSeeding(false);
    }
  };

  /* ─── Loading ─── */
  if (loading) {
    return (
      <div className="animate-in fade-in duration-500 space-y-6">
        <div className="space-y-2">
          <div className="h-7 w-72 rounded-lg bg-gray-100 animate-pulse" />
          <div className="h-4 w-96 rounded-lg bg-gray-100 animate-pulse" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, idx) => (
            <KPICardSkeleton key={idx} />
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <ChartSkeleton height="h-48" />
          <div className="lg:col-span-2">
            <ChartSkeleton height="h-48" />
          </div>
        </div>

        <TableSkeleton rows={6} />
      </div>
    );
  }

  return (
    <div className="animate-in fade-in duration-500 space-y-6">

      {/* ─── Page Header ─── */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-[22px] font-semibold text-gray-900 tracking-tight">
              Enterprise License Usage
            </h1>
          </div>
          <p className="text-sm text-gray-500 mt-1.5 ml-[42px]">
            Track paid Pro features vs actual usage across <strong className="text-gray-700">{selectedTenants.join(', ')}</strong> &middot; {timeRange}
          </p>
        </div>
        <div className="flex items-center gap-2 ml-[42px] sm:ml-0">
          <button
            onClick={() => fetchData()}
            className="px-3 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-100 transition-colors flex items-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
          </button>
          {!hasData && (
            <button
              onClick={handleSeedLicenses}
              disabled={seeding}
              className="px-4 py-2 bg-violet-600 text-white text-sm font-medium rounded-lg hover:bg-violet-700 transition-colors flex items-center gap-2 disabled:opacity-50 cursor-pointer shadow-sm"
            >
              {seeding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              Initialize Licenses
            </button>
          )}
        </div>
      </div>

      {/* ─── Alert ─── */}
      {hasData && summary && hasWastedLicenses && (
        <div className="bg-white border bg-yellow-100 border-yellow-400 border-l-4 text-gray-800 rounded-xl p-4 flex items-start gap-3 shadow-sm">
          <div>
            <h3 className="text-sm font-semibold">License Optimization Alert</h3>
            <p className="text-sm mt-0.5 text-gray-700">
              <strong>{(data as LicenseData | undefined)?.unused_licensed?.length ?? 0}</strong> enterprise licenses are inactive.
              You could save up to <strong>{formatCurrency(((data as LicenseData | undefined)?.unused_licensed?.length ?? 0) * (summary?.pro_users ?? 0) * 500)}</strong>/month
              by reviewing your plan — current waste is at <strong>{summary.waste_pct}%</strong>.
            </p>
          </div>
        </div>
      )}

      {/* ─── Empty State ─── */}
      {!hasData && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-16 text-center">
          <div className="inline-flex p-4 bg-violet-50 rounded-2xl mb-4">
            <Key className="h-8 w-8 text-violet-400" />
          </div>
          <h2 className="text-lg font-semibold text-gray-900 mb-2">No Enterprise Licenses Found</h2>
          <p className="text-sm text-gray-500 max-w-md mx-auto mb-6">
            This tenant doesn&apos;t have enterprise licenses configured yet. Initialize them to start tracking Pro feature usage and ROI.
          </p>
          <button
            onClick={handleSeedLicenses}
            disabled={seeding}
            className="px-5 py-2.5 bg-violet-600 text-white text-sm font-medium rounded-lg hover:bg-violet-700 transition-colors inline-flex items-center gap-2 disabled:opacity-50 cursor-pointer shadow-sm"
          >
            {seeding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Initialize Enterprise Licenses
          </button>
        </div>
      )}

      {hasData && summary && (
        <>
          {/* ─── KPI Row 1: Primary Metrics ─── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 stagger-children">

            {/* Enterprise Licensed */}
            <div className="bg-white border-gray-200 border-t-4 border-t-[#1a73e8] rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-center justify-between mb-3">
                <div className="p-2 border border-gray-200 bg-white rounded-lg">
                  <Shield className="h-4 w-4 text-gray-700" />
                </div>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-white border border-gray-200 text-gray-700">
                  Licensed
                </span>
              </div>
              <p className="text-3xl font-bold text-gray-900">{summary.total_licensed}</p>
              <p className="text-xs text-gray-500 mt-1">Enterprise features with active license</p>
              <div className="mt-3 pt-3 border-t border-gray-50 flex items-center text-xs text-gray-400">
                <CheckCircle className="h-3 w-3 mr-1 text-green-500" />
                {summary.total_used_licensed} actively used
              </div>
            </div>

            {/* Pro Users */}
            <div className="bg-white border-gray-200 border-t-4 border-t-[#1a73e8] rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-center justify-between mb-3">
                <div className="p-2 border border-gray-200 bg-white rounded-lg">
                  {proUsersLoading ? (
                    <Loader2 className="h-4 w-4 text-gray-400 animate-spin" />
                  ) : (
                    <Users className="h-4 w-4 text-gray-700" />
                  )}
                </div>
                <span className="text-xs font-medium text-gray-600 px-2 py-1 bg-blue-50 rounded">
                  {timeRange}
                </span>
              </div>
              <p className="text-3xl font-bold text-gray-900">
                {proUsersLoading ? '—' : proUsersData?.pro_users ?? 0}
              </p>
              <p className="text-xs text-gray-500 mt-1">Pro users in {timeRange.toLowerCase()}</p>
              <div className="mt-3 pt-3 border-t border-gray-50">
                {!proUsersLoading && proUsersData && (
                  <>
                    <UsageBar pct={proUsersData.pro_adoption_pct} color="#1a73e8" />
                    <p className="text-[10px] text-gray-400 mt-1">{proUsersData.pro_adoption_pct}% of {proUsersData.total_users} total users</p>
                  </>
                )}
                {proUsersLoading && (
                  <div className="h-2 bg-gray-100 rounded-full animate-pulse mt-2" />
                )}
              </div>
            </div>

            {/* Est. Revenue */}
            <div className="bg-white border-gray-200 border-t-4 border-t-[#1a73e8] rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-center justify-between mb-3">
                <div className="p-2 border border-gray-200 bg-white rounded-lg">
                  <DollarSign className="h-4 w-4 text-gray-700" />
                </div>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-white border border-gray-200 text-gray-700">
                  Revenue
                </span>
              </div>
              <p className="text-3xl font-bold text-gray-900">{formatCurrency(summary.estimated_revenue)}</p>
              <p className="text-xs text-gray-500 mt-1">Estimated license revenue / month</p>
              <div className="mt-3 pt-3 border-t border-gray-50 text-xs text-gray-400">
                ₹2,000 × {summary.pro_users} pro users
              </div>
            </div>

            {/* License Waste */}
            <div className="bg-white border-red-200 border-t-4 border-t-[#e83c1a] rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-center justify-between mb-3">
                <div className="p-2 border border-gray-200 bg-white rounded-lg">
                  <XCircle className="h-4 w-4 text-gray-700" />
                </div>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-white border border-gray-200 text-gray-700">
                  {summary.waste_pct > 20 ? 'ALERT' : 'OPTIMAL'}
                </span>
              </div>
              <p className="text-3xl font-bold text-gray-900">
                {summary.waste_pct}%
              </p>
              <p className="text-xs text-gray-500 mt-1">License waste rate</p>
              <div className="mt-3 pt-3 border-t border-gray-50">
                <UsageBar pct={100 - summary.waste_pct} color={summary.waste_pct > 20 ? '#1a73e8' : '#1a73e8'} />
                <p className="text-[10px] text-gray-400 mt-1">{summary.total_used_licensed}/{summary.total_licensed} licenses active</p>
              </div>
            </div>
          </div>

          {/* ─── KPI Row 2: Donut Charts ─── */}
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 items-start">

            {/* 1 column */}
            <ChartContainer
              title="License Utilization"
              id="license-utilization"
              className="lg:col-span-1"
            >
              <div className="flex flex-col justify-between h-full py-6 gap-3">
                <div className="flex items-center justify-center lg:flex-col flex-1 gap-5">
                  <DonutChart
                    value={summary.total_used_licensed}
                    max={summary.total_licensed}
                    label="Licenses Used"
                    color="#1a73e8"
                  />
                  <DonutChart
                    value={summary.pro_users}
                    max={summary.total_users}
                    label="Pro Adoption"
                    color="#4285F4"
                  />
                </div>
              </div>
            </ChartContainer>

            {/* 3 columns */}
            <ChartContainer
              title="Pro Features — Active Usage"
              id="feature-distribution"
              className="lg:col-span-3"
            >
              <div className="space-y-3 py-2">
                {sortedLicensedFeatures.filter(f => f.is_used).length > 0 ? (
                  sortedLicensedFeatures.filter(f => f.is_used).map((f, i) => (
                    <div key={i} className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium text-gray-900">
                            {f.display_name}
                          </span>
                          <span className="text-xs font-mono text-gray-500 ml-2">
                            {f.usage_count.toLocaleString()} events
                          </span>
                        </div>

                        <div className="flex items-center gap-2">
                          <div className="flex-1">
                            <UsageBar
                              pct={f.usage_pct}
                              color="#1a73e8"
                            />
                          </div>
                          <span className="text-[10px] font-medium text-gray-400 w-10 text-right">
                            {f.usage_pct}%
                          </span>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-center py-6 text-gray-400 text-sm">
                    No active enterprise feature usage detected
                  </div>
                )}
              </div>
            </ChartContainer>

          </div>

          {/* ─── Tabs ─── */}
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1 w-fit">
            {[
              { key: 'overview' as const, label: 'Overview', icon: BarChart3 },
              { key: 'licensed' as const, label: `Pro Features (${licensedFeatures.length})`, icon: Crown },
              { key: 'free' as const, label: `Free Features (${unlicensedFeatures.length})`, icon: Zap },
            ].map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-4 py-2 text-sm font-medium rounded-md flex items-center gap-1.5 transition-all cursor-pointer ${activeTab === tab.key
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
                  }`}
              >
                <tab.icon className="h-3.5 w-3.5" />
                {tab.label}
              </button>
            ))}
          </div>

          {/* ─── Tab: Overview ─── */}
          {activeTab === 'overview' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

              {/* Licensed Feature Cards */}
              {sortedLicensedFeatures.map((f, i) => (
                <div key={i} className={`bg-white rounded-xl border shadow-sm overflow-hidden transition-all hover:shadow-md ${!f.is_used ? 'border-red-200 bg-red-50/30' : 'border-gray-100'
                  }`}>
                  <div className="p-5">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div>
                        <h3 className="text-sm font-semibold text-gray-900">{f.display_name}</h3>
                        <p className="text-xs text-gray-500 mt-0.5">{f.feature_name}</p>
                        </div>
                      </div>
                      <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${f.is_used
                        ? 'bg-white border border-gray-200 text-gray-700'
                        : 'bg-white border border-gray-200 text-gray-500'
                        }`}>
                        {f.is_used ? 'Active' : 'Unused'}
                      </span>
                    </div>

                    <div className="grid grid-cols-3 gap-4 mt-4 pt-4 border-t border-gray-100">
                      <div>
                        <p className="text-[10px] uppercase font-semibold text-gray-400 tracking-wider">Events</p>
                        <p className="text-lg font-bold text-gray-900 mt-0.5">{f.usage_count.toLocaleString()}</p>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase font-semibold text-gray-400 tracking-wider">Users</p>
                        <p className="text-lg font-bold text-gray-900 mt-0.5">{f.unique_users.toLocaleString()}</p>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase font-semibold text-gray-400 tracking-wider">7d Trend</p>
                        <div className="mt-1">
                          <Sparkline data={f.trend} color={f.is_used ? '#1a73e8' : '#9ca3af'} height={28} />
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className={`px-5 py-2.5 ${f.is_used ? 'bg-gray-100' : 'bg-red-50'} border-t border-gray-100`}>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-medium text-gray-400">
                        {f.usage_pct}% of total platform usage
                      </span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-white border border-gray-200 text-gray-600">
                        {f.plan_tier}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ─── Tab: Licensed Features Table ─── */}
          {activeTab === 'licensed' && (
            <ChartContainer title="Enterprise Licensed Features — Usage Details" id="license-table">
              <div className="mb-3 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
                <p>
                  <strong className="font-semibold">Active Features ({(data as LicenseData | undefined)?.licensed?.length ?? 0}):</strong> Enterprise features with active usage in the last 90 days.<br/>
                  <strong className="font-semibold">Inactive Features ({(data as LicenseData | undefined)?.unused_licensed?.length ?? 0}):</strong> Pre-provisioned enterprise licenses not yet activated by users.
                </p>
              </div>
              <div className="overflow-x-auto mt-2">
                <table className="w-full text-left text-sm text-gray-600">
                  <thead className="text-[13px] text-gray-500 font-medium border-y border-gray-200 bg-gray-100/50">
                    <tr>
                      <th className="px-4 py-3 font-medium">Feature</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 font-medium text-right">Usage Count</th>
                      <th className="px-4 py-3 font-medium text-right">Unique Users</th>
                      <th className="px-4 py-3 font-medium text-right">Usage %</th>
                      <th className="px-4 py-3 font-medium w-28">7-Day Trend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedLicensedFeatures.map((f, i) => (
                      <tr key={i} className={`border-b border-gray-100 transition-colors ${!f.is_used ? 'bg-red-50/50' : 'hover:bg-gray-100'}`}>
                        <td className="px-4 py-3.5">
                          <div className="flex items-center gap-2.5">
                            <div>
                              <p className="font-semibold text-gray-900 text-sm">{f.display_name}</p>
                              <p className="text-[11px] text-gray-400 mt-0.5">{f.feature_name}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3.5">
                          {f.is_used ? (
                            <span className="flex items-center gap-1.5 text-gray-700 font-medium text-sm">
                              <CheckCircle className="h-4 w-4" /> Active
                            </span>
                          ) : (
                            <span className="flex items-center gap-1.5 text-gray-400 font-medium text-sm">
                              <XCircle className="h-4 w-4" /> Unused
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3.5 text-right font-mono font-medium">{f.usage_count.toLocaleString()}</td>
                        <td className="px-4 py-3.5 text-right font-mono">{f.unique_users.toLocaleString()}</td>
                        <td className="px-4 py-3.5 text-right">
                          <span className="font-medium text-violet-600">{f.usage_pct}%</span>
                        </td>
                        <td className="px-4 py-3.5">
                          <Sparkline data={f.trend} color={f.is_used ? '#1a73e8' : '#9ca3af'} height={24} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </ChartContainer>
          )}

          {/* ─── Tab: Free Features Table ─── */}
          {activeTab === 'free' && (
            <ChartContainer title="Free/Unentitled Features — Used Without License" id="unlicensed-table">
              {unlicensedFeatures.length > 0 ? (
                <div className="overflow-x-auto mt-2">
                  <table className="w-full text-left text-sm text-gray-600">
                    <thead className="text-[13px] text-gray-500 font-medium border-y border-gray-200 bg-gray-100/50">
                      <tr>
                        <th className="px-4 py-3 font-medium">Feature</th>
                        <th className="px-4 py-3 font-medium text-right">Usage Count</th>
                        <th className="px-4 py-3 font-medium text-right">Unique Users</th>
                        <th className="px-4 py-3 font-medium text-right">Usage %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedUnlicensedFeatures.map((f, i) => (
                        <tr key={i} className="border-b border-gray-100 hover:bg-amber-50/30 transition-colors">
                          <td className="px-4 py-3.5">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-gray-900">
                                {f.display_name}
                              </span>
                              <span className="text-xs text-gray-400 ml-2">({f.feature_name})</span>
                            </div>
                          </td>
                          <td className="px-4 py-3.5 text-right font-mono font-medium">{f.usage_count.toLocaleString()}</td>
                          <td className="px-4 py-3.5 text-right font-mono">{f.unique_users.toLocaleString()}</td>
                          <td className="px-4 py-3.5 text-right">
                            <span className="font-medium text-amber-600">{f.usage_pct}%</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="py-12 text-center text-gray-400">
                  <Activity className="h-6 w-6 mx-auto mb-2 text-gray-300" />
                  <p className="text-sm">No unlicensed feature usage detected</p>
                </div>
              )}
            </ChartContainer>
          )}
        </>
      )}
    </div>
  );
}
