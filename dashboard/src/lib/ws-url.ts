export function resolveAnalyticsWsBaseUrl(rawBaseUrl?: string): string {
  const fallback = 'ws://localhost:8001';
  const base = (rawBaseUrl || '').trim() || fallback;

  // In SSR, keep raw value and let the browser connection logic decide later.
  if (typeof window === 'undefined') {
    return normalizeWsProtocol(base);
  }

  try {
    const normalizedInput = normalizeWsProtocol(base);
    const parsed = new URL(normalizedInput);
    const host = parsed.hostname.toLowerCase();

    // Docker service hostnames are not resolvable from browser on host machine.
    // Replace them with the browser-visible host while preserving websocket port.
    if (host === 'analytics-api' || host === 'ingestion-api') {
      const browserHost = window.location.hostname || 'localhost';
      return `${parsed.protocol}//${browserHost}:${parsed.port || '8001'}`;
    }

    return normalizedInput;
  } catch {
    return fallback;
  }
}

function normalizeWsProtocol(url: string): string {
  return url.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
}
