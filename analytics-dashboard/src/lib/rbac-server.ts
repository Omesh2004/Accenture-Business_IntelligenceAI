// @ts-ignore Node built-ins are available in Next.js server runtime.
import fs from 'fs';
// @ts-ignore Node built-ins are available in Next.js server runtime.
import path from 'path';
import { UserRole } from './rbac';
import { TENANT_TO_APP } from './feature-map';

export interface RBACConfig {
  super_admins: string[];
  app_admins: Record<string, string[]>;
}

const APP_CANONICAL_MAP: Record<string, string> = { ...TENANT_TO_APP };

const cwd = (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.() || '.';
const RBAC_CONFIG_PATH = path.resolve(cwd, '../rbac.json');

let cachedConfig: RBACConfig = { super_admins: [], app_admins: {} };
let cachedMtimeMs = -1;

function normalizeEmail(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase();
}

function normalizeConfig(raw: RBACConfig): RBACConfig {
  const superAdmins = Array.from(
    new Set((raw.super_admins || []).map((email) => normalizeEmail(email)).filter(Boolean))
  );

  const appAdmins: Record<string, string[]> = {};
  for (const [appId, admins] of Object.entries(raw.app_admins || {})) {
    const normalizedAppId = APP_CANONICAL_MAP[String(appId).trim().toLowerCase()] || String(appId).trim().toLowerCase();
    const normalizedAdmins = Array.from(
      new Set((admins || []).map((email) => normalizeEmail(email)).filter(Boolean))
    );

    if (!appAdmins[normalizedAppId]) {
      appAdmins[normalizedAppId] = normalizedAdmins;
    } else {
      appAdmins[normalizedAppId] = Array.from(new Set([...appAdmins[normalizedAppId], ...normalizedAdmins]));
    }
  }

  return {
    super_admins: superAdmins,
    app_admins: appAdmins,
  };
}

export function getRbacConfig(): RBACConfig {
  try {
    if (!fs.existsSync(RBAC_CONFIG_PATH)) {
      return cachedConfig;
    }

    const stat = fs.statSync(RBAC_CONFIG_PATH);
    if (stat.mtimeMs === cachedMtimeMs) {
      return cachedConfig;
    }

    const parsed = JSON.parse(fs.readFileSync(RBAC_CONFIG_PATH, 'utf8')) as RBACConfig;
    cachedConfig = normalizeConfig(parsed);
    cachedMtimeMs = stat.mtimeMs;
    return cachedConfig;
  } catch (error) {
    console.error("Error reading rbac.json:", error);
  }
  return cachedConfig;
}

export function getUserRole(email: string | null | undefined): UserRole {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return 'user';
  
  const config = getRbacConfig();
  
  // Super admins: strict whitelist
  if (config.super_admins?.includes(normalizedEmail)) return 'super_admin';

  // App admins must be explicitly assigned in rbac.json
  for (const appId in config.app_admins) {
    const admins = config.app_admins[appId];
    if (admins && admins.includes(normalizedEmail)) {
      return 'app_admin';
    }
  }

  return 'user';
}

export function getAdminApps(email: string | null | undefined): string[] {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return [];
  
  const config = getRbacConfig();
  
  // Check if user has specific app assignments in rbac.json
  const assignedApps = new Set<string>();
  for (const appId in config.app_admins) {
    const admins = config.app_admins[appId];
    if (admins && admins.includes(normalizedEmail)) {
      const normalized = String(appId).trim().toLowerCase();
      assignedApps.add(APP_CANONICAL_MAP[normalized] || normalized);
    }
  }
  
  // If user has explicit assignments, return those; otherwise none.
  return Array.from(assignedApps);
}
