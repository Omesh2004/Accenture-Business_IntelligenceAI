import express, { Request, Response } from "express";
import { prisma } from "../prisma";
import { isLoggedIn, isAdmin } from "../middleware/IsLoggedIn";
import { trackEvent } from "../middleware/eventTracker";
import { UAParser } from "ua-parser-js";
import axios from "axios";

const router = express.Router();

const ANALYTICS_API_URL = process.env.ANALYTICS_API_URL || "http://analytics-api:8001";
const TENANT_ALIAS_MAP: Record<string, string> = {
  bank_a: "nexabank",
  bank_b: "safexbank",
};
const GLOBAL_ANALYTICS_TENANTS = "nexabank,safexbank";
const GLOBAL_LOCAL_TENANTS = ["bank_a", "bank_b"];

function normalizeToggleKey(rawKey: string): string {
  const key = String(rawKey || "").trim().toLowerCase();
  if (!key) return key;

  return key
    .replace(/_page[._]view$/i, ".page.view")
    .replace(/\.page_view$/i, ".page.view")
    .replace(/_dashboard[._]view$/i, ".dashboard.view")
    .replace(/\.dashboard_view$/i, ".dashboard.view")
    .replace(/\.{2,}/g, ".");
}

function toAnalyticsTenant(tenantId: string): string {
  const key = String(tenantId || "").toLowerCase();
  return TENANT_ALIAS_MAP[key] || key;
}

// ─── POST /events/track ────────────────────────────────────────
// Generic custom event tracker for frontend
router.post(
  "/events/track",
  isLoggedIn,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { eventType, metadata } = req.body;
      const customerId = (req as any).user?.id;
      const tenantId = (req as any).user?.tenantId || "bank_a";

      if (!customerId || !eventType) {
        res.status(400).json({ error: "Missing required fields" });
        return;
      }

      await trackEvent(eventType, customerId, tenantId, metadata);
      res.status(200).json({ success: true });
    } catch (err) {
      console.error("Frontend event tracking error:", err);
      res.status(500).json({ error: "Failed to track event" });
    }
  }
);

// ─── POST /events/location ─────────────────────────────────────
// Store geo-location + device metadata for a logged-in user
router.post(
  "/events/location",
  isLoggedIn,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const {
        latitude,
        longitude,
        country,
        city,
        ip,
      } = req.body as {
        latitude?: number;
        longitude?: number;
        country?: string;
        city?: string;
        ip?: string;
      };

      const userContext = (req as any).user;
      const customerId = userContext?.id;
      const tenantId = userContext?.tenantId ?? "bank_a";

      if (!customerId) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }

      // Parse device info from user-agent
      const rawUA = req.headers["user-agent"] ?? "";
      const parser = new UAParser(rawUA);
      const result = parser.getResult();

      let deviceType = "desktop";
      if (result.device.type === "mobile") deviceType = "mobile";
      else if (result.device.type === "tablet") deviceType = "tablet";

      const platform = `${result.os.name ?? "Unknown"} / ${result.browser.name ?? "Unknown"}`;

      await prisma.userLocation.create({
        data: {
          customerId,
          latitude: latitude ?? null,
          longitude: longitude ?? null,
          country: country ?? null,
          city: city ?? null,
          ip: ip ?? req.ip ?? null,
          deviceType,
          userAgent: rawUA.substring(0, 500),
          platform,
        },
      });

      await trackEvent("location_captured", customerId, tenantId, {
        country, city, deviceType, platform,
      });

      res.status(200).json({ message: "Location stored successfully" });
    } catch (err) {
      console.error("Location capture error:", err);
      res.status(500).json({ error: "Failed to store location" });
    }
  }
);

// ─── GET /events/toggles/:tenantId ────────────────────────────
// Get feature toggles for a tenant
router.get(
  "/events/toggles/:tenantId",
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId } = req.params;
    try {
      const analyticsResp = await axios.get(`${ANALYTICS_API_URL}/tracking/toggles`, {
        params: { tenants: GLOBAL_ANALYTICS_TENANTS },
        headers: {
          "X-User-Role": "super_admin",
          "X-User-Email": "nexabank-toggle-bridge@system.local",
        },
        timeout: 15000,
      });

      const togglesList = Array.isArray(analyticsResp.data?.toggles) ? analyticsResp.data.toggles : [];
      const map: Record<string, boolean> = {};
      for (const item of togglesList) {
        if (item?.feature_name) {
          const normalizedKey = normalizeToggleKey(String(item.feature_name));
          if (normalizedKey) {
            map[normalizedKey] = Boolean(item.is_enabled);
          }
        }
      }

      res.status(200).json(map);
      return;
    } catch {
      // Fall back to local Prisma toggles to keep NexaBank operational if analytics API is unavailable.
    }

    try {
      const toggles = await prisma.featureToggle.findMany({ where: { tenantId: { in: GLOBAL_LOCAL_TENANTS } } });

      // Return as map: { emi_calculator: true, kyc: true, loan_module: true }
      const map: Record<string, boolean> = {};
      for (const t of toggles) {
        const normalizedKey = normalizeToggleKey(t.key);
        if (!normalizedKey) continue;
        const previous = map[normalizedKey];
        map[normalizedKey] = previous === undefined ? t.enabled : previous && t.enabled;
      }

      res.status(200).json(map);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch toggles" });
    }
  }
);

// ─── PUT /events/toggles/:key ──────────────────────────────────
// Update a feature toggle (admin only)
router.put(
  "/events/toggles/:key",
  isLoggedIn,
  isAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const { key } = req.params;
    const { enabled, tenantId } = req.body as { enabled: boolean; tenantId: string };
    const normalizedKey = normalizeToggleKey(key);

    try {
      const actorEmail = (req as any).user?.email || "nexabank-admin@system.local";

      await axios.post(
        `${ANALYTICS_API_URL}/tracking/toggles`,
        {
          tenant_id: GLOBAL_ANALYTICS_TENANTS,
          feature_name: normalizedKey,
          is_enabled: enabled,
          actor_email: actorEmail,
        },
        {
          headers: {
            "X-User-Role": "super_admin",
            "X-User-Email": actorEmail,
          },
          timeout: 15000,
        }
      );

      const updates = await Promise.all(
        GLOBAL_LOCAL_TENANTS.map((tenant) =>
          prisma.featureToggle.upsert({
            where: { key_tenantId: { key: normalizedKey, tenantId: tenant } },
            update: { enabled },
            create: { key: normalizedKey, enabled, tenantId: tenant },
          })
        )
      );

      res.status(200).json({ key: normalizedKey, enabled, tenantsUpdated: GLOBAL_LOCAL_TENANTS, count: updates.length });
    } catch (err) {
      res.status(500).json({ error: "Failed to update toggle" });
    }
  }
);

