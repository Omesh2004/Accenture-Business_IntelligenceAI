'use client';

/**
 * The dark navigation rail from the reference design.
 *
 * Role decides what is in it: an app admin gets their app's Dashboard and Intelligence, a super
 * admin gets the global overview, and an ordinary user never reaches this component at all.
 */

import React, { memo } from 'react';
import { usePathname } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { Brain, ChevronLeft, ChevronRight, Cloud, LayoutDashboard } from 'lucide-react';
import { useSession } from 'next-auth/react';
import { useAppDispatch, useAppSelector } from '@/lib/store';
import { toggleSidebar } from '@/lib/dashboardSlice';
import {
  buildAppScopedPath,
  resolveAppIdFromPathname,
  resolvePrimaryAppIdFromAdminApps,
} from '@/lib/feature-map';

const ICONS: Record<string, React.ElementType> = {
  'layout-dashboard': LayoutDashboard,
  brain: Brain,
  cloud: Cloud,
};

function Sidebar() {
  const dispatch = useAppDispatch();
  const { sidebarCollapsed } = useAppSelector((state) => state.dashboard);
  const pathname = usePathname();
  const { data: session } = useSession();

  const role = session?.user?.role || 'user';
  const email = session?.user?.email || '';
  const name = session?.user?.name || email.split('@')[0] || 'Admin';
  const appId =
    resolveAppIdFromPathname(pathname)
    || resolvePrimaryAppIdFromAdminApps(session?.user?.adminApps || [])
    || 'nexabank';

  let navItems: { id: string; label: string; icon: string; href: string }[] = [];
  if (role === 'app_admin') {
    navItems = [
      { id: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard',
        href: buildAppScopedPath(appId, '/dashboard') },
      { id: 'intelligence', label: 'Intelligence', icon: 'brain',
        href: buildAppScopedPath(appId, '/intelligence') },
    ];
  } else if (role === 'super_admin') {
    navItems = [{ id: 'admin', label: 'Global Overview', icon: 'cloud', href: '/admin' }];
  }

  const initial = (name[0] || 'A').toUpperCase();

  return (
    <aside
      className={`fixed left-0 top-0 z-30 flex h-screen flex-col transition-[width] duration-300
                  ${sidebarCollapsed ? 'w-[76px]' : 'w-[236px]'}`}
      style={{ background: 'var(--rail)' }}
    >
      <Link
        href="/"
        className={`flex h-[74px] items-center gap-2.5 ${sidebarCollapsed ? 'justify-center' : 'px-5'}`}
      >
        {/* Explicit width and height rather than `fill`: `fill` positions the image against the
            nearest positioned ancestor, and an inline span has no box for it to fill. */}
        <Image src="/logo1.png" alt="FinInsights" width={36} height={36} priority
               className="h-9 w-9 shrink-0 object-contain" />
        {/* The wordmark is painted through the text. The fallback colour matters: if a browser
            drops background-clip the wordmark would otherwise render fully transparent. */}
        {!sidebarCollapsed && (
          <span className="text-[length:var(--step-1)] font-semibold tracking-[-0.02em]"
                style={{
                  color: 'var(--rail-text-strong)',
                  backgroundImage:
                    'linear-gradient(100deg, var(--brand) 0%, #a78bfa 55%, #ffffff 100%)',
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                }}>
                FinInsights
          </span>
        )}
      </Link>

      {!sidebarCollapsed && role !== 'user' && (
        <div className="px-5 pb-4">
          <span
            className="inline-flex rounded-full px-3 py-1 text-[length:var(--step--2)] font-semibold uppercase tracking-[0.14em]"
            style={{ background: 'rgb(91 33 224 / 0.16)', color: '#b9a0fa' }}
          >
            {role === 'app_admin' ? 'App Admin' : 'Super Admin'}
          </span>
        </div>
      )}

      <nav className="flex-1 space-y-1.5 px-3">
        {navItems.map((item) => {
          const Icon = ICONS[item.icon] || LayoutDashboard;
          const active = pathname === item.href
            || (item.id === 'dashboard' && pathname === '/');
          return (
            <Link
              key={item.id}
              href={item.href}
              title={sidebarCollapsed ? item.label : undefined}
              className={`relative flex items-center gap-3 rounded-xl py-2.5 text-[length:var(--step--1)] font-medium
                          transition-colors duration-200
                          ${sidebarCollapsed ? 'justify-center px-0' : 'px-3.5'}`}
              style={{ color: active ? 'var(--rail-text-strong)' : 'var(--rail-text)' }}
            >
              {/* The active pill is a shared layout element, so switching pages slides it rather
                  than cross-fading two separate backgrounds. */}
              {active && (
                <motion.span
                  layoutId="rail-active"
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                  className="absolute inset-0 rounded-xl"
                  style={{ background: 'var(--rail-active)' }}
                />
              )}
              <Icon className="relative z-10 h-[18px] w-[18px] shrink-0" />
              {!sidebarCollapsed && <span className="relative z-10 truncate">{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      {!sidebarCollapsed && (
        <div className="mx-3 mb-3 flex items-center gap-2.5 rounded-xl px-3 py-2.5"
             style={{ background: 'var(--rail-raised)' }}>
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[length:var(--step--1)] font-semibold text-white"
                style={{ background: 'var(--brand-grad)' }}>
            {initial}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[length:var(--step--1)] font-medium"
                  style={{ color: 'var(--rail-text-strong)' }}>{name}</span>
            <span className="block truncate text-[length:var(--step--2)]" style={{ color: 'var(--rail-text)' }}>
              {email}
            </span>
          </span>
        </div>
      )}

      <button
        onClick={() => dispatch(toggleSidebar())}
        aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="mx-3 mb-4 flex cursor-pointer items-center justify-center rounded-xl py-2 transition-colors duration-200"
        style={{ background: 'var(--rail-raised)', color: 'var(--rail-text)' }}
      >
        {sidebarCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
      </button>
    </aside>
  );
}

export default memo(Sidebar);
