'use client';

/**
 * Top navigation bar component.
 * Contains tenant selector (all tenants from DB), time range filter,
 * search, Data Sync transparency panel, and profile dropdown.
 * Shows a loading spinner in the tenant selector while switching tenants.
 */

import React, { memo, useState, useRef, useEffect, useMemo } from 'react';
import {
  Search,
  ChevronDown,
  Calendar,
  Menu,
  ShieldAlert,
  Loader2,
} from 'lucide-react';
import Image from 'next/image';
import { useQuery } from '@tanstack/react-query';
import { useAppDispatch, useAppSelector } from '@/lib/store';
import { dashboardAPI } from '@/lib/api';
import { useSession, signOut } from 'next-auth/react';
import {
  ALL_TENANT_IDS,
  APP_TO_TENANTS,
  TENANT_LABELS,
  TENANT_TO_APP,
  resolveAppIdFromPathname,
  resolvePrimaryAppIdFromAdminApps,
  resolvePrimaryTenantForApp,
  normalizeTenantId,
} from '@/lib/feature-map';
import { usePathname } from 'next/navigation';
import {
  setTimeRange,
  setSelectedTenants,
  toggleSidebar,
} from '@/lib/dashboardSlice';
import type { TimeRange, AvailableTenant } from '@/types';

const timeRanges: TimeRange[] = ['Last 7 Days', 'Last 30 Days', 'Last 90 Days'];

function timeRangeToParam(tr: TimeRange): string {
  switch (tr) {
    case 'Last 30 Days': return '30d';
    case 'Last 90 Days': return '90d';
    default: return '7d';
  }
}

interface TransparencyCategory {
  category: string;
  is_synced: boolean;
  details: string;
}

interface TransparencyData {
  message: string;
  visible_categories: TransparencyCategory[];
}