// ─── GET /events/admin/stats ───────────────────────────────────
// Admin: get analytics overview
router.get(
  "/events/admin/stats",
  isLoggedIn,
  isAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const [
        totalUsers,
        totalEvents,
        totalTransactions,
        totalLoanApps,
        recentEvents,
      ] = await Promise.all([
        prisma.customer.count(),
        prisma.event.count(),
        prisma.transaction.count(),
        prisma.loanApplication.count(),
        prisma.event.findMany({
          orderBy: { timestamp: "desc" },
          take: 20,
        }),
      ]);

      res.status(200).json({
        totalUsers,
        totalEvents,
        totalTransactions,
        totalLoanApps,
        recentEvents,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch admin stats" });
    }
  }
);

// ─── GET /events/admin/locations ──────────────────────────────
// Admin: get all user locations with device metadata
router.get(
  "/events/admin/locations",
  isLoggedIn,
  isAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const locations = await prisma.userLocation.findMany({
        orderBy: { timestamp: "desc" },
        take: 100,
        include: {
          customer: {
            select: { name: true, email: true, tenantId: true },
          },
        },
      });
      res.status(200).json(locations);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch locations" });
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// ─── STOCHASTIC SIMULATION ENGINE ─────────────────────────────
// ═══════════════════════════════════════════════════════════════

// Helper: Gaussian-like random using Box-Muller
function gaussianRandom(mean: number, stdDev: number): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const normal = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return Math.max(0, mean + stdDev * normal);
}

// Helper: Pick random item
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Helper: Weighted random pick
function weightedPick<T>(items: T[], weights: number[]): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

// ═══════════════════════════════════════════════════════════════
// ─── WORLDWIDE CITIES (6 continents, 40+ cities) ─────────────
// ═══════════════════════════════════════════════════════════════

interface WorldCity {
  city: string;
  country: string;
  continent: string;
  lat: number;
  lon: number;
}

const WORLDWIDE_CITIES: WorldCity[] = [
  // ── Asia (30% weight) ─────────────────────────
  { city: "Mumbai", country: "India", continent: "Asia", lat: 19.076, lon: 72.877 },
  { city: "Delhi", country: "India", continent: "Asia", lat: 28.613, lon: 77.209 },
  { city: "Bangalore", country: "India", continent: "Asia", lat: 12.971, lon: 77.594 },
  { city: "Hyderabad", country: "India", continent: "Asia", lat: 17.385, lon: 78.486 },
  { city: "Chennai", country: "India", continent: "Asia", lat: 13.082, lon: 80.270 },
  { city: "Kolkata", country: "India", continent: "Asia", lat: 22.572, lon: 88.363 },
  { city: "Pune", country: "India", continent: "Asia", lat: 18.520, lon: 73.856 },
  { city: "Jaipur", country: "India", continent: "Asia", lat: 26.912, lon: 75.787 },
  { city: "Tokyo", country: "Japan", continent: "Asia", lat: 35.682, lon: 139.692 },
  { city: "Singapore", country: "Singapore", continent: "Asia", lat: 1.352, lon: 103.820 },
  { city: "Dubai", country: "UAE", continent: "Asia", lat: 25.276, lon: 55.296 },
  { city: "Shanghai", country: "China", continent: "Asia", lat: 31.230, lon: 121.474 },
  { city: "Seoul", country: "South Korea", continent: "Asia", lat: 37.566, lon: 126.978 },
  { city: "Bangkok", country: "Thailand", continent: "Asia", lat: 13.756, lon: 100.502 },

  // ── North America (25% weight) ────────────────
  { city: "New York", country: "USA", continent: "North America", lat: 40.713, lon: -74.006 },
  { city: "San Francisco", country: "USA", continent: "North America", lat: 37.774, lon: -122.419 },
  { city: "Los Angeles", country: "USA", continent: "North America", lat: 34.052, lon: -118.244 },
  { city: "Chicago", country: "USA", continent: "North America", lat: 41.878, lon: -87.630 },
  { city: "Toronto", country: "Canada", continent: "North America", lat: 43.653, lon: -79.384 },
  { city: "Vancouver", country: "Canada", continent: "North America", lat: 49.283, lon: -123.121 },
  { city: "Mexico City", country: "Mexico", continent: "North America", lat: 19.433, lon: -99.133 },
  { city: "Austin", country: "USA", continent: "North America", lat: 30.267, lon: -97.743 },

  // ── Europe (25% weight) ───────────────────────
  { city: "London", country: "United Kingdom", continent: "Europe", lat: 51.507, lon: -0.128 },
  { city: "Berlin", country: "Germany", continent: "Europe", lat: 52.520, lon: 13.405 },
  { city: "Paris", country: "France", continent: "Europe", lat: 48.857, lon: 2.352 },
  { city: "Amsterdam", country: "Netherlands", continent: "Europe", lat: 52.370, lon: 4.895 },
  { city: "Stockholm", country: "Sweden", continent: "Europe", lat: 59.329, lon: 18.069 },
  { city: "Zurich", country: "Switzerland", continent: "Europe", lat: 47.376, lon: 8.542 },
  { city: "Madrid", country: "Spain", continent: "Europe", lat: 40.417, lon: -3.704 },
  { city: "Milan", country: "Italy", continent: "Europe", lat: 45.464, lon: 9.190 },

  // ── South America (10% weight) ────────────────
  { city: "São Paulo", country: "Brazil", continent: "South America", lat: -23.551, lon: -46.633 },
  { city: "Buenos Aires", country: "Argentina", continent: "South America", lat: -34.604, lon: -58.382 },
  { city: "Bogotá", country: "Colombia", continent: "South America", lat: 4.711, lon: -74.072 },
  { city: "Santiago", country: "Chile", continent: "South America", lat: -33.449, lon: -70.669 },

  // ── Africa (5% weight) ────────────────────────
  { city: "Lagos", country: "Nigeria", continent: "Africa", lat: 6.524, lon: 3.379 },
  { city: "Nairobi", country: "Kenya", continent: "Africa", lat: -1.286, lon: 36.817 },
  { city: "Cape Town", country: "South Africa", continent: "Africa", lat: -33.919, lon: 18.424 },
  { city: "Cairo", country: "Egypt", continent: "Africa", lat: 30.044, lon: 31.236 },

  // ── Oceania (5% weight) ───────────────────────
  { city: "Sydney", country: "Australia", continent: "Oceania", lat: -33.868, lon: 151.209 },
  { city: "Melbourne", country: "Australia", continent: "Oceania", lat: -37.814, lon: 144.963 },
  { city: "Auckland", country: "New Zealand", continent: "Oceania", lat: -36.849, lon: 174.763 },
];

// Continent distribution weights for proportional simulation
const CONTINENT_WEIGHTS: Record<string, number> = {
  "Asia": 30,
  "North America": 25,
  "Europe": 25,
  "South America": 10,
  "Africa": 5,
  "Oceania": 5,
};

function pickWorldwideCity(): WorldCity {
  // First pick continent based on weights
  const continents = Object.keys(CONTINENT_WEIGHTS);
  const weights = Object.values(CONTINENT_WEIGHTS);
  const continent = weightedPick(continents, weights);
  // Then pick random city within that continent
  const citiesInContinent = WORLDWIDE_CITIES.filter(c => c.continent === continent);
  return pick(citiesInContinent);
}

