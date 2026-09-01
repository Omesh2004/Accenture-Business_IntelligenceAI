'use client';

/**
 * Dashboard layout component.
 * Wraps dashboard pages with sidebar and top navbar.
 * Handles responsive sidebar behavior.
 * Pages manage their own loading states, no global overlay.
 */

import { ReactNode } from 'react';
import Sidebar from '@/components/Sidebar';
import TopNavbar from '@/components/TopNavbar';
import { useAppSelector, RootState } from '@/lib/store';
import AuthGuard from '@/components/AuthGuard';
import PageTransition from '@/components/PageTransition';
import { useRealtimeEvents } from '@/hooks/useRealtimeEvents';
import { Activity } from 'lucide-react';

interface DashboardLayoutProps {
  children: ReactNode;
}

export default function DashboardLayoutClient({ children }: DashboardLayoutProps) {
  const { sidebarCollapsed } = useAppSelector((state: RootState) => state.dashboard);
  const { lastEvent } = useRealtimeEvents();

  return (
    <AuthGuard>
    <div className="relative min-h-screen font-sans" style={{ background: 'var(--surface-sunken)' }}>
      {/* Sidebar - hidden on mobile via CSS, toggled via Redux */}
      <div className="hidden lg:block print:hidden">
        <Sidebar />
      </div>

      {/* Mobile sidebar overlay */}
      <div className="lg:hidden print:hidden">
        {!sidebarCollapsed && (
          <>
            <div className="fixed inset-0 bg-black/20 backdrop-blur-sm z-20 print:hidden" />
            <Sidebar />
          </>
        )}
      </div>

      {/* Main Content Area */}
      <div
        className={`transition-all duration-300 print:ml-0 ${
          sidebarCollapsed ? 'lg:ml-[76px]' : 'lg:ml-[236px]'
        }`}
      >
        <div className="print:hidden sticky top-0 z-30">
          <TopNavbar />
        </div>

        <main className="p-4 lg:p-6 max-w-[1600px] mx-auto print:p-0 print:max-w-none min-h-[calc(100vh-64px)]">
          {/* One entrance animation for every route, so navigation feels like one product rather
              than a set of pages that each decided separately whether to animate. */}
          <PageTransition>{children}</PageTransition>
        </main>
      </div>
    </div>
    </AuthGuard>
  );
}
