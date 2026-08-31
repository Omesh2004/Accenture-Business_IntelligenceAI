"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { UserData } from "@/components/context/UserContext";

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuth, isAuthLoading } = UserData();
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted || isAuthLoading) return;

    const publicPaths = ["/", "/login", "/register"];
    const isPublicPath = publicPaths.includes(pathname);

    if (!isAuth && !isPublicPath) {
      router.replace("/login"); // Redirect unauthenticated users to login
    } else if (isAuth && isPublicPath && pathname !== "/") {
      // If user is already logged in and tries to access login/register, redirect to dashboard
      // Assuming you might want them to still access the landing page ("/")
      router.replace("/dashboard");
    }
  }, [isAuth, isAuthLoading, pathname, router, mounted]);

  // Don't render anything until mounted and auth check is complete to avoid hydration mismatches and flickering
  if (!mounted || isAuthLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#1a73e8]"></div>
      </div>
    );
  }

  return <>{children}</>;
}
