'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDashboardData } from '@/hooks/useDashboard';
import { dashboardAPI } from '@/lib/api';
import { useRealtimeEvents } from '@/hooks/useRealtimeEvents';
import { DashboardSkeleton, TableSkeleton } from '@/components/Skeletons';
import ChartContainer from '@/components/ChartContainer';
import { Shield, ToggleLeft, ToggleRight, History, Loader2 } from 'lucide-react';
import { useSession } from 'next-auth/react';

type GovernanceToggle = {
  feature_name: string;
  display_name?: string;
  category?: string;
  is_enabled: boolean;
  changed_by: string;
  changed_at: string;
};

function normalizeFeatureKey(rawKey: string): string {
  const key = String(rawKey || '').trim().toLowerCase();
  if (!key) return key;

  return key
    .replace(/_page[._]view$/i, '.page.view')
    .replace(/\.page_view$/i, '.page.view')
    .replace(/_dashboard[._]view$/i, '.dashboard.view')
    .replace(/\.dashboard_view$/i, '.dashboard.view')
    .replace(/\.{2,}/g, '.');
}

function dedupeGovernanceToggles(items: GovernanceToggle[]): GovernanceToggle[] {
  const merged = new Map<string, GovernanceToggle>();
  for (const item of items) {
    const normalizedKey = normalizeFeatureKey(item.feature_name);
    if (!normalizedKey) continue;

    const current: GovernanceToggle = {
      ...item,
      feature_name: normalizedKey,
      display_name: item.display_name || normalizedKey,
    };
    const previous = merged.get(normalizedKey);

    if (!previous) {
      merged.set(normalizedKey, current);
      continue;
    }

    const prevChangedAt = previous.changed_at || '';
    const currChangedAt = current.changed_at || '';
    const pickCurrent = currChangedAt > prevChangedAt;
    merged.set(normalizedKey, pickCurrent ? current : previous);
  }

  return Array.from(merged.values()).sort((a, b) => a.feature_name.localeCompare(b.feature_name));
}

