'use client';

/**
 * Sidebar navigation component.
 * Role-based navigation:
 *   super_admin  → Full detailed analytics pages (Dashboard, Features, Funnel, etc.)
 *   company_admin → Only Global Admin overview
 *   user         → Never sees this (blocked by AuthGuard)
 */

import React, { memo } from 'react';
import { usePathname } from 'next/navigation';
import Image from 'next/image';
import {
  LayoutDashboard,
  BarChart3,
  Filter,
  Users,
  Settings,
  Shield,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Eye,
  FileText,
  Key,
  Route,
  TrendingUp,
} from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/lib/store';
import { toggleSidebar } from '@/lib/dashboardSlice';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { buildAppScopedPath, resolveAppIdFromPathname, resolvePrimaryAppIdFromAdminApps } from '@/lib/feature-map';

/** Maps icon string identifiers to Lucide icon components */
const iconMap: Record<string, React.ElementType> = {
  'layout-dashboard': LayoutDashboard,
  'bar-chart-3': BarChart3,
  filter: Filter,
  users: Users,
  settings: Settings,
  shield: Shield,
  cloud: Cloud,
  eye: Eye,
  'file-text': FileText,
  key: Key,
  route: Route,
  'trending-up': TrendingUp,
};

interface SidebarProps { }

function Sidebar(_props: SidebarProps) {
  const dispatch = useAppDispatch();
  const { sidebarCollapsed } = useAppSelector((state) => state.dashboard);
  const pathname = usePathname();

  const { data: session } = useSession();
  const userName = session?.user?.name || session?.user?.email?.split('@')[0] || 'Admin';
  const role = session?.user?.role || 'user';
  const activeAppId = resolveAppIdFromPathname(pathname) || resolvePrimaryAppIdFromAdminApps(session?.user?.adminApps || []) || 'nexabank';

  // Build nav items based on role
  let navItems: { id: string; label: string; icon: string; href: string }[] = [];

  if (role === 'app_admin') {
    // App admin sees full detailed analytics for their app
    navItems = [
      { id: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard', href: buildAppScopedPath(activeAppId, '/dashboard') },
      { id: 'features', label: 'Feature Analytics', icon: 'bar-chart-3', href: buildAppScopedPath(activeAppId, '/features') },
      { id: 'funnel', label: 'Funnel Analysis', icon: 'filter', href: buildAppScopedPath(activeAppId, '/funnel') },
      { id: 'user-journey', label: 'User Journey', icon: 'route', href: buildAppScopedPath(activeAppId, '/user-journey') },
      { id: 'license-usage', label: 'License vs Usage', icon: 'key', href: buildAppScopedPath(activeAppId, '/license-usage') },
      { id: 'predictive', label: 'Predictive Insights', icon: 'trending-up', href: buildAppScopedPath(activeAppId, '/predictive') },
      { id: 'tenants', label: 'Tenants', icon: 'users', href: buildAppScopedPath(activeAppId, '/tenants') },
      { id: 'config', label: 'Configuration', icon: 'settings', href: buildAppScopedPath(activeAppId, '/settings') },
      { id: 'governance', label: 'Governance', icon: 'shield', href: buildAppScopedPath(activeAppId, '/governance') },
      { id: 'transparency', label: 'Trust & Transparency', icon: 'eye', href: buildAppScopedPath(activeAppId, '/transparency') },
      { id: 'ai-report', label: 'AI Report', icon: 'file-text', href: buildAppScopedPath(activeAppId, '/ai-report') }
    ];
  } else if (role === 'super_admin') {
    // Super admin sees only the Global Admin view
    navItems = [
      { id: 'admin', label: 'Global Overview', icon: 'cloud', href: '/admin' },
    ];
  }
  // Normal users: no nav items (they shouldn't even reach the dashboard)

  return (
    <aside
      className={`fixed left-0 top-0 h-screen bg-white border-r border-gray-100 z-30 flex flex-col transition-all duration-300 ${sidebarCollapsed ? 'w-16' : 'w-56'
        }`}
    >
      {/* Logo / Brand */}
      <div className={`flex items-center gap-2 border-b border-gray-100 h-16 ${sidebarCollapsed ? 'justify-center' : 'px-6'}`}>
        <Link href="/" className="relative w-10 h-10 shrink-0 transition-transform duration-300">
          <Image
            src="/logo1.png"
            alt="FinInsightsLogo"
            fill
            className="object-contain"
            priority
            sizes="40px"
          />
        </Link>
        {!sidebarCollapsed && (
          <span className="text-[18px] font-bold text-gray-900 tracking-tight">
            <span className='text-[#1a73e8] font-bold'>Fin</span>Insights
          </span>
        )}
      </div>

      {/* Role Badge */}
      {!sidebarCollapsed && (
        <div className="px-4 py-3 border-b border-gray-100">
          <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${role === 'app_admin'
            ? 'bg-orange-50 text-orange-700 border border-orange-200'
            : 'bg-blue-50 text-blue-700 border border-blue-200'
            }`}>
            {role === 'app_admin' ? (
              <>App Admin</>
            ) : (
              <>Super Admin</>
            )}
          </div>
        </div>
      )}

      {/* Navigation Items */}
      <nav className="flex-1 py-4 space-y-1 overflow-y-auto custom-scrollbar">
        {navItems.map((item) => {
          const IconComponent = iconMap[item.icon] || LayoutDashboard;
          const isActive = pathname === item.href || (item.id === 'dashboard' && pathname === '/');

          return (
            <Link
              key={item.id}
              href={item.href}
              className={`flex items-center gap-3 py-2.5 mx-3 rounded-lg text-[13px] font-medium transition-all duration-200 group
      ${sidebarCollapsed
                  ? 'justify-center px-0 text-gray-600 bg-transparent hover:bg-transparent'
                  : isActive
                    ? 'bg-[#f1f3f4] text-[#1a73e8] px-3'
                    : 'text-gray-600 px-3 hover:bg-gray-100'
                }`}
              title={sidebarCollapsed ? item.label : undefined}
            >
              <IconComponent
                className={`w-[18px] h-[18px] shrink-0 transition-colors
        ${sidebarCollapsed
                    ? isActive
                      ? 'text-[#1a73e8]'
                      : 'text-gray-500 group-hover:text-gray-700'
                    : isActive
                      ? 'text-[#1a73e8]'
                      : 'text-gray-500 group-hover:text-gray-700'
                  }`}
              />

              {!sidebarCollapsed && (
                <span className="truncate">{item.label}</span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Collapse Toggle */}
      <button
        onClick={() => dispatch(toggleSidebar())}
        className="mx-3 mb-4 cursor-pointer p-2 rounded-lg border border-gray-200 text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors flex items-center justify-center"
        aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {sidebarCollapsed ? (
          <ChevronRight className="w-4 h-4" />
        ) : (
          <ChevronLeft className="w-4 h-4" />
        )}
      </button>
    </aside>
  );
}

export default memo(Sidebar);
