/**
 * Feature Mapping Configuration
 * Maps technical routes to business-level feature names.
 * This is the configurable layer that translates raw URL paths
 * into meaningful feature names for the analytics dashboard.
 * 
 * To add a new app, simply add a new key with its route mappings.
 */

export interface FeatureMapping {
  pattern: string;        // URL pattern (supports simple glob with *)
  featureName: string;    // Business-level feature name
  category: 'navigation' | 'interaction' | 'transaction' | 'system';
  funnel?: number;        // Optional funnel step order (1-based)
}

export interface AppConfig {
  appId: string;
  displayName: string;
  description: string;
  tenantId: string;       // Maps to tenant_id in ClickHouse
  icon: string;           // Lucide icon name
  color: string;          // Brand color
  appUrl: string;         // The URL to open the app (e.g., http://localhost:3002/nexabank)
  funnelSteps: string[];  // Ordered funnel event names
  routes: FeatureMapping[];
}

export interface AppSuiteConfig {
  id: string;
  displayName: string;
  description: string;
  tenantIds: string[];
  primaryAppId: string;
  color: string;
  appUrl: string;
}

/**
 * Registry of all connected applications.
 * Add new apps here, no code changes needed elsewhere.
 */
export const APP_REGISTRY: Record<string, AppConfig> = {
  nexabank: {
    appId: 'nexabank',
    displayName: 'NexaBank',
    description: 'Modern digital banking platform with pro features',
    tenantId: 'nexabank',
    icon: 'wallet',
    color: '#7C3AED',
    appUrl: process.env.NEXT_PUBLIC_NEXABANK_URL || 'http://localhost:3002',
    // Keep funnel steps in backend canonical form to prevent alias drift.
    funnelSteps: [
      'login.auth.success',
      'dashboard.page.view',
      'loan.kyc_started.success',
      'loan.kyc_completed.success',
      'loan.applied.success',
    ],
    routes: [
      // Core Banking
      { pattern: '/login',            featureName: 'auth.login.view',              category: 'navigation',    funnel: 1 },
      { pattern: '/register',         featureName: 'auth.register.view',           category: 'navigation' },
      { pattern: '/dashboard',        featureName: 'core.dashboard.view',          category: 'navigation',    funnel: 2 },
      { pattern: '/accounts',         featureName: 'core.accounts.view',           category: 'navigation' },
      { pattern: '/transactions',     featureName: 'core.transactions.view',       category: 'navigation' },
      { pattern: '/payees',           featureName: 'core.payees.view',             category: 'navigation' },
      { pattern: '/profile',          featureName: 'core.profile.view',            category: 'navigation' },

      // Loans
      { pattern: '/loans',            featureName: 'loans.dashboard.view',         category: 'navigation',    funnel: 3 },

      // Pro Feature: Finance Library (ai-insights)
      { pattern: '/pro-feature?id=ai-insights',            featureName: 'pro.finance-library.view',     category: 'navigation' },

      // Pro Feature: Crypto Trading
      { pattern: '/pro-feature?id=crypto-trading',          featureName: 'pro.crypto-trading.view',      category: 'navigation' },

      // Pro Feature: Wealth Management
      { pattern: '/pro-feature?id=wealth-management-pro',   featureName: 'pro.wealth-management.view',   category: 'navigation' },

      // Pro Feature: Payroll Pro
      { pattern: '/pro-feature?id=bulk-payroll-processing', featureName: 'pro.payroll-pro.view',         category: 'navigation' },

      // Admin
      { pattern: '/admin*',           featureName: 'admin.dashboard.view',         category: 'system' },
    ],
  },
  safexbank: {
    appId: 'safexbank',
    displayName: 'SafexBank',
    description: 'Secure digital banking platform',
    tenantId: 'safexbank',
    icon: 'shield',
    color: '#3B82F6',
    appUrl: process.env.NEXT_PUBLIC_SAFEXBANK_URL || 'http://localhost:3003',
    // Safex uses the same canonical taxonomy consumed by /funnels.
    funnelSteps: [
      'login.auth.success',
      'dashboard.page.view',
      'transaction.pay_now.success',
    ],
    routes: [
      { pattern: '/login',            featureName: 'auth.login.view',              category: 'navigation',    funnel: 1 },
      { pattern: '/dashboard',        featureName: 'core.dashboard.view',          category: 'navigation',    funnel: 2 },
      { pattern: '/accounts',         featureName: 'core.accounts.view',           category: 'navigation' },
      { pattern: '/transfers',        featureName: 'core.transfers.view',          category: 'navigation',    funnel: 3 },
      { pattern: '/approvals',        featureName: 'core.approvals.view',          category: 'navigation',    funnel: 4 },
      { pattern: '/cards',            featureName: 'core.cards.view',              category: 'navigation' },
    ],
  },
};