export default function GovernancePage() {
  const { isLoading, auditLogs, selectedTenants, tenantsParam } = useDashboardData();
  const { data: session, status: sessionStatus } = useSession();
  const actorEmail = session?.user?.email || 'admin@unknown.com';
  const actorRole = session?.user?.role || 'user';
  const isAdminSession = session?.user?.role === 'super_admin' || session?.user?.role === 'app_admin';
  const queryClient = useQueryClient();
  const { lastEvent } = useRealtimeEvents({ maxEvents: 1 });
  const lastRealtimeRefetchAt = useRef(0);

  const [activeTab, setActiveTab] = useState<'toggles' | 'logs'>('toggles');
  const [togglingFeature, setTogglingFeature] = useState<string | null>(null);
  const [featureSearch, setFeatureSearch] = useState('');

  // Fetch tracking toggles
  const { data: toggles = [], isLoading: loadingToggles, refetch: refetchToggles } = useQuery<GovernanceToggle[]>({
    queryKey: ['trackingToggles', tenantsParam],
    queryFn: async () => {
      const result = await dashboardAPI.getTrackingToggles(tenantsParam, {
        role: actorRole,
        email: actorEmail,
      });
      const normalized = (result.toggles || []).map((t) => ({
        feature_name: t.feature_name,
        display_name: t.display_name,
        category: t.category,
        is_enabled: t.is_enabled,
        changed_by: t.changed_by || 'system',
        changed_at: t.changed_at || '-',
      }));
      return dedupeGovernanceToggles(normalized);
    },
    staleTime: 15 * 1000,
    refetchInterval: 3 * 1000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    enabled: sessionStatus === 'authenticated' && isAdminSession,
  });

  // Real-time refetch trigger with 5-second throttle
  useEffect(() => {
    if (!lastEvent) return;
    const now = Date.now();
    if (now - lastRealtimeRefetchAt.current < 5000) return;
    lastRealtimeRefetchAt.current = now;
    void refetchToggles();
  }, [lastEvent, refetchToggles, activeTab]);

  const handleToggle = async (featureName: string, currentState: boolean) => {
    setTogglingFeature(featureName);
    await dashboardAPI.setTrackingToggle(tenantsParam, featureName, !currentState, actorEmail, {
      role: actorRole,
      email: actorEmail,
    });
    // Refresh toggles
    await queryClient.invalidateQueries({ queryKey: ['trackingToggles', tenantsParam] });
    setTogglingFeature(null);
  };

  const filteredToggles = toggles.filter((t) => {
    const q = featureSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      t.feature_name.toLowerCase().includes(q) ||
      String(t.display_name || '').toLowerCase().includes(q) ||
      String(t.category || '').toLowerCase().includes(q)
    );
  });

  const enabledCount = toggles.filter((t) => t.is_enabled).length;
  const disabledCount = toggles.length - enabledCount;

  if (isLoading && auditLogs.length === 0) {
    return <DashboardSkeleton />;
  }

  return (
    <div className="animate-in fade-in duration-500 space-y-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-[22px] font-medium text-gray-900 tracking-tight">Governance & Security</h1>
          <p className="text-sm text-gray-500 mt-1">Manage tracking controls, privacy settings.</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
        {[
          { key: 'toggles', label: 'Tracking Controls', icon: Shield },
          { key: 'logs', label: 'Activity Logs', icon: ToggleLeft },
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key as any)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium transition-all cursor-pointer ${activeTab === tab.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
          >
            <tab.icon className="h-4 w-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tracking Controls Tab */}
      {activeTab === 'toggles' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1 space-y-6">
            <ChartContainer title="Data Privacy" id="privacy-controls">
              <div className="space-y-4 mt-2">
                <div className="flex items-center justify-between p-3 border border-gray-100 rounded-lg hover:border-gray-200 transition-colors">
                  <div>
                    <h4 className="text-sm font-medium text-gray-900">PII Masking</h4>
                    <p className="text-xs text-gray-500 mt-0.5">Scrub emails & IPs automatically.</p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" className="sr-only peer" defaultChecked />
                    <div className="w-9 h-5 bg-gray-100 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#1a73e8]"></div>
                  </label>
                </div>
                <div className="flex items-center justify-between p-3 border border-gray-100 rounded-lg hover:border-gray-200 transition-colors">
                  <div>
                    <h4 className="text-sm font-medium text-gray-900">Cookie Consent</h4>
                    <p className="text-xs text-gray-500 mt-0.5">Enforce banner compliance tracking.</p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" className="sr-only peer" defaultChecked />
                    <div className="w-9 h-5 bg-gray-100 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#1a73e8]"></div>
                  </label>
                </div>
              </div>
            </ChartContainer>
          </div>

          <div className="lg:col-span-2">
            <ChartContainer title="Feature Tracking Toggles" id="tracking-toggles">
              <p className="text-xs text-gray-500 mt-1 mb-4">Enable or disable tracking per mapped feature.</p>
              <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-3">
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">Total Features: <span className="font-semibold text-gray-900">{toggles.length}</span></div>
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">Tracking Enabled: <span className="font-semibold text-green-700">{enabledCount}</span></div>
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">Tracking Disabled: <span className="font-semibold text-amber-700">{disabledCount}</span></div>
              </div>
              <input
                type="text"
                value={featureSearch}
                onChange={(e) => setFeatureSearch(e.target.value)}
                placeholder="Search by feature key, label, or category"
                className="mb-4 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 outline-none focus:border-blue-400"
              />
              {loadingToggles ? (
                <div className="p-4"><TableSkeleton rows={4} /></div>
              ) : filteredToggles.length === 0 ? (
                <div className="text-center py-8 text-gray-400">
                  <p className="text-sm">No features match your search.</p>
                  <p className="text-xs mt-1">Try a different keyword or clear the filter.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredToggles.map((t) => (
                    <div key={t.feature_name} className="flex items-center justify-between p-4 border border-gray-100 rounded-lg hover:border-gray-200 transition-all">
                      <div>
                        <h4 className="text-sm font-medium text-gray-900">{t.display_name || t.feature_name}</h4>
                        <p className="text-[11px] text-gray-500 mt-0.5">{t.feature_name}{t.category ? ` · ${t.category}` : ''}</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          Last changed by <span className="font-medium">{t.changed_by || 'system'}</span> at {t.changed_at}
                        </p>
                      </div>
                      <button
                        onClick={() => handleToggle(t.feature_name, t.is_enabled)}
                        disabled={togglingFeature === t.feature_name}
                        className="cursor-pointer"
                      >
                        {togglingFeature === t.feature_name ? (
                          <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
                        ) : t.is_enabled ? (
                          <ToggleRight className="h-8 w-8 text-[#1a73e8]" />
                        ) : (
                          <ToggleLeft className="h-8 w-8 text-gray-400" />
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </ChartContainer>
          </div>
        </div>
      )}

      {/* Activity Logs Tab (existing) */}
      {activeTab === 'logs' && (
        <ChartContainer title="Audit Logs" id="audit-logs">
          <div className="overflow-x-auto cursor-pointer mt-2">
            <table className="w-full text-left text-sm text-gray-600">
              <thead className="text-[13px] text-gray-500 font-medium border-y border-gray-200 bg-gray-100/50">
                <tr>
                  <th className="px-4 py-3 font-medium">Timestamp</th>
                  <th className="px-4 py-3 font-medium">User</th>
                  <th className="px-4 py-3 font-medium">Action</th>
                  <th className="px-4 py-3 font-medium">Resource</th>
                </tr>
              </thead>
              <tbody>
                {auditLogs.map((log, index) => (
                  <tr
                    key={log.id}
                    className={`border-b border-gray-100 hover:bg-gray-100 transition-colors ${index === auditLogs.length - 1 ? 'border-b-0' : ''}`}
                  >
                    <td className="px-4 py-3 text-gray-400 font-medium whitespace-nowrap">{log.timestamp}</td>
                    <td className="px-4 py-3 text-gray-900 font-medium">{log.user}</td>
                    <td className="px-4 py-3">{log.action}</td>
                    <td className="px-4 py-3 font-mono text-xs">{log.resource}</td>
                  </tr>
                ))}
                {auditLogs.length === 0 && (
                  <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-500">No logs found</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </ChartContainer>
      )}
    </div>
  );
}