function TopNavbar() {
  const dispatch = useAppDispatch();
  const {
    timeRange,
    selectedTenants,
    deploymentMode,
  } = useAppSelector((state) => state.dashboard);
  const rangeParam = useMemo(() => timeRangeToParam(timeRange), [timeRange]);
  const { data: session } = useSession();
  const pathname = usePathname();

  const { data: availableTenants = [], isFetching } = useQuery({
    queryKey: ['availableTenants', rangeParam],
    queryFn: async () => await dashboardAPI.getAvailableTenants(rangeParam),
    staleTime: 5 * 60 * 1000,
  });

  const activeAppId = useMemo(() => {
    const routeAppId = resolveAppIdFromPathname(pathname);
    if (routeAppId) return routeAppId;

    const adminApp = ((session?.user?.adminApps || []) as string[])
      .map((appId) => TENANT_TO_APP[String(appId).toLowerCase()] || String(appId).toLowerCase())
      .find((appId) => Boolean(APP_TO_TENANTS[appId]));
    if (adminApp) return adminApp;

    const selectedApp = (selectedTenants || [])
      .map((tenantId) => TENANT_TO_APP[normalizeTenantId(String(tenantId))])
      .find(Boolean);
    if (selectedApp) return selectedApp;

    const sessionApp = resolvePrimaryAppIdFromAdminApps(session?.user?.adminApps || []);
    if (sessionApp) return sessionApp;

    return 'nexabank';
  }, [selectedTenants, session, pathname]);

  const scopedTenantIds = useMemo(() => {
    return APP_TO_TENANTS[activeAppId] || ALL_TENANT_IDS;
  }, [activeAppId]);

  /**
   * Build the tenant options list:
   *  - "All Tenants" → all tenant IDs
   */
  const tenantOptions = useMemo((): AvailableTenant[] => {
    const defaults: AvailableTenant[] = scopedTenantIds.map((tenantId) => ({
      id: tenantId,
      name: TENANT_LABELS[tenantId] || tenantId,
      eventCount: 0,
      uniqueUsers: 0,
    }));

    const indexed = new Map<string, AvailableTenant>();
    [...defaults, ...availableTenants].forEach((tenant) => {
      if (scopedTenantIds.includes(tenant.id)) {
        indexed.set(tenant.id, {
          ...tenant,
          name: TENANT_LABELS[tenant.id] || tenant.name,
        });
      }
    });

    return scopedTenantIds
      .map((id) => indexed.get(id))
      .filter(Boolean) as AvailableTenant[];
  }, [availableTenants, scopedTenantIds]);

  // Log for debugging
  useEffect(() => {
    console.log("Selected tenant:", selectedTenants);
  }, [selectedTenants]);

  // Ensure the selected tenant is always valid
  useEffect(() => {
    if (!selectedTenants || selectedTenants.length === 0) return;
    const allValidIds = tenantOptions.map((t) => t.id);
    const valid = selectedTenants.every((t) => allValidIds.includes(t));
    if (!valid && tenantOptions.length > 0) {
      dispatch(setSelectedTenants([tenantOptions[0].id]));
    }
  }, [tenantOptions, selectedTenants, dispatch]);

  const [showTenantDropdown, setShowTenantDropdown] = useState(false);
  const [showTimeDropdown, setShowTimeDropdown] = useState(false);
  const [showProfileDropdown, setShowProfileDropdown] = useState(false);
  const [showTransparency, setShowTransparency] = useState(false);
  const [transparencyData, setTransparencyData] = useState<TransparencyData | null>(null);
  const [transparencyLoading, setTransparencyLoading] = useState(false);

  const tenantRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);
  const transparencyRef = useRef<HTMLDivElement>(null);

  // Close all dropdowns on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (tenantRef.current && !tenantRef.current.contains(event.target as Node)) {
        setShowTenantDropdown(false);
      }
      if (timeRef.current && !timeRef.current.contains(event.target as Node)) {
        setShowTimeDropdown(false);
      }
      if (profileRef.current && !profileRef.current.contains(event.target as Node)) {
        setShowProfileDropdown(false);
      }
      if (transparencyRef.current && !transparencyRef.current.contains(event.target as Node)) {
        setShowTransparency(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleTransparencyClick = async () => {
    setShowTransparency(!showTransparency);
    if (!showTransparency && !transparencyData) {
      setTransparencyLoading(true);
      const activeTenant =
        selectedTenants.length > 0
          ? selectedTenants.map((tenantId) => normalizeTenantId(tenantId)).join(',')
          : resolvePrimaryTenantForApp(activeAppId);
      const data = await dashboardAPI.getTransparencyInfo(activeTenant);
      setTransparencyData(data as TransparencyData | null);
      setTransparencyLoading(false);
    }
  };

  const isAllTenantsSelected = selectedTenants.length === tenantOptions.length && tenantOptions.length > 0;

  /** Compute display label for the currently-selected tenant */
  const selectedLabel = useMemo(() => {
    if (!selectedTenants || selectedTenants.length === 0) return 'Select Tenant';
    if (isAllTenantsSelected) return 'All Tenants';
    if (selectedTenants.length > 1) return `${selectedTenants.length} Tenants`;
    const singleTenantId = selectedTenants[0];
    const found = availableTenants.find((t) => t.id === singleTenantId);
    if (found?.name) return TENANT_LABELS[singleTenantId] || found.name;
    return TENANT_LABELS[singleTenantId] || singleTenantId.charAt(0).toUpperCase() + singleTenantId.slice(1);
  }, [selectedTenants, availableTenants, isAllTenantsSelected]);

  return (
    <header className="sticky top-0 z-20 bg-white border-b border-gray-200">
      <div className="flex items-center justify-between px-4 lg:px-6 h-16">
        {/* Left Section: Mobile menu + Tenant Selector */}
        <div className="flex items-center gap-3">
          {/* Mobile menu button */}
          <button
            onClick={() => dispatch(toggleSidebar())}
            className="lg:hidden p-2 rounded-lg hover:bg-gray-100 text-gray-500"
            aria-label="Toggle menu"
          >
            <Menu className="w-5 h-5" />
          </button>

          {/* Logo (mobile only) */}
          <div className="flex items-center gap-2 lg:hidden">
            <div className="relative w-7 h-7">
              <Image
                src="/logo1.png"
                alt="FinInsights Logo"
                fill
                className="object-contain"
                sizes="28px"
              />
            </div>
            <span className="text-base font-semibold text-gray-900 tracking-tight">FinInsights</span>
          </div>

          {/* ── Tenant Selector Dropdown ── */}
          <div ref={tenantRef} className="hidden md:flex relative">
            <button
              onClick={() => setShowTenantDropdown(!showTenantDropdown)}
              className="flex items-center border border-gray-400 cursor-pointer gap-2 px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:border-gray-300 transition-colors min-w-[130px]"
              id="tenant-selector"
            >
              {isFetching ? (
                <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin flex-shrink-0" />
              ) : null}
              <span className="flex-1 text-left truncate">{selectedLabel}</span>
              <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
            </button>

            {showTenantDropdown && (
              <div className="absolute top-full cursor-pointer left-0 mt-1 w-52 bg-white border border-gray-200 rounded-xl shadow-lg py-1 z-50 animate-in fade-in slide-in-from-top-1 duration-150 max-h-[60vh] overflow-y-auto custom-scrollbar">
                {/* All Tenants option */}
                <button
                  onClick={() => {
                    dispatch(setSelectedTenants(tenantOptions.map(t => t.id)));
                    setShowTenantDropdown(false);
                  }}
                  className={`w-full cursor-pointer text-left px-4 py-2.5 text-sm transition-colors ${isAllTenantsSelected
                      ? 'bg-blue-50 text-blue-600 font-semibold'
                      : 'text-gray-700 hover:bg-gray-100'
                    }`}
                >
                  <span className="flex items-center gap-2">
                    <span className={`inline-block w-2 h-2 rounded-full ${isAllTenantsSelected ? 'bg-blue-500' : 'bg-gray-300'}`} />
                    All Tenants
                  </span>
                </button>

                <div className="border-t border-gray-100 my-1" />

                {/* Individual tenant options */}
                {tenantOptions.map((tenant) => {
                  const isSelected = selectedTenants.includes(tenant.id) && !isAllTenantsSelected;
                  return (
                    <button
                      key={tenant.id}
                      onClick={() => {
                        dispatch(setSelectedTenants([tenant.id]));
                        setShowTenantDropdown(false);
                      }}
                      className={`w-full cursor-pointer text-left px-4 py-2.5 text-sm transition-colors ${isSelected
                          ? 'bg-blue-50 text-blue-600 font-semibold'
                          : 'text-gray-700 hover:bg-gray-100'
                        }`}
                    >
                      <span className="flex items-center justify-between">
                        <span className="flex items-center gap-2">
                          <span className={`inline-block w-2 h-2 rounded-full ${isSelected ? 'bg-blue-500' : 'bg-gray-300'}`} />
                          {tenant.name}
                        </span>
                        {tenant.eventCount > 0 && (
                          <span className="text-[10px] text-gray-400 font-mono">
                            {tenant.eventCount.toLocaleString()}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Center Section: Time Range + Transparency */}
        <div className="hidden md:flex items-center">
          {/* Time Range Selector */}
          <div ref={timeRef} className="relative">
            <button
              onClick={() => setShowTimeDropdown(!showTimeDropdown)}
              className="flex items-center border border-gray-400 cursor-pointer gap-2 px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 hover:border-gray-300 transition-colors"
              id="time-range-selector"
            >
              <Calendar className="w-4 h-4 text-gray-400" />
              {timeRange}
              <ChevronDown className="w-4 h-4 text-gray-400" />
            </button>

            {showTimeDropdown && (
              <div className="absolute top-full right-0 mt-1 w-44 bg-white border border-gray-200 rounded-xl shadow-lg py-1 z-50 animate-in fade-in slide-in-from-top-1 duration-150">
                {timeRanges.map((range) => (
                  <button
                    key={range}
                    onClick={() => {
                      dispatch(setTimeRange(range));
                      setShowTimeDropdown(false);
                    }}
                    className={`w-full cursor-pointer text-left px-4 py-2 text-sm transition-colors ${range === timeRange
                        ? 'bg-blue-50 text-blue-600 font-medium'
                        : 'text-gray-700 hover:bg-gray-100'
                      }`}
                  >
                    {range}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Data Sync & Transparency */}
        <div className="hidden md:flex relative" ref={transparencyRef}>
          <button
            onClick={handleTransparencyClick}
            className="flex items-center gap-3 px-3 py-2.5 cursor-pointer rounded-md text-xs font-medium transition-all duration-200 border border-gray-200 bg-white hover:bg-gray-100 text-gray-700 shadow-sm"
          >
            <span className='italic'>Data Sync &amp; Transparency</span>
          </button>

          {showTransparency && (
            <div className="absolute right-0 top-10 w-80 bg-white border border-gray-200 rounded-lg shadow-lg py-2 z-50 animate-in fade-in slide-in-from-top-2 duration-150">
              <div className="px-4 py-3 border-b border-gray-100 flex justify-between items-center">
                <h3 className="text-sm font-bold text-gray-900">Cloud Sync Status</h3>
                <div
                  className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${deploymentMode === 'cloud'
                      ? 'bg-blue-100 text-blue-800'
                      : 'bg-orange-100 text-orange-800'
                    }`}
                >
                  {deploymentMode === 'cloud' ? 'Cloud Mode' : 'On-Prem Mode'}
                </div>
              </div>

              <div className="p-4">
                {transparencyLoading ? (
                  <div className="flex items-center justify-center gap-2 py-4 text-sm text-gray-500">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading transparency data…
                  </div>
                ) : transparencyData ? (
                  <div className="space-y-4">
                    <p className="text-xs text-gray-600 bg-gray-100 p-2 rounded border border-gray-100 font-medium">
                      {transparencyData.message}
                    </p>
                    <div className="space-y-3">
                      {transparencyData.visible_categories.map((cat, ix) => (
                        <div key={ix} className="text-xs">
                          <div className="flex items-center gap-2 mb-1">
                            <span
                              className={`w-2 h-2 rounded-full ${cat.is_synced ? 'bg-blue-500' : 'bg-gray-500'
                                }`}
                            />
                            <strong
                              className={cat.is_synced ? 'text-blue-900' : 'text-gray-500'}
                            >
                              {cat.category}
                            </strong>
                          </div>
                          <p className="text-gray-500 line-clamp-2 pl-4">{cat.details}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-center py-4 text-gray-500">Data unavailable.</div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Right Section: Search + Profile */}
        <div className="flex items-center gap-4">
          {/* Profile Avatar with Dropdown */}
          <div ref={profileRef} className="relative">
            <button
              onClick={() => setShowProfileDropdown(!showProfileDropdown)}
              className="w-8 h-8 cursor-pointer rounded-full bg-[#1a73e8] flex items-center justify-center text-white text-[13px] font-medium hover:bg-blue-700 transition-colors duration-200 uppercase"
              id="profile-btn"
            >
              {session?.user?.name
                ? session.user.name.charAt(0)
                : session?.user?.email?.charAt(0) ?? 'U'}
            </button>

            {showProfileDropdown && (
              <div className="absolute cursor-pointer right-0 mt-2 w-56 bg-white border border-gray-200 rounded-lg shadow-lg py-2 z-50 animate-in fade-in slide-in-from-top-2 duration-150 text-left">
                <div className="px-4 py-3 border-b border-gray-100">
                  <p className="text-sm font-medium text-gray-900">
                    {session?.user?.name ?? 'Admin User'}
                  </p>
                  <p className="text-xs text-gray-500 truncate">{session?.user?.email}</p>
                  <span className="inline-block mt-1 px-2 py-0.5 bg-blue-50 text-blue-700 text-[10px] font-bold rounded uppercase tracking-wide">
                    {session?.user?.role?.replace('_', ' ')}
                  </span>
                </div>
                <div className="border-t border-gray-100 py-1">
                  <button
                    onClick={() => signOut()}
                    className="w-full cursor-pointer text-left px-4 py-2 text-sm text-red-600 hover:bg-gray-100"
                  >
                    Sign Out
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

export default memo(TopNavbar);
