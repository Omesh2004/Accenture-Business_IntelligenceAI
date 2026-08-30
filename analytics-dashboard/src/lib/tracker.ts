/**
 * Feature Intelligence Tracker SDK
 * 
 * Provides automatic and manual event tracking for any connected application.
 * Uses the Next.js /ingest proxy to avoid CORS issues.
 * 
 * USAGE:
 *   import { tracker } from '@/lib/tracker';
 *   tracker.track('user_signup', 'app-id', { plan: 'pro' });
 */

import axios from 'axios';

const INGEST_URL = '/ingest/events';

class FeatureTracker {
  private userId: string = 'anonymous';
  private role: string = 'guest';
  private sessionId: string = '';

  constructor() {
    if (typeof window !== 'undefined') {
      this.userId = localStorage.getItem('fi_userId') || 'anonymous';
      this.role = localStorage.getItem('fi_role') || 'guest';
      this.sessionId = sessionStorage.getItem('fi_session') || this.generateSessionId();
      sessionStorage.setItem('fi_session', this.sessionId);
    }
  }

  private generateSessionId(): string {
    return 'sess_' + Math.random().toString(36).substring(2, 15);
  }

  /** Set the current user identity (call after login) */
  setUser(userId: string, role: string = 'user') {
    this.userId = userId;
    this.role = role;
    if (typeof window !== 'undefined') {
      localStorage.setItem('fi_userId', userId);
      localStorage.setItem('fi_role', role);
    }
  }

  /**
   * Track an event.
   * @param eventName - The business-level event name (e.g., 'login', 'feature_used')
   * @param tenantId  - The app/tenant identifier (e.g., 'nexabank', 'acme-corp')
   * @param metadata  - Extra context (device, location, etc.)
   */
  async track(eventName: string, tenantId: string, metadata: Record<string, any> = {}) {
    const device = typeof window !== 'undefined' && window.innerWidth < 768 ? 'mobile' : 'desktop';

    const payload = {
      event_name: eventName,
      tenant_id: tenantId,
      user_id: this.userId,
      timestamp: Date.now() / 1000,
      channel: 'web',
      metadata: {
        role: this.role,
        device_type: device,
        session_id: this.sessionId,
        user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
        screen_width: typeof window !== 'undefined' ? window.innerWidth : 0,
        referrer: typeof document !== 'undefined' ? document.referrer : '',
        ...metadata,
      },
    };

    try {
      await axios.post(INGEST_URL, payload);
    } catch (err) {
      // Silent fail, analytics should never break the app
      console.warn(`[FI Tracker] Failed to send "${eventName}":`, err);
    }
  }

  /**
   * Track a page view automatically (called by middleware or useEffect).
   */
  async trackPageView(pathname: string, tenantId: string, featureName: string, responseTimeMs?: number) {
    await this.track(featureName, tenantId, {
      type: 'page_view',
      pathname,
      response_time_ms: responseTimeMs,
    });
  }
}

export const tracker = new FeatureTracker();