// ═══════════════════════════════════════════════════════════════
// ─── DATA POOLS ──────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

// Worldwide name pools for realistic diversity
const FIRST_NAMES_POOL: Record<string, string[]> = {
  "Asia": ["Aarav", "Priya", "Rahul", "Neha", "Amit", "Sneha", "Vikas", "Pooja", "Rajan", "Divya", "Karan", "Anita", "Yuki", "Hiro", "Min-Jun", "Wei", "Siti", "Arjun"],
  "North America": ["James", "Emily", "Michael", "Sarah", "David", "Jessica", "Robert", "Ashley", "Carlos", "Maria", "Tyler", "Brittany", "Brandon", "Madison", "Justin", "Megan"],
  "Europe": ["Oliver", "Emma", "Lucas", "Sophie", "Hans", "Amelie", "Pierre", "Isabella", "Lars", "Elena", "Sebastian", "Anna", "Marco", "Claire", "Erik", "Marta"],
  "South America": ["Mateo", "Valentina", "Santiago", "Camila", "Diego", "Luciana", "Gabriel", "Antonella", "Pablo", "Isabela", "Thiago", "Carolina"],
  "Africa": ["Kwame", "Amina", "Chidi", "Fatima", "Tendai", "Zara", "Emeka", "Aisha", "Sipho", "Nala", "Oluwaseun", "Khadija"],
  "Oceania": ["Liam", "Charlotte", "Jack", "Olivia", "Mason", "Chloe", "Ethan", "Mia", "Noah", "Isla"],
};

const LAST_NAMES_POOL: Record<string, string[]> = {
  "Asia": ["Sharma", "Patel", "Kumar", "Singh", "Verma", "Gupta", "Tanaka", "Suzuki", "Kim", "Li", "Chen", "Rao", "Nair", "Iyer"],
  "North America": ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez", "Wilson", "Anderson"],
  "Europe": ["Müller", "Schmidt", "Martin", "Dupont", "Rossi", "Ferrari", "Andersson", "De Vries", "Garcia", "Williams", "Taylor", "Wilson"],
  "South America": ["Silva", "Santos", "Oliveira", "Souza", "Pereira", "González", "Rodríguez", "López", "Hernández", "Morales"],
  "Africa": ["Okafor", "Kamau", "Van der Merwe", "Hassan", "Ibrahim", "Mwangi", "Osei", "Dlamini", "El-Masry", "Adeyemi"],
  "Oceania": ["Smith", "Williams", "Brown", "Wilson", "Taylor", "Anderson", "Thomas", "O'Brien", "Campbell", "Kelly"],
};

const SPEND_CATEGORIES = ["FOOD", "SHOPPING", "ENTERTAINMENT", "HOUSING", "OTHERS", "TRANSPORT", "UTILITIES", "HEALTHCARE"];
const CHANNELS: ("WEB" | "MOBILE")[] = ["WEB", "MOBILE"];
const CHANNEL_WEIGHTS = [45, 55]; // Mobile-first, no ATM/POS simulation noise
const LOAN_TYPES = ["HOME", "AUTO", "PERSONAL", "STUDENT"] as ("HOME" | "AUTO" | "PERSONAL" | "STUDENT")[];
const PRO_FEATURES = ["pro-feature?id=crypto-trading", "wealth_rebalance", "pro-feature?id=bulk-payroll-processing", "ai_insight_download"];
const DEVICE_TYPES = ["desktop", "mobile", "tablet"];
const DEVICE_WEIGHTS = [35, 50, 15];
const BROWSERS = ["Chrome", "Safari", "Firefox", "Edge", "Samsung Internet"];
const BROWSER_WEIGHTS = [55, 25, 10, 7, 3];
const PLATFORMS = ["Android / Chrome", "iOS / Safari", "Windows / Chrome", "macOS / Safari", "Windows / Edge", "Linux / Firefox"];
const STREET_NAMES: Record<string, string[]> = {
  "Asia": ["MG Road", "Park Street", "Anna Nagar", "Salt Lake", "Banjara Hills", "Connaught Place", "Marine Drive", "Brigade Road"],
  "North America": ["Broadway", "Main Street", "Oak Avenue", "Maple Drive", "Sunset Blvd", "5th Avenue", "Market Street", "Lake Shore Dr"],
  "Europe": ["High Street", "Königstraße", "Rue de Rivoli", "Via Roma", "Gran Vía", "Keizersgracht", "Oxford Street", "Champs-Élysées"],
  "South America": ["Av. Paulista", "Av. 9 de Julio", "Carrera 7", "Av. Providencia"],
  "Africa": ["Victoria Island", "Kenyatta Avenue", "Long Street", "Tahrir Square"],
  "Oceania": ["George Street", "Collins Street", "Queen Street", "Pitt Street"],
};

interface UserPersona {
  userType: "casual_user" | "salary_user" | "power_user" | "business_user";
  loginProbability: number;     // 0.15–0.95 (daily chance of logging in)
  spendingRate: number;         // 0.1–0.8 (chance of spending per login)
  averageSpend: number;         // mean spend amount
  proConversionChance: number;  // 0.02–0.4 (base, multiplied by whale factor)
  kycCompletionRate: number;    // 0.3–0.9 (chance of completing KYC)
  failureRate: number;          // 0.02–0.06 (chance of transaction failure)
  loanInterest: number;        // 0.1–0.6 (chance of applying for loan)
  salaryRange: [number, number]; // [min, max]
  preferredChannel: "WEB" | "MOBILE";
  deviceType: string;
  browser: string;
  isEnterprise: boolean;
}

function generatePersona(): UserPersona {
  const isWhale = Math.random() < 0.15; // 15% are high-value customers
  const isCasual = Math.random() < 0.3; // 30% are casual users
  const isBusiness = !isCasual && Math.random() < 0.2;

  const userType: UserPersona["userType"] = isBusiness
    ? "business_user"
    : isWhale
      ? "power_user"
      : isCasual
        ? "casual_user"
        : "salary_user";

  return {
    userType,
    loginProbability: isCasual ? 0.15 + Math.random() * 0.25 : 0.5 + Math.random() * 0.45,
    spendingRate: isCasual ? 0.1 + Math.random() * 0.2 : 0.3 + Math.random() * 0.5,
    averageSpend: isWhale ? 5000 + Math.random() * 20000 : 500 + Math.random() * 3000,
    proConversionChance: isWhale ? 0.15 + Math.random() * 0.25 : 0.02 + Math.random() * 0.08,
    kycCompletionRate: 0.3 + Math.random() * 0.6,
    failureRate: 0.02 + Math.random() * 0.04,
    loanInterest: isCasual ? 0.05 + Math.random() * 0.1 : 0.15 + Math.random() * 0.45,
    salaryRange: isWhale ? [80000, 200000] : [25000, 70000],
    preferredChannel: weightedPick(CHANNELS, CHANNEL_WEIGHTS),
    deviceType: weightedPick(DEVICE_TYPES, DEVICE_WEIGHTS),
    browser: weightedPick(BROWSERS, BROWSER_WEIGHTS),
    isEnterprise: Math.random() < 0.4, // 40% of users are on the "enterprise" platform tier natively
  };
}

