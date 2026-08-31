"use client";

import { ReactNode, useEffect } from "react";
import { useRouter } from "next/navigation";
import { UserData } from "@/components/context/UserContext";
import { Loader2 } from "lucide-react";

interface AdminGuardProps {
  children: ReactNode;
}

export function AdminGuard({ children }: AdminGuardProps) {
  const { role, isAuthLoading, isAuth } = UserData();
  const router = useRouter();

  useEffect(() => {
    if (!isAuthLoading) {
      if (!isAuth || role !== "ADMIN") {
        router.push("/dashboard");
      }
    }
  }, [isAuth, role, isAuthLoading, router]);

  if (isAuthLoading) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-white">
        <Loader2 className="h-8 w-8 animate-spin text-[#1a73e8]" />
      </div>
    );
  }

  if (role !== "ADMIN") {
    return null;
  }

  return <>{children}</>;
}
