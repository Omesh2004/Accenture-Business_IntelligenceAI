'use client';

import { useEffect, useCallback, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppDispatch, useAppSelector } from '@/lib/store';
import { setTimeRange, setSelectedTenants, updateRealTimeUsers, updateKPIMetrics } from '@/lib/dashboardSlice';
import { TimeRange, LocationData, AuditLog, DimensionProvenance } from '@/types';
import { useSession } from 'next-auth/react';
import { usePathname } from 'next/navigation';
import { dashboardAPI } from '@/lib/api';
import { resolveAnalyticsWsBaseUrl } from '@/lib/ws-url';
import {
  APP_TO_TENANTS,
  ALL_TENANT_IDS,
  TENANT_TO_APP,
  resolveAppIdFromPathname,
  resolvePrimaryAppIdFromAdminApps,
  resolveTenantIdsForApp,
  normalizeTenantId,
  resolvePrimaryTenantForApp,
} from '@/lib/feature-map';

/**
 * Converts the human-readable TimeRange into the API range param.
 */
function timeRangeToParam(tr: TimeRange): string {
  switch (tr) {
    case 'Last 30 Days': return '30d';
    case 'Last 90 Days': return '90d';
    default: return '7d';
  }
}

/**
 * Central dashboard hook. Single source of truth for tenants + timeRange.
 * All pages MUST use this hook, never derive tenant arrays locally.
 */
