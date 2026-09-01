import type { NextConfig } from "next";

// When running inside Docker, use service names; otherwise use localhost
const analyticsApiHost = process.env.ANALYTICS_API_HOST || '127.0.0.1';
const ingestionApiHost = process.env.INGESTION_API_HOST || '127.0.0.1';

const nextConfig: NextConfig = {
  turbopack: {
    root: process.cwd(),
  },
  // Next 15 dev refuses cross-origin requests from an un-listed host. Inside compose the app is
  // reached as `analytics-dashboard:3001`, not localhost, so without this the dev server serves a
  // 200 with an empty body and every browser-driven test sees a blank page.
  allowedDevOrigins: ['analytics-dashboard', 'localhost', '127.0.0.1'],
  rewrites: async () => {
    return {
      beforeFiles: [],
      afterFiles: [
        {
          source: '/ingest/:path*',
          destination: `http://${ingestionApiHost}:8000/:path*`,
        },
      ],
      // Explicit backend API rewrites avoid regex edge-cases that can accidentally
      // capture /api/auth/* and break NextAuth client JSON fetches.
      // One entry per live route on :8001. The Metric API is /metric/* (singular) and was
      // missing entirely, so every KPI series call 404'd at the proxy and never reached the
      // backend. Routes Track B deleted are gone from here too.
      fallback: [
        { source: '/api/metric/:path*', destination: `http://${analyticsApiHost}:8001/metric/:path*` },
        { source: '/api/metrics/:path*', destination: `http://${analyticsApiHost}:8001/metrics/:path*` },
        { source: '/api/intelligence/:path*', destination: `http://${analyticsApiHost}:8001/intelligence/:path*` },
        { source: '/api/funnels', destination: `http://${analyticsApiHost}:8001/funnels` },
        { source: '/api/tenants', destination: `http://${analyticsApiHost}:8001/tenants` },
        { source: '/api/tenants/:path*', destination: `http://${analyticsApiHost}:8001/tenants/:path*` },
        { source: '/api/deployment/:path*', destination: `http://${analyticsApiHost}:8001/deployment/:path*` },
        { source: '/api/health', destination: `http://${analyticsApiHost}:8001/health` },
      ],
    };
  },
};

export default nextConfig;
