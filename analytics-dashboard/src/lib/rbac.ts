/**
 * RBAC Configuration — Central role whitelist.
 * 
 * Roles:
 *   super_admin → Overall platform admin
 *                 Sees aggregated cloud summary only. NO raw/detailed data.
 *   app_admin   → App-level admin for a specific app
 *                 Sees the FULL detailed analytics dashboard for their app.
 *   user        → Normal user, can use apps but cannot access any dashboards.
 */

import { SUPPORTED_APP_IDS, normalizeAppSlug } from '@/lib/feature-map';

export type UserRole = 'super_admin' | 'app_admin' | 'user';

function normalizeRbacPath(pathname: string): string {
  const segments = String(pathname || '').split('/').filter(Boolean);
  if (segments.length === 0) {
    return '/';
  }

  const firstSegment = normalizeAppSlug(segments[0]);
  if (SUPPORTED_APP_IDS.includes(firstSegment)) {
    if (segments.length === 1) {
      return '/';
    }
    return `/${segments.slice(1).join('/')}`;
  }

  return pathname;
}

/**
 * Strict route-based access control.
 * 
 * super_admin:
 *   ✅ / (landing), /admin (global summary), /apps/* (per-app summaries)
 *   ❌ /dashboard, /features, /funnel, /tenants, /settings, /governance
 * 
 * app_admin:
 *   ✅ / (landing), /dashboard, /features, /funnel, /tenants, /settings, /governance
 *   ❌ /admin, /apps/* (these show cross-tenant data the app admin shouldn't see)
 * 
 * user:
 *   ❌ Everything — should only use their assigned application
 */
export function canAccessRoute(role: UserRole, pathname: string): boolean {
  const normalizedPathname = normalizeRbacPath(pathname);

  // Login and unauthorized pages are always accessible
  if (normalizedPathname === '/login' || normalizedPathname === '/unauthorized') return true;
  
  // Public API routes
  if (normalizedPathname.startsWith('/api/auth')) return true;
  
  // Normal users can't access anything in the analytics dashboard
  if (role === 'user') return false;
  
  // Super admin: aggregated summary views ONLY
  if (role === 'super_admin') {
    if (normalizedPathname === '/') return true;
    if (normalizedPathname === '/admin') return true;
    if (normalizedPathname.startsWith('/apps/')) return true;
    // Block all detailed analytics routes
    return false;
  }
  
  // App admin: full detailed analytics for their app
  if (role === 'app_admin') {
    if (normalizedPathname === '/') return true;
    if (normalizedPathname === '/dashboard') return true;
    if (normalizedPathname.startsWith('/features')) return true;
    if (normalizedPathname.startsWith('/funnel')) return true;
    if (normalizedPathname.startsWith('/tenants')) return true;
    if (normalizedPathname.startsWith('/settings')) return true;
    if (normalizedPathname.startsWith('/governance')) return true;
    if (normalizedPathname.startsWith('/transparency')) return true;
    if (normalizedPathname.startsWith('/ai-report')) return true;
    if (normalizedPathname.startsWith('/license-usage')) return true;
    if (normalizedPathname.startsWith('/user-journey')) return true;
    if (normalizedPathname.startsWith('/predictive')) return true;
    // Block super admin routes — app admin shouldn't see cross-tenant data
    if (normalizedPathname === '/admin') return false;
    if (normalizedPathname.startsWith('/apps/')) return false;
    return false;
  }
  
  return false;
}
