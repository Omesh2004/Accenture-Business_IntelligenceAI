"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

export default function NavigationLoader() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const routeKey = useMemo(() => {
    const query = searchParams?.toString() || "";
    return query ? `${pathname}?${query}` : pathname;
  }, [pathname, searchParams]);

  const [loading, setLoading] = useState(false);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onDocumentClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;

      const target = event.target as HTMLElement | null;
      const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;

      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;

      try {
        const nextUrl = new URL(anchor.href, window.location.href);
        const currentUrl = new URL(window.location.href);
        if (nextUrl.origin !== currentUrl.origin) return;

        const nextKey = `${nextUrl.pathname}${nextUrl.search}`;
        const currentKey = `${currentUrl.pathname}${currentUrl.search}`;
        if (nextKey === currentKey) return;

        setLoading(true);

        if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = setTimeout(() => {
          setLoading(false);
        }, 8000);
      } catch {
        // Ignore URL parsing errors and skip loader.
      }
    };

    window.addEventListener("click", onDocumentClick, true);
    return () => window.removeEventListener("click", onDocumentClick, true);
  }, []);

  useEffect(() => {
    setLoading(false);
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  }, [routeKey]);

  if (!loading) return null;

  return (
    <div className="min-h-screen fixed inset-0 z-[9999] flex items-center justify-center bg-white/70 backdrop-blur-sm">
      <div className="relative h-10 w-10 shrink-0">
        <div className="absolute inset-0 rounded-full border-2 border-blue-100" />
        <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-[#8f1ae8] border-r-[#961ae8] animate-spin" />
      </div>
    </div>
  );
}
