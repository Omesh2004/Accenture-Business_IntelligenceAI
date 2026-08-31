'use client';

import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Shield, Database, Info } from 'lucide-react';
import { dashboardAPI } from '@/lib/api';
import { ALL_TENANT_IDS, SUPPORTED_RBAC_APPS, TENANT_LABELS } from '@/lib/feature-map';

type RbacConfig = {
  super_admins: string[];
  app_admins: Record<string, string[]>;
};

export default function RBACManager() {
  const [config, setConfig] = useState<RbacConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedTenant, setSelectedTenant] = useState<string>(ALL_TENANT_IDS[0] || 'nexabank');

  useEffect(() => {
    fetchConfig();
  }, []);

  const fetchConfig = async () => {
    try {
      const res = await fetch('/api/rbac');
      if (res.ok) {
        const data = await res.json();
        setConfig(data);
      } else {
        setError('Failed to load RBAC configuration');
      }
    } catch (e) {
      setError('Error fetching config');
    } finally {
      setLoading(false);
    }
  };

  const { data: tenantView, isLoading: tenantLoading } = useQuery({
    queryKey: ['superadmin-tenant-view', selectedTenant],
    queryFn: async () => {
      const [kpi, insights] = await Promise.all([
        dashboardAPI.getKPIMetrics([selectedTenant], '7d'),
        dashboardAPI.getAIInsights([selectedTenant], '7d'),
      ]);
      return { kpi, insights };
    },
    staleTime: 30 * 1000,
  });

  if (loading) return <div className="animate-pulse bg-gray-100 h-48 rounded-xl"></div>;

  return (
    <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm mt-6">
      <div className="flex items-center gap-2 mb-6">
        <Shield className="w-5 h-5 text-indigo-600" />
        <h3 className="text-lg font-semibold text-gray-900">App Access Management</h3>
      </div>

      {error && (
        <div className="bg-red-50 text-red-600 p-3 rounded-lg text-sm mb-4">
          {error}
        </div>
      )}

      {/* List existing App Admins from RBAC Configuration (Read-only) */}
      <div className="mb-8">
        <h4 className="text-sm font-medium text-gray-700 mb-3">Current App Admins</h4>
        <p className="text-xs text-gray-500 mb-3">Configured admins per application.</p>
        {config ? (
          <div className="space-y-4">
            {SUPPORTED_RBAC_APPS.map((appId) => (
              <div key={appId} className="border border-gray-100 rounded-lg overflow-hidden">
                <div className="bg-gray-100 px-4 py-2 border-b border-gray-100">
                  <span className="text-xs font-bold uppercase text-gray-700 tracking-wider">App: {appId}</span>
                </div>
                <ul className="divide-y divide-gray-100">
                  {(config.app_admins?.[appId] || []).length > 0 ? (
                    (config.app_admins?.[appId] || []).map((email: string) => (
                      <li key={email} className="px-4 py-3 bg-white">
                        <span className="text-sm text-gray-900 font-medium">{email}</span>
                      </li>
                    ))
                  ) : (
                    <li className="px-4 py-3 text-sm text-gray-500 italic">No admins configured for this app.</li>
                  )}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <div className="animate-pulse space-y-4">
            <div className="h-24 bg-gray-100 rounded-lg"></div>
            <div className="h-24 bg-gray-100 rounded-lg"></div>
          </div>
        )}
      </div>

      {/* Superadmin per-tenant data */}
      <div className="mt-8 border-t border-gray-100 pt-6">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h4 className="text-sm font-medium text-gray-700 flex items-center gap-2">
            <Database className="w-4 h-4" />
            Tenant Data Received by Super Admin
          </h4>
          <select
            value={selectedTenant}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSelectedTenant(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
          >
            {ALL_TENANT_IDS.map((tenantId) => (
              <option key={tenantId} value={tenantId}>
                {TENANT_LABELS[tenantId] || tenantId}
              </option>
            ))}
          </select>
        </div>

        {tenantLoading ? (
          <div className="animate-pulse bg-gray-100 h-32 rounded-xl" />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {(tenantView?.kpi || []).map((metric) => (
                <div key={metric.id} className="rounded-lg border border-gray-200 bg-white p-3">
                  <p className="text-xs text-gray-500">{metric.label}</p>
                  <p className="text-xl font-bold text-gray-900">{metric.value}</p>
                </div>
              ))}
            </div>

            <div className="rounded-lg border border-gray-200 bg-gray-100 p-4">
              <p className="text-xs font-semibold text-gray-700 mb-2 flex items-center gap-2">
                <Info className="w-3.5 h-3.5" /> AI Insights
              </p>
              {(tenantView?.insights || []).length > 0 ? (
                <ul className="space-y-2">
                  {(tenantView?.insights || []).slice(0, 4).map((ins) => (
                    <li key={ins.id} className="text-sm text-gray-700">{ins.message}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-gray-500">No insights available for this tenant right now.</p>
              )}
            </div>
          </div>
        )}
      </div>
      
    </div>
  );
}
