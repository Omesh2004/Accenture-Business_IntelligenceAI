import axios from 'axios';
import { getNexaBankSessionId } from './api';

const INGESTION_API_URL = process.env.NEXT_PUBLIC_INGESTION_URL || 'http://localhost:8000/events';

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
    const sessionId = getNexaBankSessionId();
    const device =
      typeof window !== 'undefined' && window.innerWidth < 768
        ? 'mobile'
        : 'desktop';

    const payload = {
      event_id:
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `event-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      session_id: sessionId,
      event_name: eventName,
      tenant_id: this.tenantId,
      user_id: this.userId,
      timestamp: Date.now() / 1000,
      channel: 'web',
      metadata: {
        role: this.role,
        session_id: sessionId,
        device_type: device,
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
