import { test, expect } from "@playwright/test";
import { signIn, USERS } from "../support/session";

/**
 * Core Web Vitals, measured rather than estimated.
 *
 * Collected via PerformanceObserver in the page, so these are the browser's own numbers. Thresholds
 * are RECORDED, not asserted, for one reason: both apps run `next dev`, where every route is
 * compiled on first navigation and LCP is dominated by compile time rather than by anything in the
 * code. Asserting Google's thresholds against a dev server would fail permanently and teach the
 * team to ignore the suite. Run with NEXT_MODE=production to get numbers worth gating on.
 */

type Vitals = { lcp: number | null; cls: number | null; ttfb: number | null; inp: number | null };

async function collect(page: import("@playwright/test").Page): Promise<Vitals> {
  return page.evaluate<Vitals>(() => {
    return new Promise((resolve) => {
      const out: Vitals = { lcp: null, cls: null, ttfb: null, inp: null };

      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      if (nav) out.ttfb = Math.round(nav.responseStart);

      try {
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1] as PerformanceEntry & { startTime: number };
          if (last) out.lcp = Math.round(last.startTime);
        }).observe({ type: "largest-contentful-paint", buffered: true });
      } catch { /* unsupported */ }

      try {
        let cls = 0;
        new PerformanceObserver((list) => {
          for (const e of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) {
            if (!e.hadRecentInput) cls += e.value;
          }
          out.cls = Math.round(cls * 1000) / 1000;
        }).observe({ type: "layout-shift", buffered: true });
      } catch { /* unsupported */ }

      setTimeout(() => resolve(out), 4000);
    });
  });
}

const PAGES = [
  { name: "login", path: "/login", auth: false },
  { name: "dashboard", path: "/nexabank/dashboard", auth: true },
  { name: "intelligence", path: "/nexabank/intelligence", auth: true },
];

for (const p of PAGES) {
  test(`web vitals: ${p.name}`, async ({ page, context, baseURL }) => {
    if (p.auth) await signIn(context, USERS.appAdmin, baseURL!);

    // Warm the route first so the measurement is of the PAGE, not of the dev compiler.
    await page.goto(p.path).catch(() => {});
    await page.goto(p.path, { waitUntil: "load" });

    const v = await collect(page);
    const transfer = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .reduce((sum, r) => sum + ((r as PerformanceResourceTiming).transferSize || 0), 0),
    );
    const requests = await page.evaluate(() => performance.getEntriesByType("resource").length);

    test.info().annotations.push({
      type: "vitals",
      description: JSON.stringify({ page: p.name, ...v, transferBytes: transfer, requests }),
    });
    // The only hard assertion: the page actually rendered something measurable.
    expect(v.ttfb, `${p.name} produced no navigation timing`).not.toBeNull();
  });
}
