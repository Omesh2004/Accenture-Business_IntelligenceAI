import axios from 'axios';
import { useCallback, useEffect, useRef } from 'react';
import { API_BASE_URL } from '@/lib/api';
import { useFeatureToggles } from '@/components/context/FeatureToggleContext';

export interface EventMetadata {
  // A3 fix (docs/FinInsights_Bug_Audit.md): this was `responseTime` (camelCase). The backend's
  // forwardToIngestionAPI reads `metadata.response_time_ms` (snake_case) -- the names never
  // matched, so the real measurement made here rode along in metadata, unused, while a random
  // log-normal value was written to the column everything reads. Renamed to match what the
  // backend actually looks for.
  response_time_ms?: number;
  error?: string | unknown;
  amount?: number;
  currency?: string;
  [key: string]: unknown;
}

/**
 * Suppression window for identical (eventType, metadata) pairs.
 *
 * Two mechanisms used to emit every page view twice:
 *   1. `track` was a useCallback over [toggles]. `toggles` starts {} and is replaced with a
 *      fresh object once refreshToggles() resolves, so `track`'s identity changed and every
 *      `useEffect(..., [track])` re-ran. Fixed below by reading toggles through a ref.
 *   2. React StrictMode mounts effects twice in development, which the ref fix cannot see
 *      because each mount is a separate hook instance.
 *
 * Both produce rows with DISTINCT event_ids, so uniqExact(event_id) cannot collapse them --
 * they are a genuine 2x on every live count. The map is module-level so it survives remounts.
 *
 * This suppression window existed to catch case 2, but didn't: `measureAndTrack` always adds
 * `response_time_ms`, and StrictMode's two invocations independently measure two different
 * timings for the same action, so the two calls' JSON.stringify(metadata) differ, the suppression
 * key differs, and both sail through as genuinely distinct rows -- confirmed live in events_raw
 * (same event/user/second landing twice with two different real event_ids, e.g.
 * dashboard.page.view / profile.location.success / transactions.page.view pairs). `suppressionKey`
 * below excludes fields that legitimately vary between two invocations of the same logical
 * action, so the key actually matches for StrictMode's duplicate instead of only for a
 * byte-identical call.
 */
const RECENT_EMIT_TTL_MS = 700;
const recentEmits = new Map<string, number>();

/** Metadata fields expected to differ between StrictMode's two invocations of the same action
 * (timing measurements chiefly) -- excluded from the suppression key so a few milliseconds of
 * jitter doesn't defeat the whole point of this map: the two invocations are still one real
 * user action. */
const VOLATILE_METADATA_KEYS = new Set(['response_time_ms']);

function suppressionKey(eventType: string, metadata?: EventMetadata): string {
  const stableMetadata = Object.fromEntries(
    Object.entries(metadata ?? {}).filter(([key]) => !VOLATILE_METADATA_KEYS.has(key))
  );
  return `${eventType}|${JSON.stringify(stableMetadata)}`;
}

function shouldSuppress(key: string): boolean {
  const now = Date.now();

  for (const [k, ts] of recentEmits) {
    if (now - ts > RECENT_EMIT_TTL_MS) recentEmits.delete(k);
  }

  const last = recentEmits.get(key);
  if (last !== undefined && now - last <= RECENT_EMIT_TTL_MS) return true;

  recentEmits.set(key, now);
  return false;
}

export const useEventTracker = () => {
  const { toggles } = useFeatureToggles();

  // Read toggles through a ref so `track` keeps a stable identity across renders.
  const togglesRef = useRef(toggles);
  useEffect(() => {
    togglesRef.current = toggles;
  }, [toggles]);

  const track = useCallback(async (eventType: string, metadata?: EventMetadata) => {
    // If the toggle is explicitly set to false, skip tracking
    const currentToggles = togglesRef.current;
    if (currentToggles && currentToggles[eventType] === false) {
      console.log(`Tracking disabled for feature: ${eventType}`);
      return;
    }

    if (shouldSuppress(suppressionKey(eventType, metadata))) {
      return;
    }

    try {
      await axios.post(`${API_BASE_URL}/events/track`, {
        eventType,
        metadata
      }, { withCredentials: true });
    } catch (e: unknown) {
      // Fail silently to avoid interrupting UX
      console.warn(`Failed to track event ${eventType}`, e);
    }
  }, []);

  const measureAndTrack = useCallback(async <T,>(
    eventType: string, 
    action: () => Promise<T>, 
    baseMetadata?: EventMetadata
  ): Promise<T> => {
    const start = performance.now();
    try {
      const result = await action();
      const end = performance.now();
      await track(`${eventType}.success`, { ...baseMetadata, response_time_ms: Math.round(end - start) });
      return result;
    } catch (error: unknown) {
      const end = performance.now();
      await track(`${eventType}.error`, {
        ...baseMetadata,
        response_time_ms: Math.round(end - start),
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }, [track]);

  return { track, measureAndTrack };
};
