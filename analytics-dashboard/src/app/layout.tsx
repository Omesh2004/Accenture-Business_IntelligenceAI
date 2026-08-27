import type { Metadata } from "next";
import { Suspense } from "react";
import { Inter } from "next/font/google";
import "./globals.css";
import StoreProvider from "@/lib/StoreProvider";
import AuthProvider from "@/components/AuthProvider";
import NavigationLoader from "@/components/NavigationLoader";
import { Toaster } from "sonner";
import QueryProvider from "@/lib/QueryProvider";

/**
 * Root layout with Inter font, Redux provider, and global metadata.
 * Uses Inter for a clean, professional look matching enterprise dashboards.
 */

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "FinInsights | Feature Intelligence & Analytics",
  description:
    "Production-grade SaaS analytics dashboard for tracking feature usage, user behavior, funnel analysis, and tenant comparison with AI-powered insights.",
  keywords: [
    "analytics",
    "dashboard",
    "SaaS",
    "features",
    "metrics",
    "enterprise",
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans bg-gray-100/50">
        <AuthProvider>
          {/*
            Pre-existing build defect, unrelated to the telemetry audit -- fixed only to
            unblock verifying `npm run build`. Same NavigationLoader/useSearchParams pattern
            (and the same fix) as NexaBank/frontend/app/layout.tsx.
          */}
          <Suspense fallback={null}>
            <NavigationLoader />
          </Suspense>
          <StoreProvider>
            <QueryProvider>{children}</QueryProvider>
          </StoreProvider>
          <Toaster position="bottom-right" richColors closeButton />
        </AuthProvider>
      </body>
    </html>
  );
}
