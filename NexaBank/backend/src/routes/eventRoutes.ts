import express, { Request, Response } from "express";
import { prisma } from "../prisma";
import { isLoggedIn, isAdmin } from "../middleware/IsLoggedIn";
import { trackEvent, trackEventsBatch, BatchedEvent, forwarderStats } from "../middleware/eventTracker";
import {
  BehaviorOverride,
  describeOverride,
  overrideApplies,
  parseBehaviorOverride,
  pickWeighted,
  resolveBehavior,
} from "../helper/simulationBehavior";
import {
  buildCatalog,
  canonicalOf,
  createJourneyRuntime,
  JourneyRuntime,
} from "../helper/journeyModel";
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

// ─── GET /health/forwarder ─────────────────────────────────────
// P0-10. Trust Gate cannot tell "the KPI dropped" from "the forwarder broke" unless forwarding
// outcomes are counted. pro_revenue's tracking_disabled fingerprint reads the 403 rate here.
router.get("/health/forwarder", (_req: Request, res: Response): void => {
  const total = forwarderStats.attempted || 1;
  res.json({
    ...forwarderStats,
    failure_rate: Number((forwarderStats.failed / total).toFixed(4)),
    forbidden_count: forwarderStats.byStatus["403"] || 0,
  });
});

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

/** The newly launched product. Its whole point is that it has almost no history. */
const NEW_CARD_PRODUCT = "Student Travel Credit Card";
const NEW_PRODUCT_DAYS = 10;

/** Trailing days over which the planted deposit outflow runs. */
const DEPOSIT_FLIGHT_DAYS = 7;
/**
 * The region the outflow is planted in. Must match the region whose competitor deposit rate
 * seedReferenceData.ts steps up, or the multi-source scenario loses its external driver and
 * Causal correctly degrades to attribution -- a silent loss of the thing the scenario exists to
 * demonstrate. Regions are CONTINENTS; see that file's header.
 */
const DEPOSIT_FLIGHT_REGION = "Europe";

// ─── Source A/B enrichment ────────────────────────────────────────────────
// Merchant category codes, so spend has a real classification rather than a free-text label.
const MCC_TABLE: Array<{ mcc: string; merchant: string; category: string }> = [
  { mcc: "5411", merchant: "FreshMart Grocery", category: "GROCERIES" },
  { mcc: "5812", merchant: "The Copper Kettle", category: "DINING" },
  { mcc: "5541", merchant: "Northgate Fuel", category: "FUEL" },
  { mcc: "4900", merchant: "Metro Utilities", category: "UTILITIES" },
  { mcc: "5732", merchant: "PixelWorks Electronics", category: "ELECTRONICS" },
  { mcc: "4111", merchant: "CityTransit", category: "TRANSPORT" },
  { mcc: "5912", merchant: "Wellspring Pharmacy", category: "HEALTHCARE" },
  { mcc: "7832", merchant: "Odeon Cinemas", category: "ENTERTAINMENT" },
  { mcc: "5651", merchant: "Rowan & Fields", category: "RETAIL" },
  { mcc: "4722", merchant: "Skyline Travel", category: "TRAVEL" },
];

