"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAppSelector } from "@/lib/store";
import { resolveAnalyticsWsBaseUrl } from "@/lib/ws-url";
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import {
  normalizeTenantId,
  resolveAppIdFromPathname,
  resolvePrimaryAppIdFromAdminApps,
  resolvePrimaryTenantForApp,
} from '@/lib/feature-map';

export interface RealtimeEvent {
  type: string;
  data: {
    eventName: string;
    tenantId: string;
    userId: string;
    /**
     * Open bag, mirroring events_raw.metadata (a JSON String on the ClickHouse side).
     * The named keys are what telemetry events carry; intelligence-pipeline broadcasts
     * (anomaly.detected, trust.verdict.changed, recommendation.*, insight.*) put their own
     * keys here instead, so this cannot be a closed shape.
     */
    metadata?: {
      country?: string;
      city?: string;
      continent?: string;
      device_type?: string;
      [key: string]: string | number | boolean | undefined;
    };
  };
  timestamp: number;
}

interface UseRealtimeEventsOptions {
  maxEvents?: number;
  reconnectDelay?: number;
}

export function useRealtimeEvents(options: UseRealtimeEventsOptions = {}) {
  const { maxEvents = 50, reconnectDelay = 3000 } = options;
  const [events, setEvents] = useState<RealtimeEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<RealtimeEvent | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pathname = usePathname();
  const { data: session } = useSession();
  
  const selectedTenants = useAppSelector((state) => state.dashboard.selectedTenants);
  const routeAppId = resolveAppIdFromPathname(pathname);
  const sessionAppId = resolvePrimaryAppIdFromAdminApps(session?.user?.adminApps || []);
  const activeAppId = routeAppId || sessionAppId || 'nexabank';
  const selectedTenantRaw = selectedTenants.length > 0
    ? selectedTenants[0]
    : resolvePrimaryTenantForApp(activeAppId);
  const selectedTenant = normalizeTenantId(selectedTenantRaw);

  const connect = useCallback(() => {
    if (!selectedTenant) return;
    try {
      const baseUrl = resolveAnalyticsWsBaseUrl(process.env.NEXT_PUBLIC_ANALYTICS_WS_URL);
      const wsUrl = `${baseUrl}/ws/dashboard/${selectedTenant}`;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        if (pingTimerRef.current) clearInterval(pingTimerRef.current);
        pingTimerRef.current = setInterval(() => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send('ping');
          }
        }, 15000);
      };

      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          
          if (parsed.type === "REALTIME_EVENT" && parsed.payload) {
             const rtEvent: RealtimeEvent = {
                 type: parsed.type,
                 data: {
                     eventName: parsed.payload.event_name,
                     tenantId: parsed.payload.tenant_id,
                     userId: parsed.payload.user_id,
                     metadata: parsed.payload.metadata
                 },
                 timestamp: Date.now()
             }
             setLastEvent(rtEvent);
             setEvents((prev) => {
               const updated = [rtEvent, ...prev];
               return updated.slice(0, maxEvents);
             });
          }

          // ── Intelligence Layer WebSocket events ──
          // These are dispatched by the pipeline backend for real-time updates.
          // Each recognized type dispatches a typed event for downstream hooks.
          if (parsed.type === "anomaly.detected" && parsed.payload) {
            const rtEvent: RealtimeEvent = {
              type: 'anomaly.detected',
              data: {
                eventName: parsed.payload.metric_id || 'anomaly',
                tenantId: parsed.payload.tenant_id || '',
                userId: '',
                metadata: {
                  anomaly_id: parsed.payload.id,
                  deviation_type: parsed.payload.deviation_type,
                  z_score: String(parsed.payload.z_score ?? ''),
                  status: parsed.payload.status,
                },
              },
              timestamp: Date.now(),
            };
            setLastEvent(rtEvent);
            setEvents((prev) => [rtEvent, ...prev].slice(0, maxEvents));
          }

          if (parsed.type === "trust.verdict.changed" && parsed.payload) {
            const rtEvent: RealtimeEvent = {
              type: 'trust.verdict.changed',
              data: {
                eventName: parsed.payload.metric_id || 'trust',
                tenantId: parsed.payload.tenant_id || '',
                userId: '',
                metadata: {
                  verdict: parsed.payload.verdict,
                  quarantined: String(parsed.payload.quarantined ?? ''),
                  failing_check: parsed.payload.failing_check,
                },
              },
              timestamp: Date.now(),
            };
            setLastEvent(rtEvent);
            setEvents((prev) => [rtEvent, ...prev].slice(0, maxEvents));
          }

          if (parsed.type === "recommendation.created" && parsed.payload) {
            const rtEvent: RealtimeEvent = {
              type: 'recommendation.created',
              data: {
                eventName: parsed.payload.action || 'recommendation',
                tenantId: parsed.payload.tenant_id || '',
                userId: '',
                metadata: {
                  recommendation_id: parsed.payload.id,
                  category: parsed.payload.category,
                  rank: String(parsed.payload.rank ?? ''),
                },
              },
              timestamp: Date.now(),
            };
            setLastEvent(rtEvent);
            setEvents((prev) => [rtEvent, ...prev].slice(0, maxEvents));
          }

          if ((parsed.type === "narrative.verified" || parsed.type === "narrative.redacted") && parsed.payload) {
            const rtEvent: RealtimeEvent = {
              type: parsed.type,
              data: {
                eventName: parsed.payload.report_id || 'narrative',
                tenantId: parsed.payload.tenant_id || '',
                userId: '',
                metadata: {
                  verifier_pass: String(parsed.payload.verifier_pass ?? ''),
                  degraded_mode: String(parsed.payload.degraded_mode ?? ''),
                },
              },
              timestamp: Date.now(),
            };
            setLastEvent(rtEvent);
            setEvents((prev) => [rtEvent, ...prev].slice(0, maxEvents));
          }
        } catch {
          // Ignore unparseable messages
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        wsRef.current = null;
        if (pingTimerRef.current) {
          clearInterval(pingTimerRef.current);
          pingTimerRef.current = null;
        }
        if (reconnectDelay > 0) {
          reconnectTimerRef.current = setTimeout(connect, reconnectDelay);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      // SSR
    }
  }, [maxEvents, reconnectDelay, selectedTenant]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [connect]);

  const clearEvents = useCallback(() => {
    setEvents([]);
    setLastEvent(null);
  }, []);

  return {
    events,
    lastEvent,
    isConnected,
    clearEvents,
    eventCount: events.length,
  };
}
