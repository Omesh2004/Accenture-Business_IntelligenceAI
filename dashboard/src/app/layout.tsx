import type { Metadata } from "next";
import { Suspense } from "react";
import { Inter, Instrument_Serif, JetBrains_Mono } from "next/font/google";
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

// Display face for the intelligence report's headlines. A finding stated in the same face as the
// chrome around it reads as another label; a distinct display face makes it read as a statement.
const display = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-display",
  display: "swap",
});

// Figures are compared column-to-column, so they need fixed advance widths. Inter's proportional
// digits make a 236 and a 5 in adjacent rows look like different magnitudes than they are.
const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
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
    <html
      lang="en"
      className={`${inter.variable} ${display.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-sans bg-gray-100/50">
        <AuthProvider>
          {/*
            Pre-existing build defect, unrelated to the telemetry audit -- fixed only to
            unblock verifying `npm run build`. Same NavigationLoader/useSearchParams pattern
            (and the same fix) as nexabank/frontend/app/layout.tsx.
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