// Helper: Generate location metadata for analytics pipeline
function locationMeta(loc: WorldCity, persona: UserPersona) {
  return {
    continent: loc.continent,
    country: loc.country,
    city: loc.city,
    user_type: persona.userType,
    location: loc.country, // backwards compat with analytics /locations endpoint
    device_type: persona.deviceType,
    browser: persona.browser,
  };
}

// ─── POST /events/simulate ────────────────────────────────────
// Admin only: stochastic user journey simulation
router.post(
  "/events/simulate",
  async (req: Request, res: Response): Promise<void> => {
    const tenantAliasMap: Record<string, string> = {
      nexabank: "bank_a",
      safexbank: "bank_b",
    };

    const rawCount = Number((req.body as { count?: unknown })?.count);
    const rawDays = Number((req.body as { days?: unknown })?.days);
    const rawTenant = String((req.body as { tenantId?: unknown })?.tenantId || "")
      .trim()
      .toLowerCase();

    const tenantId = tenantAliasMap[rawTenant] || rawTenant || "bank_a";
    const count = Number.isFinite(rawCount)
      ? Math.max(1, Math.min(Math.floor(rawCount), 100))
      : 50;
    const days = Number.isFinite(rawDays)
      ? Math.max(1, Math.min(Math.floor(rawDays), 60))
      : 30;

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      res.status(400).json({ error: "Invalid tenant" });
      return;
    }

    try {
      const bcrypt = await import("bcryptjs");
      const startedAt = Date.now();
      let usersCreated = 0;
      let transactionsCreated = 0;
      let eventsCreated = 0;
      let applicationsCreated = 0;
      let compliantUsers = 0;
      let analyticsOptInUsers = 0;
      let skippedUsers = 0;
      const createdUserIds: string[] = [];

      const simDays = Math.min(days, 60);
      const userCount = Math.min(count, 100);

      for (let i = 0; i < userCount; i++) {
        // ─── 1. Generate WORLDWIDE User Identity ────────────
        const location = pickWorldwideCity();
        const firstName = pick(FIRST_NAMES_POOL[location.continent] || FIRST_NAMES_POOL["Asia"]);
        const lastName = pick(LAST_NAMES_POOL[location.continent] || LAST_NAMES_POOL["Asia"]);
        const name = `${firstName} ${lastName}`;
        const seed = Date.now() + i + Math.floor(Math.random() * 10000);
        const email = `${firstName.toLowerCase()}.${seed}@nexabank.demo`;
        const phone = `9${Math.floor(100000000 + Math.random() * 900000000)}`;
        const pan = `${String.fromCharCode(65 + Math.floor(Math.random() * 26))}${String.fromCharCode(65 + Math.floor(Math.random() * 26))}${String.fromCharCode(65 + Math.floor(Math.random() * 26))}${String.fromCharCode(65 + Math.floor(Math.random() * 26))}${String.fromCharCode(65 + Math.floor(Math.random() * 26))}${Math.floor(1000 + Math.random() * 9000)}${String.fromCharCode(65 + Math.floor(Math.random() * 26))}`;
        const hashedPw = await bcrypt.hash("Password@123", 10);

        // ─── 2. Generate Persona (behavioral traits) ────────
        const persona = generatePersona();
        // session_id is refreshed per login boundary below (registration, each active day, live
        // pulse) so simulated traffic is session-groupable like the real live/seeded paths.
        let lMeta = { ...locationMeta(location, persona), session_id: `sess_sim_${seed}_reg` };

        // ─── 3. Compute join date ───────────────────────────
        const joinDaysAgo = Math.floor(Math.random() * simDays);
        const joinDate = new Date();
        joinDate.setDate(joinDate.getDate() - joinDaysAgo);
        const baseTs = Math.floor(joinDate.getTime() / 1000);

        // ─── 4. Create customer ─────────────────────────────
        const streets = STREET_NAMES[location.continent] || STREET_NAMES["Asia"];
        let customer;
        try {
          const hasAnalyticsOptIn = Math.random() < 0.78;
          customer = await prisma.customer.create({
            data: {
              name, email, phone, password: hashedPw, pan, tenantId,
              dateOfBirth: new Date(1975 + Math.floor(Math.random() * 30), Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 28)),
              settingConfig: {
                analyticsOptIn: hasAnalyticsOptIn,
                theme: Math.random() < 0.5 ? "light" : "dark",
              },
              address: { street: `${Math.floor(1 + Math.random() * 500)}, ${pick(streets)}`, city: location.city, state: location.country, zip: `${400000 + Math.floor(Math.random() * 200000)}` },
              kycStatus: "NOT_STARTED",
            },
          });

          if (hasAnalyticsOptIn) {
            analyticsOptInUsers++;
          }
        } catch (e) {
          // Duplicate phone/email/pan — skip
          skippedUsers++;
          continue;
        }
        usersCreated++;
        createdUserIds.push(customer.id);

        // ─── 5. Create savings account ──────────────────────
        const accNo = `NEXA${String(seed).slice(-8)}`;
        let account;
        try {
          account = await prisma.account.create({
            data: {
              accNo, customerId: customer.id,
              ifsc: `${tenant.ifscPrefix}${tenant.branchCode}`,
              accountType: "SAVINGS",
              balance: 0,
            },
          });
        } catch (e) {
          skippedUsers++;
          continue;
        }

        // Track registration with worldwide location
        await trackEvent("free.auth.register.success", customer.id, tenantId, { channel: persona.preferredChannel, ...lMeta }, baseTs);
        await trackEvent("free.auth.login.success", customer.id, tenantId, { channel: persona.preferredChannel, ...lMeta }, baseTs + 60);
        eventsCreated += 2;
        if ((customer.settingConfig as Record<string, unknown>)?.analyticsOptIn === true) {
          await trackEvent("core.analytics.opt_in", customer.id, tenantId, { source: "simulation", ...lMeta }, baseTs + 90);
          eventsCreated++;
        }

        // ─── 6. Initial salary deposit ──────────────────────
        const salary = Math.floor(persona.salaryRange[0] + Math.random() * (persona.salaryRange[1] - persona.salaryRange[0]));
        await prisma.transaction.create({
          data: {
            transactionType: "DEPOSIT",
            senderAccNo: "EXTERNAL-BANK", receiverAccNo: accNo,
            amount: salary, status: "SUCCESS",
            category: "Salary Credit",
            channel: "WEB",
            timestamp: new Date((baseTs + 300) * 1000),
          }
        });
        transactionsCreated++;
        let currentBalance = salary;
        await prisma.account.update({ where: { accNo }, data: { balance: currentBalance } });

        // Store initial location with worldwide data
        await prisma.userLocation.create({
          data: {
            customerId: customer.id,
            latitude: location.lat + (Math.random() - 0.5) * 0.1,
            longitude: location.lon + (Math.random() - 0.5) * 0.1,
            country: location.country,
            city: location.city,
            ip: `${100 + Math.floor(Math.random() * 50)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
            deviceType: persona.deviceType,
            platform: pick(PLATFORMS),
          },
        });

        // ─── 7. State Machine: 30-Day Journey ──────────────
        let kycState: "NOT_STARTED" | "PENDING" | "VERIFIED" | "REJECTED" = "NOT_STARTED";
        let isPro = false;
        let hasAppliedLoan = false;
        let unlockedFeature = "";

        for (let day = 0; day <= joinDaysAgo; day++) {
          const dayTs = baseTs + (day * 86400) + Math.floor(Math.random() * 43200); // random hour within the day

          // ── Salary deposit on 1st and 15th of month ───────
          const dayOfMonth = new Date(dayTs * 1000).getDate();
          if (dayOfMonth === 1 || dayOfMonth === 15) {
            const monthlySalary = Math.floor(gaussianRandom(salary, salary * 0.1));
            await prisma.transaction.create({
              data: {
                transactionType: "DEPOSIT",
                senderAccNo: "EXTERNAL-BANK", receiverAccNo: accNo,
                amount: monthlySalary, status: "SUCCESS",
                category: "Salary Credit", channel: "WEB",
                timestamp: new Date((dayTs + 100) * 1000),
              }
            });
            currentBalance += monthlySalary;
            await prisma.account.update({ where: { accNo }, data: { balance: currentBalance } });
            transactionsCreated++;
          }

          // ── Daily Login Roll ──────────────────────────────
          if (Math.random() > persona.loginProbability) continue;

          // User logged in today -- each day is its own session for session-grain analytics
          lMeta = { ...lMeta, session_id: `sess_sim_${seed}_d${day}` };
          const channel = Math.random() < 0.6 ? persona.preferredChannel : pick(CHANNELS);
          await trackEvent("free.auth.login.success", customer.id, tenantId, { channel, ...lMeta, day }, dayTs);
          eventsCreated++;

          // Update lastLogin
          await prisma.customer.update({
            where: { id: customer.id },
            data: { lastLogin: new Date(dayTs * 1000) },
          });

          // ════════════════════════════════════════════════════
          // ─── REALISTIC USER JOURNEY FLOWS ───────────────────
          // Each login triggers a realistic sequence of actions
          // ════════════════════════════════════════════════════

          // Flow 1: Dashboard → View Accounts → View Transactions
          if (Math.random() < 0.7) {
            await trackEvent("free.dashboard.view", customer.id, tenantId, { channel, ...lMeta }, dayTs + 200);
            eventsCreated++;
          }
          if (Math.random() < 0.4) {
            await trackEvent("free.accounts.view", customer.id, tenantId, { ...lMeta }, dayTs + 400);
            eventsCreated++;
          }
          if (Math.random() < 0.3) {
            await trackEvent("free.transactions.view", customer.id, tenantId, { ...lMeta }, dayTs + 800);
            eventsCreated++;
          }

          // Flow 2: Payee Management → Transfer
          if (Math.random() < 0.15) {
            await trackEvent("free.payees.view", customer.id, tenantId, { ...lMeta }, dayTs + 1000);
            eventsCreated++;
            if (Math.random() < 0.3) {
              await trackEvent("free.payees.add_success", customer.id, tenantId, { ...lMeta }, dayTs + 1100);
              eventsCreated++;
            }
            if (Math.random() < 0.2) {
               // Skipping free.payees.search
            }
            if (Math.random() < 0.25) {
              await trackEvent("free.payment.success", customer.id, tenantId, { ...lMeta }, dayTs + 1150);
              eventsCreated++;
            }
          }

          if (kycState === "NOT_STARTED" && day > 2 && Math.random() < 0.25) {
            kycState = "PENDING";
            await prisma.customer.update({ where: { id: customer.id }, data: { kycStatus: "PENDING" } });
            await trackEvent("free.loan.kyc_started", customer.id, tenantId, { ...lMeta }, dayTs + 200);
            eventsCreated++;
          }
          if (kycState === "PENDING" && Math.random() < persona.kycCompletionRate * 0.3) {
            if (Math.random() < 0.85) {
              kycState = "VERIFIED";
              await prisma.customer.update({
                where: { id: customer.id },
                data: { kycStatus: "VERIFIED", kycCompletedAt: new Date((dayTs + 500) * 1000) }
              });
              await trackEvent("free.loan.kyc_completed", customer.id, tenantId, { ...lMeta }, dayTs + 500);
              compliantUsers++;
            } else {
              kycState = "REJECTED";
              await prisma.customer.update({ where: { id: customer.id }, data: { kycStatus: "REJECTED" } });
              await trackEvent("free.loan.kyc_failed", customer.id, tenantId, { reason: pick(["Document Mismatch", "Expired ID", "Blurry Photo", "Name Mismatch"]), ...lMeta }, dayTs + 500);
            }
            eventsCreated++;
          }

          // ── Spending Events ───────────────────────────────
          if (Math.random() < persona.spendingRate && currentBalance > 1000) {
            const spendAmount = Math.floor(gaussianRandom(persona.averageSpend, persona.averageSpend * 0.4));
            const clampedAmount = Math.min(spendAmount, currentBalance * 0.3); // Don't spend more than 30% of balance
            if (clampedAmount >= 100) {
              const category = pick(SPEND_CATEGORIES);
              const txChannel = weightedPick(CHANNELS, CHANNEL_WEIGHTS);
              const success = Math.random() > persona.failureRate;

              await prisma.transaction.create({
                data: {
                  transactionType: "PAYMENT",
                  senderAccNo: accNo, receiverAccNo: "MERCHANT-ID",
                  amount: clampedAmount,
                  status: success ? "SUCCESS" : "FAILED",
                  category, channel: txChannel,
                  description: success ? `${category} purchase` : `Failed: ${pick(["Network Error", "Card Declined", "Timeout", "Server Error"])}`,
                  timestamp: new Date((dayTs + 1200 + Math.floor(Math.random() * 3600)) * 1000),
                }
              });
              transactionsCreated++;

              if (success) {
                currentBalance -= clampedAmount;
                await prisma.account.update({ where: { accNo }, data: { balance: currentBalance } });
                await trackEvent("free.payment.success", customer.id, tenantId, { amount: clampedAmount, category, channel: txChannel, ...lMeta }, dayTs + 1205);
              } else {
                await trackEvent("free.payment.failed", customer.id, tenantId, { amount: clampedAmount, reason: "Transaction Error", ...lMeta }, dayTs + 1205);
              }
              eventsCreated++;
            }

            // ── Second transaction (some users do multiple per day)
            if (Math.random() < 0.3 && currentBalance > 2000) {
              const amount2 = Math.floor(gaussianRandom(persona.averageSpend * 0.5, persona.averageSpend * 0.3));
              const clamped2 = Math.min(amount2, currentBalance * 0.15);
              if (clamped2 >= 100) {
                const cat2 = pick(SPEND_CATEGORIES);
                await prisma.transaction.create({
                  data: {
                    transactionType: "PAYMENT",
                    senderAccNo: accNo, receiverAccNo: "MERCHANT-ID",
                    amount: clamped2, status: "SUCCESS", category: cat2,
                    channel: pick(CHANNELS),
                    timestamp: new Date((dayTs + 5000 + Math.floor(Math.random() * 7200)) * 1000),
                  }
                });
                currentBalance -= clamped2;
                await prisma.account.update({ where: { accNo }, data: { balance: currentBalance } });
                transactionsCreated++;
                await trackEvent("free.payment.success", customer.id, tenantId, { amount: clamped2, category: cat2, channel: pick(CHANNELS), ...lMeta }, dayTs + 5005);
                eventsCreated++;
              }
            }
          }

          // ── Strict Pro Taxonomy Simulation ─────────────────────────
          const userPlan = persona.isEnterprise ? "enterprise" : "free";

          if (userPlan === "enterprise") {
            await trackEvent("pro.features.view", customer.id, tenantId, { ...lMeta, tier: "enterprise" }, dayTs + 1300);
            eventsCreated++;

            // Simulate a realistic enterprise user session that touches multiple pro modules.
            const proTimelineBase = dayTs + 1340;

            // Crypto suite
            if (Math.random() < 0.22) {
              await trackEvent("pro.crypto_price_feeds.view", customer.id, tenantId, { source: pick(["live", "cache"]), ...lMeta, tier: "enterprise" }, proTimelineBase + 10);
              eventsCreated++;
            }
            if (Math.random() < 0.14) {
              await trackEvent("pro.crypto_portfolio.view", customer.id, tenantId, { ...lMeta, tier: "enterprise" }, proTimelineBase + 20);
              eventsCreated++;
            }
            if (Math.random() < 0.11) {
              await trackEvent("pro.crypto_trade_execution.success", customer.id, tenantId, { amount: Math.floor(500 + Math.random() * 4500), symbol: pick(["BTC", "ETH", "SOL", "XRP"]), ...lMeta, tier: "enterprise" }, proTimelineBase + 30);
              eventsCreated++;
              if (Math.random() < 0.09) {
                await trackEvent("pro.crypto_trade_execution.failed", customer.id, tenantId, { reason: pick(["Insufficient Funds", "Price Slippage", "Exchange Timeout"]), ...lMeta, tier: "enterprise" }, proTimelineBase + 35);
                eventsCreated++;
              }
            }

            // Wealth suite
            if (Math.random() < 0.16) {
              await trackEvent("pro.wealth_insights.view", customer.id, tenantId, { ...lMeta, tier: "enterprise" }, proTimelineBase + 45);
              eventsCreated++;
            }
            if (Math.random() < 0.08) {
              await trackEvent("pro.wealth_rebalance.success", customer.id, tenantId, { ...lMeta, tier: "enterprise" }, proTimelineBase + 55);
              eventsCreated++;
              if (Math.random() < 0.06) {
                await trackEvent("pro.wealth_rebalance.failed", customer.id, tenantId, { reason: pick(["Allocation Constraint", "Market Halt"]), ...lMeta, tier: "enterprise" }, proTimelineBase + 58);
                eventsCreated++;
              }
            }

            // Payroll suite
            if (Math.random() < 0.13) {
              await trackEvent("pro.payroll_payees.view", customer.id, tenantId, { ...lMeta, tier: "enterprise" }, proTimelineBase + 70);
              eventsCreated++;
            }
            if (Math.random() < 0.1) {
              const payrollSearchSuccess = Math.random() > 0.12;
              await trackEvent(payrollSearchSuccess ? "pro.payroll_search.success" : "pro.payroll_search.failed", customer.id, tenantId, { queryLength: Math.floor(3 + Math.random() * 7), ...lMeta, tier: "enterprise" }, proTimelineBase + 78);
              eventsCreated++;
            }
            if (Math.random() < 0.07) {
              const payrollBatchSuccess = Math.random() > 0.1;
              await trackEvent(payrollBatchSuccess ? "pro.payroll_batch.success" : "pro.payroll_batch.failed", customer.id, tenantId, { employees: Math.floor(10 + Math.random() * 190), ...lMeta, tier: "enterprise" }, proTimelineBase + 86);
              eventsCreated++;
            }

            // AI insights suite
            if (Math.random() < 0.15) {
              await trackEvent("pro.finance_library_stats.view", customer.id, tenantId, { ...lMeta, tier: "enterprise" }, proTimelineBase + 96);
              eventsCreated++;
            }
            if (Math.random() < 0.09) {
              await trackEvent("pro.finance_library_book.access", customer.id, tenantId, { title: pick(["The Intelligent Investor", "The Psychology of Money", "Rich Dad Poor Dad", "A Random Walk Down Wall Street"]), ...lMeta, tier: "enterprise" }, proTimelineBase + 104);
              eventsCreated++;
            }
          }

          // ── Cash/Card Withdrawal (digital channels only for cleaner distribution) ────────────────
          if (Math.random() < 0.08 && currentBalance > 5000) {
            const withdrawalAmounts = [500, 1000, 2000, 5000, 10000];
            const withdrawalAmount = pick(withdrawalAmounts.filter(a => a < currentBalance * 0.3));
            if (withdrawalAmount) {
              const withdrawalChannel = Math.random() < 0.6 ? "MOBILE" : "WEB";
              await prisma.transaction.create({
                data: {
                  transactionType: "WITHDRAWAL",
                  senderAccNo: accNo, receiverAccNo: "EXTERNAL-BANK",
                  amount: withdrawalAmount, status: "SUCCESS",
                  category: "Cash Withdrawal", channel: withdrawalChannel,
                  timestamp: new Date((dayTs + 8000) * 1000),
                }
              });
              currentBalance -= withdrawalAmount;
              await prisma.account.update({ where: { accNo }, data: { balance: currentBalance } });
              transactionsCreated++;
            }
          }

          // ── Loan Application ──────────────────────────────
          if (!hasAppliedLoan && kycState === "VERIFIED" && day > 5 && Math.random() < persona.loanInterest * 0.15) {
            const loanType = pick(LOAN_TYPES);
            const loanAmounts: Record<string, [number, number]> = {
              HOME: [500000, 5000000],
              AUTO: [200000, 1500000],
              PERSONAL: [50000, 500000],
              STUDENT: [100000, 1000000],
            };
            const [minL, maxL] = loanAmounts[loanType as string];
            const principalAmount = Math.floor(minL + Math.random() * (maxL - minL));
            const term = pick([12, 24, 36, 48, 60]);
            const interestRate = 7 + Math.random() * 7;

            const kycComplete = Math.random() < persona.kycCompletionRate;

            // Track full loan journey flow
            await trackEvent("lending.loans.viewed", customer.id, tenantId, { ...lMeta }, dayTs + 2800);
            eventsCreated++;

            await prisma.loanApplication.create({
              data: {
                customerId: customer.id,
                loanType,
                principalAmount,
                term,
                interestRate: parseFloat(interestRate.toFixed(2)),
                status: kycComplete ? "PENDING" : "KYC_PENDING",
                kycData: kycComplete ? { pan: customer.pan, aadhaar: `${Math.floor(100000000000 + Math.random() * 900000000000)}`, income: salary.toString(), employment: pick(["Salaried", "Self-Employed", "Business", "Freelancer"]) } : {},
                kycStep: kycComplete ? 3 : Math.floor(Math.random() * 2) + 1,
              },
            });
            hasAppliedLoan = true;
            applicationsCreated++;

            await trackEvent("lending.loan.applied", customer.id, tenantId, { loanType, amount: principalAmount, term, ...lMeta }, dayTs + 3000);
            if (kycComplete) {
              await trackEvent("lending.loan.kyc_completed", customer.id, tenantId, { context: "loan", ...lMeta }, dayTs + 3500);
            } else {
              await trackEvent("lending.loan.kyc_abandoned", customer.id, tenantId, { step: 1, context: "loan", ...lMeta }, dayTs + 3500);
            }
            eventsCreated += 2;
          }

          // ── Pro Feature Exploration & Conversion ──────────
          if (!isPro && Math.random() < 0.12) {
            const featureId = pick(PRO_FEATURES);
            await trackEvent("pro.features.view", customer.id, tenantId, { featureId, ...lMeta }, dayTs + 4000);
            eventsCreated++;

            // Whale users (high balance) are 5x more likely to convert
            const isWhale = currentBalance > 100000;
            const conversionChance = persona.proConversionChance * (isWhale ? 5 : 1);

            if (currentBalance > 5000 && Math.random() < conversionChance) {
              const expiry = new Date((dayTs + 86400 * 30) * 1000);
              try {
                await prisma.userLicense.create({
                  data: { customerId: customer.id, featureId, amount: 2000, expiryDate: expiry }
                });
                await prisma.transaction.create({
                  data: {
                    transactionType: "PRO_LICENSE_FEE",
                    senderAccNo: accNo, receiverAccNo: "NEXABANK-SYSTEM",
                    amount: 2000, status: "SUCCESS",
                    category: "Subscription", channel: "WEB",
                    timestamp: new Date((dayTs + 4500) * 1000),
                  }
                });
                currentBalance -= 2000;
                await prisma.account.update({ where: { accNo }, data: { balance: currentBalance } });
                await trackEvent("pro.features.unlock_success", customer.id, tenantId, { featureId, ...lMeta }, dayTs + 4505);
                isPro = true;
                unlockedFeature = featureId;
                transactionsCreated++;
                eventsCreated++;
              } catch (e) {
                // License already exists — skip
              }
            } else {
              await trackEvent("pro.features.unlock_failed", customer.id, tenantId, {
                featureId,
                reason: currentBalance <= 5000 ? "insufficient_funds" : "not_ready_to_upgrade",
                ...lMeta,
              }, dayTs + 4505);
              eventsCreated++;
            }
          }

          // ── Pro Feature Usage (already pro users) ─────────
          // Generate granular events per feature type for analytics tracking
          if (isPro && Math.random() < 0.5) {
            // Log-normal response time: Box-Muller transform, median ~55ms, long tail to ~300ms
            const u1 = Math.random() || 1e-10;
            const u2 = Math.random();
            const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
            const responseTime = Math.max(15, Math.min(300, Math.round(Math.exp(4.0 + z * 0.7))));
            const isError = Math.random() < 0.03; // 3% error rate

            if (unlockedFeature === "ai_insight_download") {
              // Finance Library — book access events
              const bookTitles = ["The Intelligent Investor", "Rich Dad Poor Dad", "The Psychology of Money", "A Random Walk Down Wall Street", "Common Stocks and Uncommon Profits", "The Little Book of Common Sense Investing"];
              const bookTitle = pick(bookTitles);
              await trackEvent("pro.finance-library.book_access", customer.id, tenantId, {
                feature: "ai-insights", title: bookTitle, status: isError ? "error" : "success",
                response_time_ms: responseTime, error: isError ? "timeout" : undefined, ...lMeta
              }, dayTs + 6000, 'enterprise');
              await trackEvent("pro.finance-library.stats_view", customer.id, tenantId, {
                feature: "ai-insights", books_tracked: Math.floor(1 + Math.random() * 5),
                status: "success", response_time_ms: responseTime, ...lMeta
              }, dayTs + 6100, 'enterprise');
              eventsCreated += 2;

            } else if (unlockedFeature === "pro-feature?id=crypto-trading") {
              // Crypto Trading — price views + trades
              const assets = ["BTC", "ETH", "SOL", "XRP", "ADA"];
              const asset = pick(assets);
              const tradeType = pick(["BUY", "SELL"]);
              await trackEvent("pro.crypto-trading.prices_view", customer.id, tenantId, {
                feature: "crypto-trading", source: pick(["live", "cache"]),
                status: isError ? "error" : "success", response_time_ms: responseTime,
                assets_count: 5, ...lMeta
              }, dayTs + 6000, 'enterprise');
              if (Math.random() < 0.4) {
                const tradeAmount = parseFloat((0.001 + Math.random() * 0.5).toFixed(4));
                await trackEvent("pro.crypto-trading.trade_execute", customer.id, tenantId, {
                  feature: "crypto-trading", asset, amount: tradeAmount, type: tradeType,
                  status: isError ? "error" : "success", response_time_ms: responseTime,
                  error: isError ? "insufficient_funds" : undefined, ...lMeta
                }, dayTs + 6200, 'enterprise');
                eventsCreated++;
              }
              await trackEvent("pro.crypto-trading.portfolio_view", customer.id, tenantId, {
                feature: "crypto-trading", holdings_count: Math.floor(Math.random() * 4),
                status: "success", response_time_ms: responseTime, ...lMeta
              }, dayTs + 6300, 'enterprise');
              eventsCreated += 2;

            } else if (unlockedFeature === "wealth_rebalance") {
              // Wealth Management — insights + rebalance
              await trackEvent("pro.wealth-management.insights_view", customer.id, tenantId, {
                feature: "wealth-management-pro", status: isError ? "error" : "success",
                response_time_ms: responseTime, accounts_count: Math.floor(1 + Math.random() * 3),
                transactions_analyzed: Math.floor(10 + Math.random() * 200),
                net_worth: Math.floor(50000 + Math.random() * 500000),
                error: isError ? "db_timeout" : undefined, ...lMeta
              }, dayTs + 6000, 'enterprise');
              if (Math.random() < 0.15) {
                await trackEvent("pro.wealth-management.rebalance", customer.id, tenantId, {
                  feature: "wealth-management-pro", status: "success",
                  response_time_ms: Math.floor(100 + Math.random() * 1000),
                  totalValue: Math.floor(100000 + Math.random() * 500000), ...lMeta
                }, dayTs + 6500, 'enterprise');
                eventsCreated++;
              }
              eventsCreated++;

            } else if (unlockedFeature === "pro-feature?id=bulk-payroll-processing") {
              // Payroll Pro — payee views + batch processing
              await trackEvent("pro.payroll-pro.payees_view", customer.id, tenantId, {
                feature: "bulk-payroll-processing", payees_count: Math.floor(2 + Math.random() * 15),
                status: "success", response_time_ms: responseTime, ...lMeta
              }, dayTs + 6000, 'enterprise');
              if (Math.random() < 0.3) {
                const payeeCount = Math.floor(2 + Math.random() * 10);
                const amtPerPayee = Math.floor(1000 + Math.random() * 9000);
                await trackEvent("pro.payroll-pro.batch_process", customer.id, tenantId, {
                  feature: "bulk-payroll-processing",
                  payees_count: payeeCount,
                  amount_per_payee: amtPerPayee,
                  total_amount: payeeCount * amtPerPayee,
                  status: isError ? "error" : "success",
                  response_time_ms: Math.floor(200 + Math.random() * 2000),
                  error: isError ? "insufficient_funds" : undefined, ...lMeta
                }, dayTs + 6500, 'enterprise');
                eventsCreated++;
              }
              eventsCreated++;
            }

            // Pro dashboard view each time
            await trackEvent("pro.dashboard.view", customer.id, tenantId, { day, featureId: unlockedFeature, ...lMeta }, dayTs + 6800, 'enterprise');
            eventsCreated++;
          }

          // ── Profile View (occasional) ─────────────────────
          if (Math.random() < 0.08) {
            await trackEvent("core.profile.viewed", customer.id, tenantId, { ...lMeta }, dayTs + 7000);
            eventsCreated++;
          }
          // Occasional transactions page visit
          if (Math.random() < 0.12) {
            await trackEvent("payments.history.viewed", customer.id, tenantId, { ...lMeta }, dayTs + 7200);
            eventsCreated++;
          }
        }

        // ─── 8. REAL-TIME PULSE (LIVE METRICS) ─────────────
        // Ensure this persona reflects as "Real-Time" by generating a live ping NOW
        // 60% of simulated users have real-time activity when simulation executes
        if (Math.random() < 0.6) {
           lMeta = { ...lMeta, session_id: `sess_sim_${seed}_live` };
           const nowTs = Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 240); // Within last 4 minutes
           await trackEvent("free.dashboard.view", customer.id, tenantId, { channel: persona.preferredChannel, ...lMeta, live_pulse: true }, nowTs);
           eventsCreated++;
           
           if (persona.isEnterprise && Math.random() < 0.3) {
               await trackEvent("pro.crypto_trade_execution.success", customer.id, tenantId, { amount: Math.floor(100+Math.random()*900), symbol: "BTC", ...lMeta, live_pulse: true }, nowTs + 15);
               eventsCreated++;
           }
        }

        // Update final balance
        await prisma.account.update({ where: { accNo }, data: { balance: currentBalance } });
      }

      // ─── 8. Generate Payee Relationships ────────────────
      // Link some simulated users as payees of each other
      let payeesCreated = 0;
      if (createdUserIds.length >= 3) {
        const shuffled = [...createdUserIds].sort(() => Math.random() - 0.5);
        const pairCount = Math.min(Math.floor(createdUserIds.length * 0.4), 30);

        for (let p = 0; p < pairCount && p + 1 < shuffled.length; p++) {
          try {
            const payerCustomer = await prisma.customer.findUnique({ where: { id: shuffled[p] } });
            const payeeCustomer = await prisma.customer.findUnique({ where: { id: shuffled[p + 1] } });
            if (!payerCustomer || !payeeCustomer) continue;

            const payerAccount = await prisma.account.findFirst({ where: { customerId: payerCustomer.id } });
            const payeeAccount = await prisma.account.findFirst({ where: { customerId: payeeCustomer.id } });
            if (!payerAccount || !payeeAccount) continue;

            const existing = await prisma.payee.findFirst({
              where: { payerCustomerId: payerCustomer.id, payeeCustomerId: payeeCustomer.id }
            });
            if (existing) continue;

            await prisma.payee.create({
              data: {
                name: payeeCustomer.name,
                payeeAccNo: payeeAccount.accNo,
                payeeifsc: payeeAccount.ifsc,
                payeeCustomerId: payeeCustomer.id,
                payerCustomerId: payerCustomer.id,
                payeeType: "INDIVIDUAL",
              }
            });
            payeesCreated++;

            // Some payees also do a transfer
            if (Math.random() < 0.4 && payerAccount.balance > 5000) {
              const transferAmount = Math.floor(1000 + Math.random() * 5000);
              await prisma.transaction.create({
                data: {
                  transactionType: "TRANSFER",
                  senderAccNo: payerAccount.accNo,
                  receiverAccNo: payeeAccount.accNo,
                  amount: transferAmount,
                  status: "SUCCESS",
                  category: "PAYEE_TRANSFER",
                  channel: "WEB",
                  description: `Transfer to ${payeeCustomer.name}`,
                }
              });
              await prisma.account.update({ where: { accNo: payerAccount.accNo }, data: { balance: { decrement: transferAmount } } });
              await prisma.account.update({ where: { accNo: payeeAccount.accNo }, data: { balance: { increment: transferAmount } } });
              transactionsCreated++;
            }
          } catch (e) {
            // Skip on error
          }
        }
      }

      const runMs = Date.now() - startedAt;
      const throughput = runMs > 0 ? Number(((eventsCreated / runMs) * 1000).toFixed(2)) : 0;

      res.status(200).json({
        message: "Stochastic worldwide simulation complete",
        requestedUsers: userCount,
        requestedTenant: rawTenant || "bank_a",
        resolvedTenant: tenantId,
        usersCreated,
        totalUsers: await prisma.customer.count({ where: { tenantId } }),
        transactionsCreated,
        eventsCreated,
        applicationsCreated,
        loansApplied: applicationsCreated,
        compliantUsers,
        kycCompleted: compliantUsers,
        analyticsOptInUsers,
        fullyCompleted: analyticsOptInUsers,
        skippedUsers,
        payeesCreated,
        simulatedDays: simDays,
        runMs,
        throughputEventsPerSec: throughput,
        processingSummary: {
          users: { requested: userCount, created: usersCreated, skipped: skippedUsers },
          funnel: {
            compliantUsers,
            analyticsOptInUsers,
            applicationsCreated,
          },
          generated: {
            eventsCreated,
            transactionsCreated,
            payeesCreated,
          },
        },
        continentDistribution: Object.keys(CONTINENT_WEIGHTS).reduce((acc, c) => {
          acc[c] = `${CONTINENT_WEIGHTS[c]}%`;
          return acc;
        }, {} as Record<string, string>),
      });
    } catch (err) {
      console.error("Simulation error:", err);
      res.status(500).json({ error: "Simulation failed", details: err instanceof Error ? err.message : "Unknown" });
    }
  }
);

export default router;