export const APP_SUITES: AppSuiteConfig[] = [
  {
    id: 'nexabank',
    displayName: 'NexaBank',
    description: 'NexaBank tenants and analytics views',
    tenantIds: ['nexabank', 'safexbank'],
    primaryAppId: 'nexabank',
    color: APP_REGISTRY.nexabank.color,
    appUrl: APP_REGISTRY.nexabank.appUrl,
  },
];

export const TENANT_LABELS: Record<string, string> = {
  nexabank: 'NexaBank',
  safexbank: 'SafexBank',
};

export const TENANT_TO_APP: Record<string, 'nexabank'> = {
  nexabank: 'nexabank',
  safexbank: 'nexabank',
};

export const TENANT_TO_APP_NAME: Record<string, 'Nexabank'> = {
  nexabank: 'Nexabank',
  safexbank: 'Nexabank',
};

export const TENANT_CANONICAL_MAP: Record<string, string> = {
  nexabank: 'nexabank',
  safexbank: 'safexbank',
  bank_a: 'nexabank',
  bank_b: 'safexbank',
};

export const ALL_TENANT_IDS = APP_SUITES.flatMap((suite) => suite.tenantIds);

export const APP_TO_TENANTS: Record<string, string[]> = APP_SUITES.reduce<Record<string, string[]>>((acc, suite) => {
  acc[suite.id] = suite.tenantIds;
  return acc;
}, {});

export const SUPPORTED_RBAC_APPS = Array.from(
  new Set([...APP_SUITES.map((suite) => suite.id), ...ALL_TENANT_IDS])
);

export const SUPPORTED_APP_IDS = APP_SUITES.map((suite) => suite.id);

export function normalizeAppSlug(value: string): string {
  return String(value || '').trim().toLowerCase();
}

export function normalizeTenantId(value: string): string {
  const normalized = String(value || '').trim().toLowerCase();
  return TENANT_CANONICAL_MAP[normalized] || normalized;
}

export function resolvePrimaryTenantForApp(appId: string): string {
  const normalizedAppId = normalizeAppSlug(appId);
  const tenants = APP_TO_TENANTS[normalizedAppId] || [];
  if (tenants.length > 0) {
    return tenants[0];
  }
  return 'nexabank';
}

export function resolveAppIdFromPathname(pathname?: string | null): string | null {
  if (!pathname) return null;
  const appId = normalizeAppSlug(pathname.split('/').filter(Boolean)[0] || '');
  return SUPPORTED_APP_IDS.includes(appId) ? appId : null;
}

export function resolvePrimaryAppIdFromAdminApps(adminApps: string[] | undefined | null): string | null {
  if (!adminApps || adminApps.length === 0) return null;

  for (const app of adminApps) {
    const normalized = normalizeAppSlug(app);
    const appId = TENANT_TO_APP[normalized] || normalized;
    if (SUPPORTED_APP_IDS.includes(appId)) {
      return appId;
    }
  }

  return null;
}

export function resolveTenantIdsForApp(appId: string): string[] {
  return APP_TO_TENANTS[normalizeAppSlug(appId)] || [];
}

export function buildAppScopedPath(appId: string, pathname: string): string {
  const normalizedAppId = normalizeAppSlug(appId);
  const trimmedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `/${normalizedAppId}${trimmedPath}`;
}

/**
 * Resolves a URL path to its business-level feature name.
 * Returns null if no mapping found.
 */
export function resolveFeature(pathname: string): { appId: string; featureName: string; category: string } | null {
  for (const [appId, config] of Object.entries(APP_REGISTRY)) {
    for (const route of config.routes) {
      // Handle query-param based patterns (e.g., /pro-feature?id=crypto-trading)
      if (route.pattern.includes('?')) {
        const [patternPath, patternQuery] = route.pattern.split('?');
        const urlObj = (() => {
          try { return new URL(`http://x${pathname}`); }
          catch { return null; }
        })();
        
        if (urlObj && urlObj.pathname === patternPath) {
          const params = new URLSearchParams(patternQuery);
          const urlParams = urlObj.searchParams;
          let allMatch = true;
          for (const [key, value] of params.entries()) {
            if (urlParams.get(key) !== value) {
              allMatch = false;
              break;
            }
          }
          if (allMatch) {
            return { appId, featureName: route.featureName, category: route.category };
          }
        }
        continue;
      }
      
      const regex = new RegExp('^' + route.pattern.replace(/\*/g, '.*') + '$');
      if (regex.test(pathname)) {
        return { appId, featureName: route.featureName, category: route.category };
      }
    }
  }
  return null;
}

/**
 * Reverse lookup to find a URL pattern for a given feature name.
 * E.g., 'core.payees.view' => '/payees'
 */
export function resolveUrlFromFeature(featureName: string, appId: string = 'nexabank'): string | null {
  const app = APP_REGISTRY[appId];
  if (!app) return null;

  for (const route of app.routes) {
    if (route.featureName === featureName) {
      // Remove trailing asterisk if it's a wildcard pattern for clean clicking
      return route.pattern.replace(/\*$/, '');
    }
  }
  return null;
}
