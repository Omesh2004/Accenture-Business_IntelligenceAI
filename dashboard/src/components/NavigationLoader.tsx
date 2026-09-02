"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

const FALLBACK_TIMEOUT = 8000;
const COMPLETION_DELAY = 250;

export default function NavigationLoader() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Create a unique route key
  const routeKey = useMemo(() => {
    const query = searchParams?.toString();
    return query ? `${pathname}?${query}` : pathname;
  }, [pathname, searchParams]);

  const [isLoading, setIsLoading] = useState(false);

  const pendingRouteRef = useRef<string | null>(null);
  const fallbackTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Handle link clicks globally
  useEffect(() => {
    const handleNavigationStart = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;

      const anchor = (event.target as HTMLElement)?.closest(
        "a[href]",
      ) as HTMLAnchorElement | null;
      if (!anchor) return;

      // Ignore special cases
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;

      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;

      try {
        const nextUrl = new URL(anchor.href, window.location.href);
        const currentUrl = new URL(window.location.href);

        // Ignore external links
        if (nextUrl.origin !== currentUrl.origin) return;

        const nextRoute = `${nextUrl.pathname}${nextUrl.search}`;
        const currentRoute = `${currentUrl.pathname}${currentUrl.search}`;

        if (nextRoute === currentRoute) return;

        pendingRouteRef.current = nextRoute;
        setIsLoading(true);

        // Fallback safety timeout
        if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);

        fallbackTimerRef.current = setTimeout(() => {
          setIsLoading(false);
          pendingRouteRef.current = null;
        }, FALLBACK_TIMEOUT);
      } catch {
        // Fail silently
      }
    };

    window.addEventListener("click", handleNavigationStart, true);
    return () =>
      window.removeEventListener("click", handleNavigationStart, true);
  }, []);

  // Stop loader when route changes
  useEffect(() => {
    if (!isLoading) return;

    const completionTimer = setTimeout(() => {
      setIsLoading(false);
      pendingRouteRef.current = null;

      if (fallbackTimerRef.current) {
        clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
    }, COMPLETION_DELAY);

    return () => clearTimeout(completionTimer);
  }, [routeKey, isLoading]);

  if (!isLoading) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-0 z-[9999] flex items-center justify-center bg-white"
    >
          {/* Loader */}
          <div className="flex items-center justify-center">
            <div className="relative h-10 w-10 shrink-0">
              <div className="absolute inset-0 rounded-full border-2 border-blue-100" />
              <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-blue-600 border-r-blue-600 animate-spin" />
            </div>
          </div>
    </div>
  );
}
