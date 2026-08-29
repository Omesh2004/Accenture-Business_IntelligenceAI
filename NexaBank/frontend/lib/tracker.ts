import axios from 'axios';
import { getBrowserContext, getNexaBankSessionId } from './api';

const INGESTION_API_URL = process.env.NEXT_PUBLIC_INGESTION_URL || 'http://localhost:8000/events';

/**
 * SHA-256 hex digest via WebCrypto, matching the backend's hashUserId() in
 * NexaBank/backend/src/middleware/eventTracker.ts (crypto.createHash('sha256')...digest('hex'))
 * byte-for-byte -- same algorithm, same encoding, so the same customer produces the same
 * hashed ID whether an event goes through the backend or this browser-direct path.
 *
 * Found during the NexaBank telemetry audit: setUser() below is fed the RAW authenticated
 * customer ID at every call site (login, registration, UserContext's session hydration), and
 * this class had no hashing anywhere -- track() sent `user_id: this.userId` unhashed straight
 * to ingestion. No live call site invokes track() today (grep confirmed zero), so nothing has
 * actually leaked yet, but nothing prevented it either: any future caller of track() would
 * ship a raw authenticated customer ID into ClickHouse. Hashed here, at send time, rather than
 * in setUser(), because WebCrypto's digest is async and setUser() has 3 existing synchronous
 * call sites that would all need to change; track() was already async.
 */
async function hashUserIdHex(userId: string): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    // No WebCrypto (very old browser, or a non-browser test runner). Never send the raw ID in
    // that case -- fail toward "anonymous", the same fallback setUser() itself defaults to,
    // rather than toward leaking an unhashed identity.
    return 'anonymous';
  }
  const bytes = new TextEncoder().encode(userId);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function toAnalyticsTenantId(tenantId?: string): string {
  const normalized = String(tenantId || '').trim().toLowerCase();
  if (normalized === 'bank_a' || normalized === 'nexabank') return 'nexabank';
  if (normalized === 'bank_b' || normalized === 'safexbank') return 'safexbank';
  return normalized || 'nexabank';
}

class NexaBankTracker {
  userId: string;
  role: string;
  email: string;
  tenantId: string;

  constructor() {
    this.userId = 'anonymous';
    this.role = 'user';
    this.email = '';
    this.tenantId = 'nexabank';
  }

  setUser(userId: string, role: string, email?: string, tenantId?: string) {
    this.userId = userId;
    this.role = role.toLowerCase();
    this.email = email || '';
    this.tenantId = toAnalyticsTenantId(tenantId);
  }

  async track(eventName: string, metadata: Record<string, any> = {}) {
    const hashedUserId = this.userId === 'anonymous' ? 'anonymous' : await hashUserIdHex(this.userId);
    const sessionId = getNexaBankSessionId();
    // Real browser context resolved once per session by useGeoLocation. This path bypasses
    // the backend, so nothing else fills location/device_type in for it.
    const browser = getBrowserContext();
    const device =
      browser.device_type ||
      (typeof window !== 'undefined' && window.innerWidth < 768 ? 'mobile' : 'desktop');

    const payload = {
      event_id:
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `event-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      session_id: sessionId,
      event_name: eventName,
      tenant_id: this.tenantId,
      user_id: hashedUserId,
      timestamp: Date.now() / 1000,
      channel: 'web',
      metadata: {
        role: this.role,
        session_id: sessionId,
        device_type: device,
        // `location` holds a COUNTRY value -- the physical key used across the pipeline.
        // Omitted rather than guessed when useGeoLocation has not resolved yet.
        ...(browser.location ? { location: browser.location } : {}),
        ...(browser.city ? { city: browser.city } : {}),
        email: this.email,
        ...metadata,
      },
    };

    try {
      await axios.post(INGESTION_API_URL, payload, { timeout: 3000 });
      console.log(`[NexaBank Analytics] Tracked: ${eventName}`);
    } catch (error) {
      // Fail silently — analytics should never break the banking app
      console.warn(`[NexaBank Analytics] Failed: ${eventName}`);
    }
  }
}

export const nexaTracker = new NexaBankTracker();
