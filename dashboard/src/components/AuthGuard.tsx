'use client';

import { useSession } from 'next-auth/react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { canAccessRoute } from '@/lib/rbac';
import { Zap } from 'lucide-react';

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    if (status === 'loading') return;

    if (status === 'unauthenticated') {
      router.replace('/login');
      return;
    }

    if (session?.user?.role) {
      if (!canAccessRoute(session.user.role, pathname)) {
        router.replace('/unauthorized');
        return;
      }
      setAuthorized(true);
    }
  }, [session, status, pathname, router]);

  if (status === 'loading' || !authorized) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-gray-100 flex-col space-y-4">
        <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
        <p className="text-sm font-medium text-gray-400">
          Verifying permissions...
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
