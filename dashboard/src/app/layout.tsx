import type { Metadata } from "next";
import { Suspense } from "react";
import { Archivo, Source_Serif_4 } from "next/font/google";
import "./globals.css";
import StoreProvider from "@/lib/StoreProvider";
import AuthProvider from "@/components/AuthProvider";
import NavigationLoader from "@/components/NavigationLoader";
import { Toaster } from "sonner";
import QueryProvider from "@/lib/QueryProvider";

/**
 * The Accenture system: one grotesque doing the structural work, a serif for prose.
 *
 * Accenture set headings, navigation and UI in Graphik and reserve a serif for editorial body
 * copy. Graphik is licensed, so Archivo stands in: a neutral American grotesque with the same
 * closed apertures and sturdy, slightly narrow forms, which is what makes Graphik read as
 * confident rather than decorative at display sizes.
 *
 * Source Serif takes the prose -- the narrative, the lead paragraphs, the passages a reader
 * actually reads rather than scans. It does NOT take labels, tables or figures: a serif at 12px
 * in a dense table is decoration, and Accenture do not use it that way either.
 */
const display = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-display",
  display: "swap",
});

const ui = Archivo({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-ui",
  display: "swap",
});

const prose = Source_Serif_4({
  subsets: ["latin"],
  weight: ["300", "400", "600"],
  variable: "--font-prose",
  display: "swap",
});

export const metadata: Metadata = {
  title: "FinInsights | Feature Intelligence & Analytics",
  // The tab icon is the product mark, not the Next.js default that shipped with the scaffold.
  icons: { icon: "/logo1.png", shortcut: "/logo1.png", apple: "/logo1.png" },
  description:
    "Production-grade SaaS analytics dashboard for tracking KPI analysis, and tenant comparison with AI-powered insights.",
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
      className={`${ui.variable} ${display.variable} ${prose.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-sans bg-gray-100/50 selection:bg-purple-400 selection:text-white">
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
