import { defineConfig, devices } from "@playwright/test";

/**
 * Two apps, two base URLs, so each project points at its own.
 *
 * Hosts default to the compose service names because these run inside the `e2e` container;
 * override with DASHBOARD_URL / NEXABANK_URL to drive a stack from the host instead.
 */
const DASHBOARD_URL = process.env.DASHBOARD_URL || "http://analytics-dashboard:3001";
const NEXABANK_URL = process.env.NEXABANK_URL || "http://nexabank-frontend:3002";

export default defineConfig({
  testDir: "./tests",
  // Next.js dev compiles a route on first navigation (measured: 17-24s). These timeouts are sized
  // for that, not for a production build -- a tighter budget here would fail on cold routes and
  // teach everyone to ignore the suite.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "results/results.json" }]],
  outputDir: "results/artifacts",
  use: {
    // The dashboard's axios client talks to `localhost:8001`, which is true in a developer's
    // browser (the port is published) and false inside this container, where localhost is the
    // browser itself. Every API call then fails with a bare "Network Error" and the app renders
    // a blank page — a harness artefact that looks exactly like an application bug. Mapping the
    // name makes the test browser see what a developer's browser sees.
    launchOptions: {
      args: [
        "--host-resolver-rules=MAP localhost:8001 analytics-api:8001," +
          "MAP localhost:8000 ingestion-api:8000," +
          "MAP localhost:5000 nexabank-backend:5000",
      ],
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 20_000,
    navigationTimeout: 90_000,
  },
  projects: [
    {
      name: "dashboard",
      testMatch: /dashboard\..*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: DASHBOARD_URL },
    },
    {
      name: "nexabank",
      testMatch: /nexabank\..*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: NEXABANK_URL },
    },
    // Contract tests over HTTP. No browser rendering, so an agent regression and a UI regression
    // stay distinguishable -- and these still run when the dev server is mid-compile.
    {
      name: "api",
      testMatch: /api\..*\.spec\.ts/,
    },
  ],
});
