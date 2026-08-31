import type React from "react";
import type { Metadata } from "next";
import { Suspense } from "react";
import { Inter } from "next/font/google";
import "./globals.css";
import { UserContextProvider } from "@/components/context/UserContext";
import NavigationLoader from "@/components/NavigationLoader";
import ProtectedRoute from "@/components/protected";
import { Toaster } from "sonner";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "NexaBank - Modern Banking",
  description: "Manage your finances with ease using NexaBank's secure, modern banking platform.",
  icons: {
    icon: "/logo.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="light">
      <body className={`${inter.className} bg-white text-gray-900`}>
        <UserContextProvider>
          {/*
            Pre-existing build defect, unrelated to the telemetry audit -- fixed only to
            unblock verifying `npm run build`. NavigationLoader.tsx (user's own in-progress
            work) calls useSearchParams(), which Next.js's static export requires be wrapped
            in a Suspense boundary or the whole build fails (reproduced: "/details" -- an
            unrelated route far from NavigationLoader itself -- because it inherits this root
            layout). Wrapped at the call site only; NavigationLoader.tsx's own logic is
            untouched.
          */}
          <Suspense fallback={null}>
            <NavigationLoader />
          </Suspense>
          <ProtectedRoute>
            {children}
            <Toaster richColors position="top-center" />
          </ProtectedRoute>
        </UserContextProvider>
      </body>
    </html>
  );
}
