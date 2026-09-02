import type { Metadata } from "next";
import { Suspense } from "react";
import { Geologica, Roboto_Flex } from "next/font/google";
import "./globals.css";
import StoreProvider from "@/lib/StoreProvider";
import AuthProvider from "@/components/AuthProvider";
import NavigationLoader from "@/components/NavigationLoader";
import { Toaster } from "sonner";
import QueryProvider from "@/lib/QueryProvider";

/**
 * Two roles, no more.
 *
 * Geologica sets headings: a variable grotesque with enough weight range to carry a page title
 * without shouting, and enough character at large sizes to read as a statement rather than a
 * bigger label.
 *
 * Roboto Flex sets everything a reader uses -- labels, body, controls and every FIGURE. Its
 * optical sizing keeps small labels legible at 10px and long prose comfortable at 16, and its
 * tabular numerals keep a column of numbers aligned, which matters on every table here.
 *
 * Both are loaded through next/font, so the files are self-hosted and there is no render-blocking
 * request to Google on first paint.
 */
const display = Geologica({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-display",
  display: "swap",
});

const ui = Roboto_Flex({
  subsets: ["latin"],
  // A variable axis, so one file covers every weight the scale asks for.
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
      className={`${ui.variable} ${display.variable} h-full antialiased`}
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