function referenceNumber(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < 12; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

type CrmProfile = {
  ageBracket: "UNDER_25" | "AGE_25_34" | "AGE_35_49" | "AGE_50_64" | "AGE_65_PLUS";
  incomeBracket: "UNDER_30K" | "INC_30K_60K" | "INC_60K_100K" | "INC_100K_200K" | "INC_200K_PLUS";
  employmentStatus: "SALARIED" | "SELF_EMPLOYED" | "STUDENT" | "RETIRED" | "UNEMPLOYED";
  riskSegment: "LOW" | "MEDIUM" | "HIGH";
  lifetimeValue: number;
};

/**
 * Correlated demographics. Drawing each field independently would make every segment
 * statistically identical, and Localize would rank cells over noise -- ranked, confident and
 * meaningless, which is the worst failure this system has.
 */
function drawCrmProfile(persona: UserPersona): CrmProfile {
  const roll = Math.random();
  if (persona.userType === "business_user") {
    return {
      ageBracket: roll < 0.5 ? "AGE_35_49" : "AGE_50_64",
      incomeBracket: roll < 0.35 ? "INC_200K_PLUS" : "INC_100K_200K",
      employmentStatus: "SELF_EMPLOYED",
      riskSegment: roll < 0.25 ? "HIGH" : "MEDIUM",
      lifetimeValue: Math.round(8000 + Math.random() * 22000),
    };
  }
  if (persona.userType === "power_user") {
    return {
      ageBracket: roll < 0.6 ? "AGE_25_34" : "AGE_35_49",
      incomeBracket: roll < 0.5 ? "INC_100K_200K" : "INC_60K_100K",
      employmentStatus: "SALARIED",
      riskSegment: roll < 0.7 ? "LOW" : "MEDIUM",
      lifetimeValue: Math.round(5000 + Math.random() * 12000),
    };
  }
  if (persona.userType === "salary_user") {
    return {
      ageBracket: roll < 0.45 ? "AGE_25_34" : roll < 0.8 ? "AGE_35_49" : "AGE_50_64",
      incomeBracket: roll < 0.55 ? "INC_60K_100K" : "INC_30K_60K",
      employmentStatus: "SALARIED",
      riskSegment: roll < 0.75 ? "LOW" : "MEDIUM",
      lifetimeValue: Math.round(2000 + Math.random() * 6000),
    };
  }
  return {
    ageBracket: roll < 0.55 ? "UNDER_25" : "AGE_25_34",
    incomeBracket: roll < 0.6 ? "UNDER_30K" : "INC_30K_60K",
    employmentStatus: roll < 0.5 ? "STUDENT" : roll < 0.85 ? "SALARIED" : "UNEMPLOYED",
    riskSegment: roll < 0.4 ? "MEDIUM" : roll < 0.85 ? "LOW" : "HIGH",
    lifetimeValue: Math.round(200 + Math.random() * 2200),
  };
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

/**
 * Contract dimensions this generator invents rather than measures.
 *
 * Declared on every event as `metadata._simulated`, which eventTracker unions into the marker it
 * forwards. Two things downstream depend on it: `contracts.sliceable_dimensions` drops these keys
 * so Localize cannot rank cells over a dice roll (CLAUDE.md rule 13), and the dashboard labels any
 * chart built on them. `browser` and `user_type` are absent because no contract localizes on them.
 */
const SIMULATED_DIMS = ["location", "city", "continent", "device_type", "channel"] as const;

/** Reads a `_simulated` list off metadata, tolerating anything malformed. */
function asDims(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((k): k is string => typeof k === "string") : [];
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
    // Drawn from WORLD_CITIES and the persona table, not measured from a client. A session whose
    // mix an operator forced overrides this below -- that value carries intent, not noise.
    _simulated: [...SIMULATED_DIMS],
  };
}

// ─── GET /events/simulate/catalog ─────────────────────────────
// Admin only: the real route/event vocabulary an operator may target from the
// simulation console. Sourced from helper/journeyModel.ts so the picker cannot
// offer an identifier the generator can't actually produce.
router.get(
  "/events/simulate/catalog",
  isLoggedIn,
  isAdmin,
  (_req: Request, res: Response): void => {
    res.status(200).json(buildCatalog());
  }
);

// ─── POST /events/simulate ────────────────────────────────────
// Admin only: stochastic user journey simulation.
// Auth: mounted without router-level isLoggedIn (see app.ts), so the guard is
// declared here explicitly. Before this it was a client-only AdminGuard.
router.post(
  "/events/simulate",
  isLoggedIn,
  isAdmin,
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
    // Behaviour knobs from the simulate page. Null means "generate at baseline", which is
    // the distribution this route produced before knobs existed.
    const behaviorOverride: BehaviorOverride | null = parseBehaviorOverride(
      (req.body as { behavior?: unknown })?.behavior
    );
    // Journey model: enforces realistic prerequisites by default, applies the per-
    // route/event traffic & failure knobs, and (unless relaxJourney) keeps a raised
    // target's upstream funnel proportionate. Stateless w.r.t. persistence.
    //
    // Built PER USER, not per request. It carries mutable per-session state (which canonicals a
    // session has emitted), so one shared instance across concurrently generated users would let
    // them satisfy each other's prerequisites and suppress each other's back-fills.
    const newJourney = (): JourneyRuntime => createJourneyRuntime({
      targets: behaviorOverride?.targets ?? [],
      relaxJourney: behaviorOverride?.relaxJourney === true,
    });
    const count = Number.isFinite(rawCount)
      ? Math.max(1, Math.min(Math.floor(rawCount), 100))
      : 50;
    const days = Number.isFinite(rawDays)
      ? Math.max(1, Math.min(Math.floor(rawDays), 60))
      : 30;

    // ─── FAST MODE ────────────────────────────────────────────────────────
    // Slow mode writes every row to a remote Postgres first (~350ms per round trip) and only then
    // reaches the warehouse; that is what proves the real pipeline works, and it is why a large
    // run takes minutes. Fast mode skips both and writes the analytics tables directly, for
    // testing the intelligence layer on volume. Measured: 2,000 users x 45 days in ~3s, against
    // hours for the same shape through the pipeline.
    //
    // Proxied, not implemented here: NexaBank has no ClickHouse client and must not grow one
    // (docs/ARCHITECTURE.md). The ingestion service already owns writing events_raw directly on
    // its fallback path, so the direct write stays where that responsibility already lives.
    const mode = String((req.body as { mode?: unknown })?.mode || "slow").toLowerCase();
    if (mode === "fast") {
      const base = (process.env.INGESTION_API_URL || "http://localhost:8000/events")
        .replace(/\/events\/?$/, "");
      try {
        const analyticsTenant = toAnalyticsTenant(tenantId);
        const started = Date.now();
        const r = await axios.post(`${base}/events/seed/fast`, {
          tenant_id: analyticsTenant,
          users: Number.isFinite(rawCount) ? Math.max(1, Math.min(Math.floor(rawCount), 5000)) : 100,
          days: Number.isFinite(rawDays) ? Math.max(1, Math.min(Math.floor(rawDays), 365)) : 30,
          purge_first: Boolean((req.body as { purgeFirst?: unknown })?.purgeFirst),
          behavior: (req.body as { behavior?: unknown })?.behavior ?? null,
          create_accounts: Boolean((req.body as { createAccounts?: unknown })?.createAccounts),
        }, { timeout: 300000 });
        res.status(200).json({
          message: "Fast seed complete (pipeline bypassed)",
          mode: "fast",
          resolvedTenant: analyticsTenant,
          runMs: Date.now() - started,
          ...r.data,
        });
      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
        res.status(status === 409 ? 409 : 502).json({
          error: "Fast seed failed",
          detail: detail || String(err),
        });
      }
      return;
    }

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      res.status(400).json({ error: "Invalid tenant" });
      return;
    }

    try {
      const bcrypt = await import("bcryptjs");
      // Every simulated user gets the same demo password, so hash it ONCE. bcrypt at cost 10 is
      // ~100ms of CPU by design; paying that per user bought nothing but latency.
      const sharedHashedPw = await bcrypt.hash("Password@123", 10);
      const startedAt = Date.now();

      // Source C is reference data: it must already exist. Generating customers against an
      // unseeded branch table would leave every account with a null branch and silently remove
      // region from every KPI that localizes on it.
      const branches = await prisma.branch.findMany({ where: { tenantId } });
      if (!branches.length) {
        res.status(409).json({
          error: "No branches for this tenant",
          detail: "Run: npx tsx src/scripts/seedReferenceData.ts",
        });
        return;
      }
      const campaigns = await prisma.campaign.findMany({ where: { tenantId } });
      let usersCreated = 0;
      let transactionsCreated = 0;
      let eventsCreated = 0;
      let applicationsCreated = 0;
      let loansCreated = 0;
      let cardsIssued = 0;
      let notificationsCreated = 0;
      let interactionsCreated = 0;
      let compliantUsers = 0;
      let analyticsOptInUsers = 0;
      let skippedUsers = 0;
      const createdUserIds: string[] = [];
      // What the payee pass below needs. It used to re-read every one of these from Postgres --
      // five sequential remote round trips per pair, for rows this loop created seconds earlier.
      const createdUsers: Array<{ id: string; name: string; accNo: string; ifsc: string;
                                  balance: number }> = [];

      const simDays = Math.min(days, 60);
      const userCount = Math.min(count, 100);

      // A run generates activity for customers the bank ALREADY HAS. Minting a population is a
      // separate, deliberate choice: doing it every run gave each run its own disjoint cohort, so
      // account openings spiked on every run and a planted rate movement was diluted by the new
      // arrivals instead of being measured against a stable base.
      const createAccounts = Boolean((req.body as { createAccounts?: unknown })?.createAccounts);
      // Fetched whole, in one query: re-reading each customer inside the loop would add a remote
      // round trip per user, which is the cost this path is already dominated by.
      const existing = createAccounts ? [] : await prisma.customer.findMany({
        where: { tenantId, role: "USER", account: { some: {} } },
        include: { account: { select: { accNo: true, ifsc: true }, take: 1,
                              orderBy: { accNo: "asc" } } },
        orderBy: { id: "asc" },
        take: userCount,
      });
      if (!createAccounts && existing.length === 0) {
        res.status(409).json({
          error: "No existing customers to simulate",
          detail: "Slow mode generates activity for the bank's own customers, and this tenant " +
                  "has none with an account. Re-run with createAccounts: true to create a " +
                  "population first.",
        });
        return;
      }
      const simUserCount = createAccounts ? userCount : Math.min(userCount, existing.length);

      const runUser = async (i: number): Promise<void> => {
        const journey: JourneyRuntime = newJourney();
        // ─── 1. Generate WORLDWIDE User Identity ────────────
        const location = pickWorldwideCity();
        const firstName = pick(FIRST_NAMES_POOL[location.continent] || FIRST_NAMES_POOL["Asia"]);
        const lastName = pick(LAST_NAMES_POOL[location.continent] || LAST_NAMES_POOL["Asia"]);
        const name = `${firstName} ${lastName}`;
        const seed = Date.now() + i + Math.floor(Math.random() * 10000);
        const email = `${firstName.toLowerCase()}.${seed}@nexabank.demo`;
        const phone = `9${Math.floor(100000000 + Math.random() * 900000000)}`;
        const pan = `${String.fromCharCode(65 + Math.floor(Math.random() * 26))}${String.fromCharCode(65 + Math.floor(Math.random() * 26))}${String.fromCharCode(65 + Math.floor(Math.random() * 26))}${String.fromCharCode(65 + Math.floor(Math.random() * 26))}${String.fromCharCode(65 + Math.floor(Math.random() * 26))}${Math.floor(1000 + Math.random() * 9000)}${String.fromCharCode(65 + Math.floor(Math.random() * 26))}`;
        const hashedPw = sharedHashedPw;

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
        const homeBranch = pick(branches);
        const crm = drawCrmProfile(persona);
        // The bank's own posted rate. Held flat while the competitor's moves, so the gap -- not
        // the level -- is what a deposit outflow tracks.
        const savingsRate = 3.5;
        let customer;
        if (!createAccounts) {
          // The identity, branch and account are the bank's own; nothing here is written back.
          customer = existing[i];
          if ((customer.settingConfig as Record<string, unknown>)?.analyticsOptIn === true) {
            analyticsOptInUsers++;
          }
        } else {
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
              // Source B attributes. Correlated on purpose -- a student is rarely in the top
              // income bracket -- so segment analysis finds structure rather than noise.
              ageBracket: crm.ageBracket,
              incomeBracket: crm.incomeBracket,
              employmentStatus: crm.employmentStatus,
              riskSegment: crm.riskSegment,
              lifetimeValue: crm.lifetimeValue,
              branchCode: homeBranch.code,
            },
          });

          if (hasAnalyticsOptIn) {
            analyticsOptInUsers++;
          }
        } catch (e) {
          // Duplicate phone/email/pan — skip
          skippedUsers++;
          return;
        }
        usersCreated++;
        }
        createdUserIds.push(customer.id);

        // ── Journey-aware emit helpers (scoped to this simulated customer) ──
        // Every generator event goes through simEmit so the journey model sees it,
        // can back-fill a missing prerequisite, and can apply the traffic knob.
        const DIM_KEYS = [
          "session_id", "device_type", "device", "location", "country",
          "continent", "city", "channel", "user_type", "browser", "tier",
          // A back-filled prerequisite is as fabricated as the event that triggered it.
          "_simulated",
        ];
        const dimMeta = (meta: Record<string, any>): Record<string, any> => {
          const out: Record<string, any> = {};
          for (const k of DIM_KEYS) if (meta[k] !== undefined) out[k] = meta[k];
          return out;
        };
        // One user's events, flushed in a single insert at the end of their iteration.
        const pendingEvents: BatchedEvent[] = [];

        const simEmit = async (
          raw: string,
          prob: number,
          meta: Record<string, any>,
          ts: number,
          opts: {
            inScope?: boolean;
            applyTraffic?: boolean;
            tier?: "free" | "pro" | "enterprise";
            seed?: string[];
          } = {}
        ): Promise<boolean> => {
          const inScope = opts.inScope ?? true;
          const applyTraffic = opts.applyTraffic ?? true;
          const canonical = canonicalOf(raw);
          journey.beginSession(String(meta.session_id ?? ""), opts.seed);

          const p = inScope && applyTraffic
            ? journey.effectiveProbability(canonical, prob, inScope)
            : prob;
          if (Math.random() >= Math.max(0, Math.min(1, p))) return false;

          // response_time_ms here is a log-normal draw (Box-Muller, below), never a measurement.
          // Declaring it is what lets /metrics/kpi report the Avg Response Time card as simulated;
          // presence of the key alone reads as "measured" and defeated the badge before this.
          const emitMeta = meta.response_time_ms === undefined
            ? meta
            : { ...meta, _simulated: [...asDims(meta._simulated), "response_time_ms"] };

          // Buffered, not written. Each event was one ~350ms round trip to a remote Postgres,
          // and a run emits dozens per user; `flushEvents` turns them into one createMany. The
          // journey state below is still updated in emit order, so ordering is unchanged.
          for (const bf of journey.planBackfill(canonical)) {
            pendingEvents.push({ eventName: bf, customerId: customer.id, tenantId,
                                 metadata: dimMeta(emitMeta), timestampOverride: ts - 1 });
            eventsCreated++;
          }
          pendingEvents.push({ eventName: raw, customerId: customer.id, tenantId,
                               metadata: emitMeta, timestampOverride: ts, tier: opts.tier });
          eventsCreated++;
          journey.record(canonical);
          return true;
        };
        // Roll a failure outcome, honouring the per-target failure knob.
        const simFail = (
          failureCanonical: string,
          baseFailProb: number,
          inScope: boolean
        ): boolean =>
          Math.random() < journey.failureProbability(failureCanonical, baseFailProb, inScope);
        // Traffic-knob-adjusted gate for a block of events (not a single emit); the
        // emits inside pass { applyTraffic: false } so the knob is applied once.
        const simGate = (canonical: string, baseProb: number, inScope: boolean): boolean =>
          Math.random() < journey.effectiveProbability(canonical, baseProb, inScope);

        // ─── 5. Savings account: the customer's own, or a new one ──────────
        const reusedAccount = createAccounts ? null : existing[i].account[0];
        const accNo = reusedAccount ? reusedAccount.accNo : `NEXA${String(seed).slice(-8)}`;
        let account: { ifsc: string };
        if (reusedAccount) {
          account = { ifsc: reusedAccount.ifsc };
        } else {
          try {
            account = await prisma.account.create({
              data: {
                accNo, customerId: customer.id,
                ifsc: `${tenant.ifscPrefix}${tenant.branchCode}`,
                accountType: "SAVINGS",
                balance: 0,
                branchCode: homeBranch.code,
                interestRate: savingsRate,
                lifecycleStatus: "ACTIVE",
              },
            });
          } catch (e) {
            skippedUsers++;
            return;
          }
        }

        // Track registration with worldwide location. Targets apply to this session only
        // when the join day is inside the window AND the initial device/location match
        // the override's segment (if any).
        const regInScope = overrideApplies(behaviorOverride, {
          daysAgo: joinDaysAgo,
          deviceType: String(lMeta.device_type || ""),
          location: String(lMeta.location || ""),
        });
        // An existing customer does not register again -- emitting it would inflate acquisition
        // with people the bank already had. They simply log in.
        if (createAccounts) {
          await simEmit("free.auth.register.success", 1, { channel: persona.preferredChannel, ...lMeta }, baseTs, { inScope: regInScope });
        }
        await simEmit("free.auth.login.success", 1, { channel: persona.preferredChannel, ...lMeta }, baseTs + 60, { inScope: regInScope });
        if ((customer.settingConfig as Record<string, unknown>)?.analyticsOptIn === true) {
          await simEmit("core.analytics.opt_in", 1, { source: "simulation", ...lMeta }, baseTs + 90, { inScope: regInScope });
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

        // ─── Cards ────────────────────────────────────────
        // Every account gets a debit card. The credit product is the launch: it is issued only to
        // customers who joined inside NEW_PRODUCT_DAYS, so its history is genuinely sparse and the
        // forecast has to say so rather than project a quarter from ten days.
        const joinedDaysAgo = Math.floor((Date.now() / 1000 - baseTs) / 86400);
        const cardsToIssue: Array<{ type: "DEBIT" | "CREDIT"; product: string; limit: number | null }> = [
          { type: "DEBIT", product: "NexaBank Everyday Debit", limit: null },
        ];
        if (joinedDaysAgo <= NEW_PRODUCT_DAYS
            && (crm.employmentStatus === "STUDENT" || crm.ageBracket === "UNDER_25")
            && Math.random() < 0.7) {
          cardsToIssue.push({ type: "CREDIT", product: NEW_CARD_PRODUCT, limit: 1500 });
        } else if (crm.incomeBracket === "INC_100K_200K" || crm.incomeBracket === "INC_200K_PLUS") {
          if (Math.random() < 0.5) {
            cardsToIssue.push({ type: "CREDIT", product: "NexaBank Signature Credit", limit: 12000 });
          }
        }
        for (const spec of cardsToIssue) {
          const expYear = new Date().getUTCFullYear() + 3;
          await prisma.card.create({
            data: {
              accNo, customerId: customer.id,
              last4: String(1000 + Math.floor(Math.random() * 9000)),
              cardType: spec.type,
              network: spec.type === "CREDIT" ? pick(["VISA", "MASTERCARD", "AMEX"] as const)
                                              : pick(["VISA", "MASTERCARD", "RUPAY"] as const),
              productName: spec.product,
              expMonth: 1 + Math.floor(Math.random() * 12),
              expYear,
              cardholderName: name.toUpperCase(),
              creditLimit: spec.limit,
              availableCredit: spec.limit,
              issuedOn: new Date(baseTs * 1000),
            },
          });
          cardsIssued++;
        }

        await prisma.notification.create({
          data: {
            customerId: customer.id, type: "SYSTEM",
            message: `Welcome to NexaBank. Your ${cardsToIssue[0].product} is on its way.`,
            createdOn: new Date(baseTs * 1000),
          },
        });
        notificationsCreated++;

        // ─── Campaign funnel (source B) ───────────────────
        // Stored as a funnel, never as a rate: CPA must be re-aggregatable across segments.
        const targeted = campaigns.filter((c) =>
          c.targetSegment === "ALL" || c.targetSegment === crm.riskSegment
          || c.targetSegment === crm.employmentStatus);
        for (const campaign of targeted) {
          const sentAt = new Date(Math.max(baseTs * 1000, campaign.startDate.getTime()));
          if (sentAt > campaign.endDate || sentAt.getTime() > Date.now()) continue;
          const step = async (type: "SENT" | "OPENED" | "CLICKED" | "CONVERTED", offsetH: number) => {
            await prisma.campaignInteraction.create({
              data: { campaignId: campaign.id, customerId: customer.id, type,
                      occurredAt: new Date(sentAt.getTime() + offsetH * 3600 * 1000) },
            });
            interactionsCreated++;
          };
          await step("SENT", 0);
          if (Math.random() < 0.42) {
            await step("OPENED", 2);
            if (Math.random() < 0.35) {
              await step("CLICKED", 5);
              if (Math.random() < 0.22) await step("CONVERTED", 26);
            }
          }
        }

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
          // Clamped to the recent past: a jittered final day can land hours ahead of now, and
          // ingestion rejects a future timestamp -- which silently thinned the newest day, the
          // one inside the scored window. Trailing offsets add up to ~1h more, so leave headroom.
          const nowTs = Math.floor(Date.now() / 1000);
          const dayTs = Math.min(
            baseTs + (day * 86400) + Math.floor(Math.random() * 43200), // random hour within the day
            nowTs - 7200
          );

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
            transactionsCreated++;
          }

          // ── Daily Login Roll ──────────────────────────────
          if (Math.random() > persona.loginProbability) continue;

          // User logged in today -- each day is its own session for session-grain analytics
          lMeta = { ...lMeta, session_id: `sess_sim_${seed}_d${day}` };

          // `day` counts UP toward now (dayTs = baseTs + day*86400), so days-ago inverts it.
          const daysAgo = joinDaysAgo - day;

          // Mix overrides are applied per SESSION, not per event and not per user. The
          // kyc_completion_rate contract needs each dimension to be invariant WITHIN a
          // session; a user on mobile one day and desktop the next is realistic and legal.
          // Re-rolling per event is the FOUNDATION-2 bug and must not come back.
          const mixBehavior = resolveBehavior(behaviorOverride, {
            daysAgo,
            deviceType: String(lMeta.device_type || ""),
            location: String(lMeta.location || ""),
          });
          const forcedDevice = pickWeighted(mixBehavior.mix.deviceWeights);
          const forcedCountry = pickWeighted(mixBehavior.mix.countryWeights);
          if (forcedDevice) lMeta = { ...lMeta, device_type: forcedDevice };
          if (forcedCountry) {
            // A forced country has to bring its city and continent with it. Patching only
            // `location` left the session claiming, say, an Egyptian city and Africa while
            // reporting India -- and `continent` is a declared contract dimension, so that cell
            // was not merely generated, it was wrong. Re-resolve from the same city table the
            // unforced path draws from, so the three stay mutually consistent.
            const inCountry = WORLDWIDE_CITIES.filter((c) => c.country === forcedCountry);
            const forcedCity = inCountry.length ? pick(inCountry) : null;
            lMeta = {
              ...lMeta,
              country: forcedCountry,
              location: forcedCountry,
              // A country with no city in the table can only be described honestly by saying
              // nothing. An empty value reads as absent; a stale one reads as a measurement.
              city: forcedCity ? forcedCity.city : "",
              continent: forcedCity ? forcedCity.continent : "",
            };
          }

          // Resolve again AFTER the mix shift so a segment-scoped override matches the
          // device/location this session actually ended up with.
          const behavior = resolveBehavior(behaviorOverride, {
            daysAgo,
            deviceType: String(lMeta.device_type || ""),
            location: String(lMeta.location || ""),
          });

          // Route/event traffic & failure knobs apply only inside the trailing window AND
          // (if the override has a segment) to sessions that match it -- earlier days and
          // other cells stay at baseline so a movement has something to be measured
          // against. The journey gate itself always applies.
          const inScope = overrideApplies(behaviorOverride, {
            daysAgo,
            deviceType: String(lMeta.device_type || ""),
            location: String(lMeta.location || ""),
          });

          const forcedChannel = pickWeighted(behavior.mix.channelWeights);

          // A mix value the operator forced is PLANTED: it carries the intent the movement is
          // meant to concentrate in, which is exactly what Localize has to be allowed to recover
          // (docs/SCENARIOS.md scenario 2). Anything they did not force stays a weighted dice
          // roll and stays declared. This is the distinction the marker could not previously make.
          // Note city/continent are never operator-controlled, so they stay declared even when
          // location is forced -- and a forced country leaves them describing the original city.
          const planted = new Set<string>();
          if (forcedDevice) planted.add("device_type");
          if (forcedCountry) planted.add("location");
          if (forcedChannel) planted.add("channel");
          lMeta = { ...lMeta, _simulated: SIMULATED_DIMS.filter((k) => !planted.has(k)) };

          const channel = forcedChannel
            ? forcedChannel
            : (Math.random() < 0.6 ? persona.preferredChannel : pick(CHANNELS));
          await simEmit("free.auth.login.success", 1, { channel, ...lMeta, day }, dayTs, { inScope });

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
          await simEmit("free.dashboard.view", 0.7, { channel, ...lMeta }, dayTs + 200, { inScope });
          await simEmit("free.accounts.view", 0.4, { ...lMeta }, dayTs + 400, { inScope });
          await simEmit("free.transactions.view", 0.3, { ...lMeta }, dayTs + 800, { inScope });

          // Flow 2: Payee Management → Transfer
          if (await simEmit("free.payees.view", 0.15, { ...lMeta }, dayTs + 1000, { inScope })) {
            await simEmit("free.payees.add_success", 0.3, { ...lMeta }, dayTs + 1100, { inScope });
            // (free.payees.search is intentionally not simulated)
            await simEmit("free.payment.success", 0.25, { ...lMeta }, dayTs + 1150, { inScope });
          }

          if (kycState === "NOT_STARTED" && day > 2) {
            if (await simEmit("free.loan.kyc_started", behavior.kyc.startRate, { ...lMeta }, dayTs + 200, { inScope })) {
              kycState = "PENDING";
              await prisma.customer.update({ where: { id: customer.id }, data: { kycStatus: "PENDING" } });
            }
          }
          if (kycState === "PENDING" &&
              simGate("loan.kyc_completed.success", persona.kycCompletionRate * behavior.kyc.progressMultiplier, inScope)) {
            if (!simFail("loan.kyc.failure", 1 - behavior.kyc.successRate, inScope)) {
              kycState = "VERIFIED";
              await prisma.customer.update({
                where: { id: customer.id },
                data: { kycStatus: "VERIFIED", kycCompletedAt: new Date((dayTs + 500) * 1000) }
              });
              await simEmit("free.loan.kyc_completed", 1, { ...lMeta }, dayTs + 500, { inScope, applyTraffic: false });
              compliantUsers++;
            } else {
              kycState = "REJECTED";
              await prisma.customer.update({ where: { id: customer.id }, data: { kycStatus: "REJECTED" } });
              await simEmit("free.loan.kyc_failed", 1, { reason: pick(["Document Mismatch", "Expired ID", "Blurry Photo", "Name Mismatch"]), ...lMeta }, dayTs + 500, { inScope, applyTraffic: false });
            }
          }

          // ── Spending Events ───────────────────────────────
          if (simGate("payment.success.action", persona.spendingRate, inScope) && currentBalance > 1000) {
            const spendAmount = Math.floor(gaussianRandom(persona.averageSpend, persona.averageSpend * 0.4));
            const clampedAmount = Math.min(spendAmount, currentBalance * 0.3); // Don't spend more than 30% of balance
            if (clampedAmount >= 100) {
              const category = pick(SPEND_CATEGORIES);
              const txChannel = weightedPick(CHANNELS, CHANNEL_WEIGHTS);
              const success = !simFail("payment.failed.action", persona.failureRate, inScope);

              const mcc = pick(MCC_TABLE);
              await prisma.transaction.create({
                data: {
                  transactionType: "PAYMENT",
                  senderAccNo: accNo, receiverAccNo: "MERCHANT-ID",
                  amount: clampedAmount,
                  status: success ? "SUCCESS" : "FAILED",
                  category, channel: txChannel,
                  description: success ? `${category} purchase` : `Failed: ${pick(["Network Error", "Card Declined", "Timeout", "Server Error"])}`,
                  merchantCategoryCode: mcc.mcc,
                  merchantName: mcc.merchant,
                  referenceNumber: referenceNumber(),
                  timestamp: new Date((dayTs + 1200 + Math.floor(Math.random() * 3600)) * 1000),
                }
              });
              transactionsCreated++;

              if (success) {
                currentBalance -= clampedAmount;
                await simEmit("free.payment.success", 1, { amount: clampedAmount, category, channel: txChannel, ...lMeta }, dayTs + 1205, { inScope, applyTraffic: false });
              } else {
                await simEmit("free.payment.failed", 1, { amount: clampedAmount, reason: "Transaction Error", ...lMeta }, dayTs + 1205, { inScope, applyTraffic: false });
              }
            }

            // ── Deposit flight (the multi-factor scenario) ──────────────────────
            // European savings customers move money OUT in the recent window. The competitor
            // deposit rate in Source C stepped to 5.0% over the same months. Neither table says
            // the two are connected: the engine has to pair an internal segment with an external
            // factor, which is the whole point of a multi-source driver.
            const inRecentWindow = (Date.now() / 1000 - dayTs) <= DEPOSIT_FLIGHT_DAYS * 86400;
            if (homeBranch.region === DEPOSIT_FLIGHT_REGION && inRecentWindow
                && currentBalance > 5000 && Math.random() < 0.34) {
              const outflow = Math.round(Math.min(currentBalance * 0.45,
                                                  8000 + Math.random() * 22000));
              await prisma.transaction.create({
                data: {
                  transactionType: "WITHDRAWAL",
                  senderAccNo: accNo, receiverAccNo: "EXTERNAL-BANK",
                  amount: outflow, status: "SUCCESS",
                  category: "External Transfer", channel: pick(CHANNELS),
                  description: "Transfer to external institution",
                  referenceNumber: referenceNumber(),
                  timestamp: new Date((dayTs + 6400) * 1000),
                }
              });
              currentBalance -= outflow;
              transactionsCreated++;
              await prisma.notification.create({
                data: {
                  customerId: customer.id, type: "TRANSACTION",
                  message: `A transfer of ${outflow} to an external institution has completed.`,
                  createdOn: new Date((dayTs + 6500) * 1000),
                },
              });
              notificationsCreated++;
              await trackEvent("free.payment.success", customer.id, tenantId,
                               { amount: outflow, category: "External Transfer", ...lMeta },
                               dayTs + 6600);
              eventsCreated++;
            }

            // ── Second transaction (some users do multiple per day)
            if (Math.random() < 0.3 && currentBalance > 2000) {
              const amount2 = Math.floor(gaussianRandom(persona.averageSpend * 0.5, persona.averageSpend * 0.3));
              const clamped2 = Math.min(amount2, currentBalance * 0.15);
              if (clamped2 >= 100) {
                const cat2 = pick(SPEND_CATEGORIES);
                const mcc2 = pick(MCC_TABLE);
                await prisma.transaction.create({
                  data: {
                    transactionType: "PAYMENT",
                    senderAccNo: accNo, receiverAccNo: "MERCHANT-ID",
                    amount: clamped2, status: "SUCCESS", category: cat2,
                    channel: pick(CHANNELS),
                    merchantCategoryCode: mcc2.mcc,
                    merchantName: mcc2.merchant,
                    referenceNumber: referenceNumber(),
                    timestamp: new Date((dayTs + 5000 + Math.floor(Math.random() * 7200)) * 1000),
                  }
                });
                currentBalance -= clamped2;
                transactionsCreated++;
                await simEmit("free.payment.success", 1, { amount: clamped2, category: cat2, channel: pick(CHANNELS), ...lMeta }, dayTs + 5005, { inScope, applyTraffic: false });
              }
            }
          }

          // ── Strict Pro Taxonomy Simulation ─────────────────────────
          const userPlan = persona.isEnterprise ? "enterprise" : "free";

          if (userPlan === "enterprise") {
            const ent = { inScope, tier: "enterprise" as const };
            await simEmit("pro.features.view", 1, { ...lMeta, tier: "enterprise" }, dayTs + 1300, ent);

            // Simulate a realistic enterprise user session that touches multiple pro modules.
            const proTimelineBase = dayTs + 1340;

            // Crypto suite
            if (await simEmit("crypto_trading.page.view", 0.22, { ...lMeta, tier: "enterprise" }, proTimelineBase + 5, ent)) {
              await simEmit("crypto_trading.price_feeds.view", 1, { source: pick(["live", "cache"]), ...lMeta, tier: "enterprise" }, proTimelineBase + 10, { ...ent, applyTraffic: false });
            }
            await simEmit("crypto_trading.portfolio.view", 0.14, { ...lMeta, tier: "enterprise" }, proTimelineBase + 20, ent);
            if (await simEmit("crypto_trading.trade_execution.success", 0.11, { amount: Math.floor(500 + Math.random() * 4500), symbol: pick(["BTC", "ETH", "SOL", "XRP"]), ...lMeta, tier: "enterprise" }, proTimelineBase + 30, ent)) {
              if (simFail("crypto-trading.trade_execution.failure", 0.09, inScope)) {
                await simEmit("crypto_trading.trade_execution.failure", 1, { reason: pick(["Insufficient Funds", "Price Slippage", "Exchange Timeout"]), ...lMeta, tier: "enterprise" }, proTimelineBase + 35, { ...ent, applyTraffic: false });
              }
            }

            // Wealth suite
            await simEmit("wealth_management_pro.insights.view", 0.16, { ...lMeta, tier: "enterprise" }, proTimelineBase + 45, ent);
            if (await simEmit("wealth_management_pro.rebalance.success", 0.08, { ...lMeta, tier: "enterprise" }, proTimelineBase + 55, ent)) {
              if (simFail("wealth-management-pro.rebalance.failure", 0.06, inScope)) {
                await simEmit("wealth_management_pro.rebalance.failure", 1, { reason: pick(["Allocation Constraint", "Market Halt"]), ...lMeta, tier: "enterprise" }, proTimelineBase + 58, { ...ent, applyTraffic: false });
              }
            }

            // Payroll suite
            await simEmit("bulk_payroll_processing.payees.view", 0.13, { ...lMeta, tier: "enterprise" }, proTimelineBase + 70, ent);
            if (simGate("bulk-payroll-processing.search.success", 0.1, inScope)) {
              const payrollSearchFailed = simFail("bulk-payroll-processing.search.failure", 0.12, inScope);
              await simEmit(payrollSearchFailed ? "bulk_payroll_processing.search.failure" : "bulk_payroll_processing.search.success", 1, { queryLength: Math.floor(3 + Math.random() * 7), ...lMeta, tier: "enterprise" }, proTimelineBase + 78, { ...ent, applyTraffic: false });
            }
            if (simGate("bulk-payroll-processing.batch.success", 0.07, inScope)) {
              const payrollBatchFailed = simFail("bulk-payroll-processing.batch.failure", 0.1, inScope);
              await simEmit(payrollBatchFailed ? "bulk_payroll_processing.batch.failure" : "bulk_payroll_processing.batch.success", 1, { employees: Math.floor(10 + Math.random() * 190), ...lMeta, tier: "enterprise" }, proTimelineBase + 86, { ...ent, applyTraffic: false });
            }

            // AI insights suite
            await simEmit("ai_insights.stats.view", 0.15, { ...lMeta, tier: "enterprise" }, proTimelineBase + 96, ent);
            await simEmit("ai_insights.book.success", 0.09, { title: pick(["The Intelligent Investor", "The Psychology of Money", "Rich Dad Poor Dad", "A Random Walk Down Wall Street"]), ...lMeta, tier: "enterprise" }, proTimelineBase + 104, ent);
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
              transactionsCreated++;
            }
          }

          // ── Unauthorized access attempts ──────────────────
          // Same event IsLoggedIn.ts emits when a non-admin hits an admin route, so a
          // simulated burst is indistinguishable from real violations downstream.
          await simEmit("auth.role.violation", behavior.pro.roleViolationRate, {
            role: "user",
            attempted_action: pick(["GET /api/admin/applications", "POST /api/approve", "PUT /api/events/toggles"]),
            ...lMeta,
          }, dayTs + 2600, { inScope });

          // ── Loan Application ──────────────────────────────
          if (!hasAppliedLoan && kycState === "VERIFIED" && day > 5 &&
              simGate("loan.applied.success", persona.loanInterest * behavior.loans.applicationMultiplier, inScope)) {
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
            await simEmit("lending.loans.viewed", 1, { ...lMeta }, dayTs + 2800, { inScope, applyTraffic: false });

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

            await simEmit("lending.loan.applied", 1, { loanType, amount: principalAmount, term, ...lMeta }, dayTs + 3000, { inScope, applyTraffic: false });
            if (kycComplete) {
              await simEmit("lending.loan.kyc_completed", 1, { context: "loan", ...lMeta }, dayTs + 3500, { inScope, applyTraffic: false });
            } else {
              await simEmit("lending.loan.kyc_abandoned", 1, { step: 1, context: "loan", ...lMeta }, dayTs + 3500, { inScope, applyTraffic: false });
            }

            // Approval. This route previously created applications but never approved one,
            // so loan_approval_volume's numerator (loan.approved.success) had no source on
            // the simulate path at all -- it came only from an admin clicking Approve in the
            // UI. "loan_approved" is the LEGACY_MAP key that resolves to loan.approved.success.
            if (kycComplete && simGate("loan.approved.success", behavior.loans.approvalRate, inScope)) {
              await prisma.loanApplication.updateMany({
                where: { customerId: customer.id, status: "PENDING" },
                data: { status: "APPROVED" },
              });
              await simEmit("loan_approved", 1, { loanType, amount: principalAmount, term, ...lMeta }, dayTs + 4200, { inScope, applyTraffic: false });

              // Disbursement. An approved application must become a real Loan and a real credit,
              // or the core-banking extract ships an empty loans table while applications claim
              // lending is active.
              const interestAmount = principalAmount * (interestRate / 100) * (term / 12);
              const startDate = new Date(dayTs * 1000);
              const endDate = new Date(startDate);
              endDate.setMonth(endDate.getMonth() + term);
              const loan = await prisma.loan.create({
                data: {
                  accNo, loanType, term,
                  interestRate: parseFloat(interestRate.toFixed(2)),
                  principalAmount,
                  interestAmount: parseFloat(interestAmount.toFixed(2)),
                  dueAmount: parseFloat((principalAmount + interestAmount).toFixed(2)),
                  startDate, endDate, schedule: [],
                },
              });
              loansCreated++;

              currentBalance += principalAmount;
              await prisma.transaction.create({
                data: {
                  transactionType: "DEPOSIT",
                  senderAccNo: "EXTERNAL-BANK", receiverAccNo: accNo,
                  amount: principalAmount, status: "SUCCESS",
                  category: "Loan Disbursement", channel: "WEB",
                  loanId: loan.id,
                  timestamp: new Date((dayTs + 4300) * 1000),
                },
              });
              transactionsCreated++;
              // Not in the journey model, so simEmit emits it unconditionally -- same effect as the
              // raw trackEvent it replaces, but it stays on the file's one emit path.
              await simEmit("lending.loan.disbursed", 1, { loanType, amount: principalAmount, term, ...lMeta }, dayTs + 4400, { inScope, applyTraffic: false });
            }
          }

          // ── Pro Feature Exploration & Conversion ──────────
          if (!isPro && simGate("features.view.action", 0.12, inScope)) {
            const featureId = pick(PRO_FEATURES);
            await simEmit("pro.features.view", 1, { featureId, ...lMeta }, dayTs + 4000, { inScope, applyTraffic: false });

            // Whale users (high balance) are 5x more likely to convert
            const isWhale = currentBalance > 100000;
            const conversionChance = persona.proConversionChance * (isWhale ? 5 : 1) * behavior.pro.conversionMultiplier;
            const canAfford = currentBalance > 5000;
            const converts = canAfford && !simFail("features.unlock.failed", Math.max(0, 1 - conversionChance), inScope);

            if (converts) {
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
                await simEmit("pro.features.unlock_success", 1, { featureId, ...lMeta }, dayTs + 4505, { inScope, applyTraffic: false });
                isPro = true;
                unlockedFeature = featureId;
                transactionsCreated++;
              } catch (e) {
                // License already exists — skip
              }
            } else {
              await simEmit("pro.features.unlock_failed", 1, {
                featureId,
                reason: canAfford ? "not_ready_to_upgrade" : "insufficient_funds",
                ...lMeta,
              }, dayTs + 4505, { inScope, applyTraffic: false });
            }
          }

          // ── Pro Feature Usage (already pro users) ─────────
          // Generate granular events per feature type for analytics tracking
          const proUsageCanon: Record<string, string> = {
            ai_insight_download: "ai-insights.book.success",
            "pro-feature?id=crypto-trading": "crypto-trading.trade_execution.success",
            wealth_rebalance: "wealth-management-pro.insights.view",
            "pro-feature?id=bulk-payroll-processing": "bulk-payroll-processing.batch.success",
          };
          const proFailCanon: Record<string, string> = {
            ai_insight_download: "ai-insights.book.failure",
            "pro-feature?id=crypto-trading": "crypto-trading.price_feeds.failure",
            wealth_rebalance: "wealth-management-pro.insights.failure",
            "pro-feature?id=bulk-payroll-processing": "bulk-payroll-processing.batch.failure",
          };
          if (isPro && simGate(proUsageCanon[unlockedFeature] ?? "crypto-trading.trade_execution.success", 0.5, inScope)) {
            // Log-normal response time: Box-Muller transform, median ~55ms, long tail to ~300ms
            const u1 = Math.random() || 1e-10;
            const u2 = Math.random();
            const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
            const responseTime = Math.max(15, Math.min(300, Math.round(Math.exp(4.0 + z * 0.7))));
            const isError = simFail(proFailCanon[unlockedFeature] ?? "crypto-trading.trade_execution.failure", behavior.pro.errorRate, inScope);

            const proUse = { inScope, applyTraffic: false, tier: "enterprise" as const };
            if (unlockedFeature === "ai_insight_download") {
              // Finance Library — book access events
              const bookTitles = ["The Intelligent Investor", "Rich Dad Poor Dad", "The Psychology of Money", "A Random Walk Down Wall Street", "Common Stocks and Uncommon Profits", "The Little Book of Common Sense Investing"];
              const bookTitle = pick(bookTitles);
              await simEmit((isError ? "ai_insights.book.failure" : "ai_insights.book.success"), 1, {
                feature: "ai-insights", title: bookTitle, status: isError ? "error" : "success",
                response_time_ms: responseTime, error: isError ? "timeout" : undefined, ...lMeta
              }, dayTs + 6000, proUse);
              await simEmit("ai_insights.stats.view", 1, {
                feature: "ai-insights", books_tracked: Math.floor(1 + Math.random() * 5),
                status: "success", response_time_ms: responseTime, ...lMeta
              }, dayTs + 6100, proUse);

            } else if (unlockedFeature === "pro-feature?id=crypto-trading") {
              // Crypto Trading — price views + trades
              const assets = ["BTC", "ETH", "SOL", "XRP", "ADA"];
              const asset = pick(assets);
              const tradeType = pick(["BUY", "SELL"]);
              await simEmit("crypto_trading.page.view", 1, { feature: "crypto-trading", ...lMeta }, dayTs + 5950, proUse);
              await simEmit((isError ? "crypto_trading.price_feeds.failure" : "crypto_trading.price_feeds.view"), 1, {
                feature: "crypto-trading", source: pick(["live", "cache"]),
                status: isError ? "error" : "success", response_time_ms: responseTime,
                assets_count: 5, ...lMeta
              }, dayTs + 6000, proUse);
              if (Math.random() < 0.4) {
                const tradeAmount = parseFloat((0.001 + Math.random() * 0.5).toFixed(4));
                await simEmit((isError ? "crypto_trading.trade_execution.failure" : "crypto_trading.trade_execution.success"), 1, {
                  feature: "crypto-trading", asset, amount: tradeAmount, type: tradeType,
                  status: isError ? "error" : "success", response_time_ms: responseTime,
                  error: isError ? "insufficient_funds" : undefined, ...lMeta
                }, dayTs + 6200, proUse);
              }
              await simEmit("crypto_trading.portfolio.view", 1, {
                feature: "crypto-trading", holdings_count: Math.floor(Math.random() * 4),
                status: "success", response_time_ms: responseTime, ...lMeta
              }, dayTs + 6300, proUse);

            } else if (unlockedFeature === "wealth_rebalance") {
              // Wealth Management — insights + rebalance
              await simEmit((isError ? "wealth_management_pro.insights.failure" : "wealth_management_pro.insights.view"), 1, {
                feature: "wealth-management-pro", status: isError ? "error" : "success",
                response_time_ms: responseTime, accounts_count: Math.floor(1 + Math.random() * 3),
                transactions_analyzed: Math.floor(10 + Math.random() * 200),
                net_worth: Math.floor(50000 + Math.random() * 500000),
                error: isError ? "db_timeout" : undefined, ...lMeta
              }, dayTs + 6000, proUse);
              if (Math.random() < 0.15) {
                await simEmit("wealth_management_pro.rebalance.success", 1, {
                  feature: "wealth-management-pro", status: "success",
                  response_time_ms: Math.floor(100 + Math.random() * 1000),
                  totalValue: Math.floor(100000 + Math.random() * 500000), ...lMeta
                }, dayTs + 6500, proUse);
              }

            } else if (unlockedFeature === "pro-feature?id=bulk-payroll-processing") {
              // Payroll Pro — payee views + batch processing
              await simEmit("bulk_payroll_processing.payees.view", 1, {
                feature: "bulk-payroll-processing", payees_count: Math.floor(2 + Math.random() * 15),
                status: "success", response_time_ms: responseTime, ...lMeta
              }, dayTs + 6000, proUse);
              if (Math.random() < 0.3) {
                const payeeCount = Math.floor(2 + Math.random() * 10);
                const amtPerPayee = Math.floor(1000 + Math.random() * 9000);
                await simEmit((isError ? "bulk_payroll_processing.batch.failure" : "bulk_payroll_processing.batch.success"), 1, {
                  feature: "bulk-payroll-processing",
                  payees_count: payeeCount,
                  amount_per_payee: amtPerPayee,
                  total_amount: payeeCount * amtPerPayee,
                  status: isError ? "error" : "success",
                  response_time_ms: Math.floor(200 + Math.random() * 2000),
                  error: isError ? "insufficient_funds" : undefined, ...lMeta
                }, dayTs + 6500, proUse);
              }
            }

            // Pro dashboard view each time
            await simEmit("pro.dashboard.view", 1, { day, featureId: unlockedFeature, ...lMeta }, dayTs + 6800, { inScope, applyTraffic: false, tier: "enterprise" });
          }

          // ── Profile View (occasional) ─────────────────────
          await simEmit("core.profile.viewed", 0.08, { ...lMeta }, dayTs + 7000, { inScope });
          // Occasional transactions page visit
          await simEmit("payments.history.viewed", 0.12, { ...lMeta }, dayTs + 7200, { inScope });
        }

        // ─── 8. REAL-TIME PULSE (LIVE METRICS) ─────────────
        // Ensure this persona reflects as "Real-Time" by generating a live ping NOW
        // 60% of simulated users have real-time activity when simulation executes
        if (Math.random() < 0.6) {
           lMeta = { ...lMeta, session_id: `sess_sim_${seed}_live` };
           const nowTs = Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 240); // Within last 4 minutes
           // A live ping is a continuation of an already-authenticated user; seed the
           // session with an implicit login (and pro access for enterprise personas) so
           // the journey gate does not back-fill a full onboarding for one ping.
           const liveSeed = persona.isEnterprise
             ? ["login.auth.success", "features.view.action"]
             : ["login.auth.success"];
           // The live ping is "now" (day 0), so it is in window; a segment still scopes it.
           const liveInScope = overrideApplies(behaviorOverride, {
             daysAgo: 0,
             deviceType: String(lMeta.device_type || ""),
             location: String(lMeta.location || ""),
           });
           await simEmit("free.dashboard.view", 1, { channel: persona.preferredChannel, ...lMeta, live_pulse: true }, nowTs, { inScope: liveInScope, seed: liveSeed });

           if (persona.isEnterprise && Math.random() < 0.3) {
               await simEmit("crypto_trading.trade_execution.success", 1, { amount: Math.floor(100 + Math.random() * 900), symbol: "BTC", ...lMeta, live_pulse: true }, nowTs + 15, { inScope: liveInScope, tier: "enterprise", seed: liveSeed });
           }
        }

        // One balance write per user. The eight intermediate flushes this replaced all wrote a
        // value the generator already held in memory, at ~350ms each against a remote Postgres.
        await prisma.account.update({ where: { accNo }, data: { balance: currentBalance } });
        createdUsers.push({ id: customer.id, name: customer.name, accNo,
                            ifsc: account.ifsc, balance: currentBalance });

        await trackEventsBatch(pendingEvents);
        pendingEvents.length = 0;
      };

      // Users are independent, and the cost of generating one is almost entirely waiting on a
      // remote database. Measured: 20 concurrent round trips complete in the time ~3 sequential
      // ones take. The cap keeps the Supabase pooler alive -- it closes long single-connection
      // runs, which is what killed 25x21 before this.
      const SIM_CONCURRENCY = Math.max(1, Math.min(
        Number(process.env.SIMULATE_CONCURRENCY) || 6, 12));
      let nextUser = 0;
      await Promise.all(
        Array.from({ length: Math.min(SIM_CONCURRENCY, simUserCount) }, async () => {
          for (;;) {
            const i = nextUser++;
            if (i >= simUserCount) return;
            try {
              await runUser(i);
            } catch (e) {
              // One user must not take the run down; it is already counted as skipped.
              skippedUsers++;
            }
          }
        })
      );

      // ─── 8. Generate Payee Relationships ────────────────
      // Link some simulated users as payees of each other
      let payeesCreated = 0;
      if (createdUsers.length >= 3) {
        const shuffled = [...createdUsers].sort(() => Math.random() - 0.5);
        const pairCount = Math.min(Math.floor(createdUsers.length * 0.4), 30);
        // Every user here was created by THIS run, so no payee link can pre-exist; a local set is
        // enough to keep pairs unique and costs nothing.
        const linked = new Set<string>();

        for (let p = 0; p < pairCount && p + 1 < shuffled.length; p++) {
          try {
            const payer = shuffled[p];
            const payee = shuffled[p + 1];
            const key = `${payer.id}->${payee.id}`;
            if (payer.id === payee.id || linked.has(key)) continue;
            linked.add(key);

            await prisma.payee.create({
              data: {
                name: payee.name,
                payeeAccNo: payee.accNo,
                payeeifsc: payee.ifsc,
                payeeCustomerId: payee.id,
                payerCustomerId: payer.id,
                payeeType: "INDIVIDUAL",
              }
            });
            payeesCreated++;

            // Some payees also do a transfer
            if (Math.random() < 0.4 && payer.balance > 5000) {
              const transferAmount = Math.floor(1000 + Math.random() * 5000);
              await prisma.transaction.create({
                data: {
                  transactionType: "TRANSFER",
                  senderAccNo: payer.accNo,
                  receiverAccNo: payee.accNo,
                  amount: transferAmount,
                  status: "SUCCESS",
                  category: "PAYEE_TRANSFER",
                  channel: "WEB",
                  description: `Transfer to ${payee.name}`,
                }
              });
              await prisma.account.update({ where: { accNo: payer.accNo }, data: { balance: { decrement: transferAmount } } });
              await prisma.account.update({ where: { accNo: payee.accNo }, data: { balance: { increment: transferAmount } } });
              payer.balance -= transferAmount;
              payee.balance += transferAmount;
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
        mode: "slow",
        requestedUsers: userCount,
        requestedTenant: rawTenant || "bank_a",
        resolvedTenant: tenantId,
        // Which population this run acted on. Without it a reuse run and a create run are
        // indistinguishable on the operator's screen.
        createAccounts,
        simulatedUsers: simUserCount,
        // "selected", not "available": the query is capped at userCount, so this is how many
        // were used, not how many the bank has.
        population: createAccounts
          ? "created"
          : `existing (${existing.length} customers selected)`,
        usersCreated,
        totalUsers: await prisma.customer.count({ where: { tenantId } }),
        transactionsCreated,
        eventsCreated,
        applicationsCreated,
        loansApplied: applicationsCreated,
        loansDisbursed: loansCreated,
        cardsIssued,
        notificationsCreated,
        interactionsCreated,
        compliantUsers,
        kycCompleted: compliantUsers,
        analyticsOptInUsers,
        fullyCompleted: analyticsOptInUsers,
        skippedUsers,
        payeesCreated,
        simulatedDays: simDays,
        runMs,
        throughputEventsPerSec: throughput,
        // Echo of what the run was asked to do, for the operator's screen only.
        // Deliberately NOT persisted anywhere: no table records that a movement was
        // introduced, so the intelligence layer has to infer it from the telemetry rather
        // than look it up. See NexaBank/backend/src/helper/simulationBehavior.ts.
        behaviorApplied: behaviorOverride,
        behaviorSummary: describeOverride(behaviorOverride),
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
            loansCreated,
            cardsIssued,
            notificationsCreated,
            interactionsCreated,
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
