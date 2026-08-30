'use client';

import React, { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAppSelector } from '@/lib/store';
import { dashboardAPI } from '@/lib/api';
import { useRealtimeEvents } from '@/hooks/useRealtimeEvents';
import { ShieldAlert, Users, Activity, BarChart3, Database } from 'lucide-react';
import Link from 'next/link';
import { DashboardSkeleton } from '@/components/Skeletons';
import AuthGuard from '@/components/AuthGuard';
import RBACManager from '@/components/RBACManager';

export default function AdminSummaryPage() {
  const { deploymentMode } = useAppSelector((state) => state.dashboard);
  const { lastEvent } = useRealtimeEvents({ maxEvents: 1 });
  const lastRealtimeRefetchAt = useRef(0);

  const { data, isLoading: loading, refetch } = useQuery({
    queryKey: ['adminSummary'],
    queryFn: () => dashboardAPI.getAdminSummary(),
    enabled: deploymentMode === 'cloud',
    staleTime: 20 * 1000,
    refetchInterval: 20 * 1000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  // Real-time refetch trigger with 5-second throttle
  useEffect(() => {
    if (!lastEvent) return;
    const now = Date.now();
    if (now - lastRealtimeRefetchAt.current < 5000) return;
    lastRealtimeRefetchAt.current = now;
    void refetch();
  }, [lastEvent, refetch]);

  if (loading) return <DashboardSkeleton />;

  if (deploymentMode !== 'cloud') {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center h-[70vh]">
        <ShieldAlert className="w-16 h-16 text-orange-500 mb-4" />
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Access Denied: On-Prem Mode</h1>
        <p className="text-gray-500 max-w-md">
          This central admin overview is only available in Cloud deployment mode. 
          Your instance is currently configured for isolated on-premise operation.
        </p>
        <Link href="/" className="mt-6 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
          Return to App Selector
        </Link>
      </div>
    );
  }

  return (
    <AuthGuard>
    <div className="space-y-6">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Global Admin Overview</h1>
        <p className="text-gray-500">Cross-tenant analytics and volume summaries (Cloud Mode)</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm flex items-center space-x-4">
          <div className="p-3 bg-blue-50 text-blue-600 rounded-lg">
            <Users size={24} />
          </div>
          <div>
            <p className="text-sm font-medium text-gray-500">Total Active Tenants</p>
            <h2 className="num text-3xl font-bold text-gray-900">{data?.available === false ? '-' : (data?.total_tenants ?? '-')}</h2>
          </div>
        </div>

        <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm flex items-center space-x-4">
          <div className="p-3 bg-green-50 text-green-600 rounded-lg">
            <Activity size={24} />
          </div>
          <div>
            <p className="text-sm font-medium text-gray-500">Total Events Processed ({data?.time_range ?? '30d'})</p>
            <h2 className="num text-3xl font-bold text-gray-900">{data?.available === false ? '-' : (data?.total_events ?? 0).toLocaleString()}</h2>
          </div>
        </div>
      </div>

      <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
        <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-gray-500" />
          Top Tenants by Volume
        </h3>
        
        {data?.top_tenants && data.top_tenants.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-xs text-gray-500 uppercase bg-gray-100">
                <tr>
                  <th className="px-6 py-3 rounded-tl-lg">Tenant Name</th>
                  <th className="px-6 py-3 rounded-tr-lg text-right">Event Count</th>
                </tr>
              </thead>
              <tbody>
                {data.top_tenants.map((t, i) => (
                  <tr key={i} className="border-b last:border-0 hover:bg-gray-100">
                    <td className="px-6 py-4 font-medium text-gray-900">{t.name}</td>
                    <td className="px-6 py-4 text-right">{t.events.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-gray-500 text-sm">No tenant usage data recorded yet.</p>
        )}
      </div>
      
      <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 flex gap-3 text-sm text-blue-800">
        <Database className="w-5 h-5 shrink-0 text-blue-600" />
        <p>
          <strong>Privacy Note:</strong> This view only shows aggregated metadata. User-level PII, exact paths, 
          and audit logs remain abstracted or strictly within the tenant&apos;s own isolated view.
        </p>
      </div>

      {/* RBAC Access Management UI */}
      <RBACManager />
    </div>
    </AuthGuard>
  );
}