export function useDashboardData(persona?: string) {
  const dispatch = useAppDispatch();
  const queryClient = useQueryClient();
  const dashboardState = useAppSelector((state) => state.dashboard);
  const { data: session } = useSession();
  const pathname = usePathname();
  const lastInvalidateAtRef = useRef(0);

  const routeAppId = useMemo(() => resolveAppIdFromPathname(pathname), [pathname]);

  const sessionAppId = useMemo(() => {
    if (session?.user?.role !== 'app_admin') {
      return null;
    }
    return resolvePrimaryAppIdFromAdminApps(session.user.adminApps || []);
  }, [session]);

  const scopedAppId = routeAppId || sessionAppId;

  const scopedTenants = useMemo(() => {
    if (scopedAppId) {
      return resolveTenantIdsForApp(scopedAppId).map(normalizeTenantId);
    }

    if (session?.user?.role !== 'app_admin') {
      return [] as string[];
    }

    return Array.from(
      new Set(
        (session.user.adminApps || [])
          .filter(Boolean)
          .flatMap((app) => {
            const normalized = String(app).toLowerCase();
            const appId = TENANT_TO_APP[normalized] || normalized;
            return (APP_TO_TENANTS[appId] || []).map(normalizeTenantId);
          })
      )
    );
  }, [scopedAppId, session]);

  const effectiveTenants = useMemo(() => {
    const current = dashboardState.selectedTenants.filter(Boolean).map(normalizeTenantId);
    if (current.length > 0) {
      if (scopedTenants.length === 0) {
        return current;
      }
      const validCurrent = current.filter((tenantId) => scopedTenants.includes(tenantId));
      if (validCurrent.length > 0) {
        return validCurrent;
      }
    }

    // Avoid empty tenant queries: default super admins to all known tenants.
    if (scopedTenants.length === 0 && session?.user?.role === 'super_admin') {
      return ALL_TENANT_IDS.map(normalizeTenantId);
    }

    return scopedTenants;
  }, [dashboardState.selectedTenants, scopedTenants, session]);

  // Auto-pin app_admins to their assigned tenants
  useEffect(() => {
    if (session?.user?.role !== 'app_admin') {
      return;
    }

    if (scopedTenants.length === 0) {
      return;
    }

    const current = dashboardState.selectedTenants.filter(Boolean).map(normalizeTenantId);
    const isValid = current.length > 0 && current.every((tenantId) => scopedTenants.includes(tenantId));
    if (!isValid) {
      dispatch(setSelectedTenants(scopedTenants));
    }
  }, [dispatch, session, dashboardState.selectedTenants, scopedTenants]);

  // ─── Derived API params (stable references) ───
  const tenantsParam: string[] = useMemo(() => {
    return effectiveTenants;
  }, [effectiveTenants]);

  const rangeParam: string = useMemo(() => {
    return timeRangeToParam(dashboardState.timeRange);
  }, [dashboardState.timeRange]);

  // Super admins are refused detailed analytics by RBACMiddleware, so asking for these two was a
  // guaranteed 403 on every page load -- two console errors for a policy the client already
  // knows. Skip the call rather than make it and swallow the answer.
  const role = session?.user?.role;
  const mayReadDetailedAnalytics = role === 'app_admin';

  // ─── Core dashboard data (React Query) ───
  const { data: dashboardData, isLoading, isFetching } = useQuery({
    queryKey: ['dashboardData', tenantsParam, rangeParam, role, persona],
    queryFn: async () => {
      const [
        kpiMetrics,
        secondaryKpiMetrics,
        trafficData,
        topFeatures,
        funnelData,
        tenants,
        realTimeUsersData,
        dimensionProvenance,
      ] = await Promise.all([
        dashboardAPI.getKPIMetrics(tenantsParam, rangeParam, persona),
        dashboardAPI.getSecondaryKPIMetrics(tenantsParam, rangeParam),
        dashboardAPI.getTrafficData(tenantsParam, rangeParam),
        dashboardAPI.getTopFeatures(tenantsParam, rangeParam),
        dashboardAPI.getFunnelData(tenantsParam, rangeParam),
        dashboardAPI.getTenants(tenantsParam, rangeParam),
        dashboardAPI.getRealTimeUsers(tenantsParam),
        // Same gate as locations/devices: it describes those charts, so it must not be
        // reachable where they are not.
        mayReadDetailedAnalytics
          ? dashboardAPI.getDimensionProvenance(tenantsParam, rangeParam)
          : Promise.resolve({} as Record<string, DimensionProvenance>),
      ]);

      return {
        kpiMetrics,
        secondaryKpiMetrics,
        trafficData,
        topFeatures,
        funnelData,
        tenants,
        realTimeUsers: realTimeUsersData.count,
        realTimeUsersTimestampIST: realTimeUsersData.timestampIST ?? null,
        dimensionProvenance,
      };
    },
    // Keep data responsive while avoiding noisy re-fetching.
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  const { data: aiInsightsData } = useQuery({
    queryKey: ['aiInsights', tenantsParam, rangeParam],
    queryFn: () => dashboardAPI.getAIInsights(tenantsParam, rangeParam),
    staleTime: 10 * 60 * 1000,
  });

  // ─── WebSocket for real-time metrics ───
  useEffect(() => {
    const selectedTenantRaw =
      effectiveTenants.length > 0
        ? effectiveTenants[0]
        : resolvePrimaryTenantForApp(scopedAppId || 'nexabank');
    const tenantId = normalizeTenantId(selectedTenantRaw);

    const baseUrl = resolveAnalyticsWsBaseUrl(process.env.NEXT_PUBLIC_ANALYTICS_WS_URL);
    const wsUrl = `${baseUrl}/ws/dashboard/${tenantId}`;

    const ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'METRICS_UPDATE') {
          if (data.payload.realtimeUsers !== undefined) {
            dispatch(updateRealTimeUsers(data.payload.realtimeUsers));
          }
          if (data.payload.kpiMetrics?.length) {
            dispatch(updateKPIMetrics(data.payload.kpiMetrics));
          }

          // Throttle invalidation to prevent websocket bursts from causing request storms.
          const now = Date.now();
          if (now - lastInvalidateAtRef.current > 5000) {
            lastInvalidateAtRef.current = now;
            queryClient.invalidateQueries({
              queryKey: ['dashboardData', tenantsParam, rangeParam],
              refetchType: 'active',
            });
          }
        }
      } catch (e) {
        console.error('Error parsing WebSocket message:', e);
      }
    };

    return () => { ws.close(); };
  }, [dispatch, effectiveTenants, queryClient, tenantsParam, rangeParam, scopedAppId]);

  // ─── Actions ───
  const changeTimeRange = useCallback(
    (range: TimeRange) => { dispatch(setTimeRange(range)); },
    [dispatch]
  );

  const changeTenants = useCallback(
    (tenants: string[] | string) => { dispatch(setSelectedTenants(tenants)); },
    [dispatch]
  );

  return {
    activeAppId: scopedAppId,
    // Redux state (single source of truth)
    selectedTenants: effectiveTenants,
    timeRange: dashboardState.timeRange,
    deploymentMode: dashboardState.deploymentMode,
    sidebarCollapsed: dashboardState.sidebarCollapsed,
    // Computed API params, pages MUST use these, never derive their own
    tenantsParam,
    rangeParam,
    // React Query data
    kpiMetrics: dashboardData?.kpiMetrics || [],
    secondaryKpiMetrics: dashboardData?.secondaryKpiMetrics || [],
    trafficData: dashboardData?.trafficData || [],
    topFeatures: dashboardData?.topFeatures || [],
    funnelData: dashboardData?.funnelData || [],
    tenants: dashboardData?.tenants || [],
    realTimeUsers: dashboardData?.realTimeUsers || 0,
    realTimeUsersTimestampIST: dashboardData?.realTimeUsersTimestampIST || null,
    dimensionProvenance: dashboardData?.dimensionProvenance || {},
    persona,
    aiInsights: aiInsightsData || [],
    isLoading,
    isFetching,
    // Actions
    changeTimeRange,
    changeTenant: changeTenants,
  };
}

export function useAIInsights() {
  const { funnelData = [], topFeatures = [] } = useDashboardData();

  const generateInsights = useCallback(() => {
    const insights: string[] = [];

    funnelData.forEach((step) => {
      if (step.dropOff >= 40) {
        insights.push(`${step.dropOff}% drop-off at ${step.label} step`);
      }
    });

    if (topFeatures.length > 0) {
      const topFeature = topFeatures[0];
      insights.push(`${topFeature.name} leads with ${topFeature.value.toLocaleString()} events`);
    }

    return insights;
  }, [funnelData, topFeatures]);

  return { generateInsights };
}
