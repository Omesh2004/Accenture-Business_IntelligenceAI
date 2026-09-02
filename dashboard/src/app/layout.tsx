import type { Metadata } from "next";
import { Suspense } from "react";
import { Archivo } from "next/font/google";
import "./globals.css";
import StoreProvider from "@/lib/StoreProvider";
import AuthProvider from "@/components/AuthProvider";
import NavigationLoader from "@/components/NavigationLoader";
import { Toaster } from "sonner";
import QueryProvider from "@/lib/QueryProvider";

/**
 * One family, everywhere.
 *
 * Accenture set headings, navigation, UI and body in a single grotesque; the serif appears only
 * in long editorial passages on marketing pages, and a product surface has none of those.
 * Carrying two families here meant a reader met a different letterform every time they moved
 * from a heading to the sentence under it.
 *
 * Graphik is licensed, so Archivo stands in: a neutral American grotesque with the same closed
 * apertures and sturdy, slightly narrow forms, which is what makes Graphik read as confident
 * rather than decorative. Hierarchy comes from weight, size and tracking -- the more durable
 * system, and the only one available once the family is fixed.
 *
 * Three variables point at it so existing call sites keep working; they are deliberately the
 * same face.
 */
const archivo = Archivo({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-ui",
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
      className={`${archivo.variable} h-full antialiased`}
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
