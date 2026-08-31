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
      fallback: [
        { source: '/api/ai_report', destination: `http://${analyticsApiHost}:8001/ai_report` },
        { source: '/api/metrics/:path*', destination: `http://${analyticsApiHost}:8001/metrics/:path*` },
        { source: '/api/features/:path*', destination: `http://${analyticsApiHost}:8001/features/:path*` },
        { source: '/api/funnels/:path*', destination: `http://${analyticsApiHost}:8001/funnels/:path*` },
        { source: '/api/insights/:path*', destination: `http://${analyticsApiHost}:8001/insights/:path*` },
        { source: '/api/tenants/:path*', destination: `http://${analyticsApiHost}:8001/tenants/:path*` },
        { source: '/api/realtime-users/:path*', destination: `http://${analyticsApiHost}:8001/realtime-users/:path*` },
        { source: '/api/pages/:path*', destination: `http://${analyticsApiHost}:8001/pages/:path*` },
        { source: '/api/locations/:path*', destination: `http://${analyticsApiHost}:8001/locations/:path*` },
        { source: '/api/audit_logs', destination: `http://${analyticsApiHost}:8001/audit_logs` },
        { source: '/api/audit/:path*', destination: `http://${analyticsApiHost}:8001/audit/:path*` },
        { source: '/api/configs/:path*', destination: `http://${analyticsApiHost}:8001/configs/:path*` },
        { source: '/api/retention/:path*', destination: `http://${analyticsApiHost}:8001/retention/:path*` },
        { source: '/api/deployment/:path*', destination: `http://${analyticsApiHost}:8001/deployment/:path*` },
        { source: '/api/admin/:path*', destination: `http://${analyticsApiHost}:8001/admin/:path*` },
        { source: '/api/ai/:path*', destination: `http://${analyticsApiHost}:8001/ai/:path*` },
        { source: '/api/license/:path*', destination: `http://${analyticsApiHost}:8001/license/:path*` },
        { source: '/api/tracking/:path*', destination: `http://${analyticsApiHost}:8001/tracking/:path*` },
        { source: '/api/config/:path*', destination: `http://${analyticsApiHost}:8001/config/:path*` },
        { source: '/api/transparency/:path*', destination: `http://${analyticsApiHost}:8001/transparency/:path*` },
        { source: '/api/journey/:path*', destination: `http://${analyticsApiHost}:8001/journey/:path*` },
        { source: '/api/segmentation/:path*', destination: `http://${analyticsApiHost}:8001/segmentation/:path*` },
        { source: '/api/predictive/:path*', destination: `http://${analyticsApiHost}:8001/predictive/:path*` },
        { source: '/api/intelligence/:path*', destination: `http://${analyticsApiHost}:8001/intelligence/:path*` },
      ],
    };
  },
};

export default nextConfig;
