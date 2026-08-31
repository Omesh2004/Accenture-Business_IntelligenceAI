"use client";

import { useState, useEffect, useCallback, useRef } from "react";

export interface RealtimeEvent {
  type: string;
  data: {
    eventName: string;
    tenantId: string;
    userId: string;
    metadata?: {
      country?: string;
      city?: string;
      continent?: string;
      device_type?: string;
    };
  };
  timestamp: number;
}

interface UseRealtimeEventsOptions {
  /** Maximum number of events to keep in the buffer */
  maxEvents?: number;
  /** Auto-reconnect delay in ms (0 to disable) */
  reconnectDelay?: number;
}

/**
 * React hook that connects to the NexaBank WebSocket server
 * and provides a real-time event stream to components.
 */
export function useRealtimeEvents(options: UseRealtimeEventsOptions = {}) {
  const { maxEvents = 50, reconnectDelay = 3000 } = options;

  const [events, setEvents] = useState<RealtimeEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<RealtimeEvent | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    try {
      // Use the backend WebSocket URL
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api";
      const wsBase = apiUrl.replace(/^http/, "ws").replace(/\/api$/, "");
      const wsUrl = `${wsBase}/ws`;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const parsed: RealtimeEvent = JSON.parse(event.data);
          if (parsed.type === "connected") return; // Skip connection ping

          setLastEvent(parsed);
          setEvents((prev) => {
            const updated = [parsed, ...prev];
            return updated.slice(0, maxEvents);
          });
        } catch {
          // Ignore unparseable messages
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        wsRef.current = null;
        // Auto-reconnect
        if (reconnectDelay > 0) {
          reconnectTimerRef.current = setTimeout(connect, reconnectDelay);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      // WebSocket not available in SSR
    }
  }, [maxEvents, reconnectDelay]);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
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
