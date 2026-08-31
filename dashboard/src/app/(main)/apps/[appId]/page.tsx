'use client';

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { dashboardAPI } from '@/lib/api';
import { DashboardSkeleton } from '@/components/Skeletons';
import AuthGuard from '@/components/AuthGuard';
import { Activity, Users, MousePointerClick, Shield, ArrowLeft } from 'lucide-react';
import Link from 'next/link';

export default function AppOverviewPage({ params }: { params: { appId: string } }) {
  const appId = params.appId.toLowerCase();

  const { data: kpi = [], isLoading: loading } = useQuery({
    queryKey: ['appKpiMetrics', appId],
    queryFn: () => dashboardAPI.getKPIMetrics([appId], '7d'),
    enabled: !!appId,
  });

  if (loading) return <DashboardSkeleton />;

  return (
    <AuthGuard>
      <div className="space-y-6">
        <div className="flex items-center gap-4 mb-8">
          <Link href="/" className="p-2 hover:bg-gray-100 rounded-full transition-colors">
            <ArrowLeft size={20} className="text-gray-500" />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-gray-900 capitalize">{appId} Cloud Summary</h1>
              <span className="bg-blue-100 text-blue-800 text-xs px-2.5 py-0.5 rounded-full font-medium flex items-center gap-1 border border-blue-200">
                <Shield size={12} /> Super Admin View
              </span>
            </div>
            <p className="text-gray-500">Aggregated basic analytics for this application.</p>
          </div>
        </div>

        {kpi && kpi.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            {kpi.map((metric) => (
              <div key={metric.id} className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm flex flex-col justify-between">
                <div className="flex items-center gap-3 mb-4 text-gray-500">
                  <span className="font-medium">{metric.label}</span>
                </div>
                <h2 className="num text-3xl font-bold text-gray-900">{metric.value}</h2>
              </div>
            ))}
          </div>
        ) : (
          <div className="bg-white p-12 text-center rounded-xl border border-gray-200 shadow-sm">
            <p className="text-gray-500">No data available yet or unauthorized.</p>
          </div>
        )}

        <div className="bg-gray-100 p-6 rounded-xl border border-gray-200 mt-6">
          <h3 className="font-medium text-gray-700 mb-2">Note on Super Admin Access</h3>
          <p className="text-sm text-gray-500">
            As a Super Admin, you are restricted to this aggregated view to protect data privacy. 
            Detailed dashboards, individual user journeys, funnels, and feature interactions are strictly reserved for assigned <strong>App Admins</strong>.
          </p>
        </div>
      </div>
    </AuthGuard>
  );
}
