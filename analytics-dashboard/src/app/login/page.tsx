'use client';

import { useEffect, useState } from 'react';
import { signIn, useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { ShieldCheck, Activity, Layers } from 'lucide-react';
import Image from 'next/image';
import { buildAppScopedPath, resolvePrimaryAppIdFromAdminApps } from '@/lib/feature-map';

export default function LoginPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (status === 'authenticated') {
      const role = session.user.role;
      if (role === 'super_admin') router.replace('/admin');
      else if (role === 'app_admin') {
        const appId = resolvePrimaryAppIdFromAdminApps(session.user.adminApps || []) || 'nexabank';
        router.replace(buildAppScopedPath(appId, '/dashboard'));
      }
      else router.replace('/unauthorized');
    }
  }, [session, status, router]);

  const handleLogin = async () => {
    try {
      setLoading(true);
      await signIn('google', { callbackUrl: '/login' });
    } finally {
      setLoading(false);
    }
  };

  if (status === 'loading' || status === 'authenticated') {
    return (
      <div className="flex h-screen items-center justify-center bg-white">
        <Image src="/logo1.png" alt="FinInsights" width={48} height={48} className="animate-pulse" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white flex selection:bg-blue-100">

      {/* Left Panel, Branding */}
      <div className="hidden lg:flex flex-1 flex-col justify-between p-12 bg-gradient-to-br from-[#1a73e8] to-[#0d47a1] text-white relative overflow-hidden">
        {/* Background accent shapes */}
        <div className="absolute -top-24 -right-24 w-72 h-72 bg-white/5 rounded-full" />
        <div className="absolute bottom-12 -left-16 w-56 h-56 bg-white/5 rounded-full" />

        <div>
          <div className="flex items-center gap-3 mb-2">
            <Image src="/logo1.png" alt="FinInsights Logo" width={40} height={40} className="object-contain" />
            <span className="text-2xl font-bold tracking-tight">FinInsights</span>
          </div>
          <p className="text-white/60 text-sm mt-1">Feature Intelligence Platform</p>
        </div>

        <div className="space-y-8 relative z-10">
          <h2 className="text-3xl font-bold leading-tight tracking-tight max-w-sm">
            Real-time analytics for every feature you ship.
          </h2>
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-white/10 rounded-full flex items-center justify-center">
                <Activity className="w-4 h-4" />
              </div>
              <span className="text-sm text-white/80">Live event streaming via WebSockets</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-white/10 rounded-full flex items-center justify-center">
                <Layers className="w-4 h-4" />
              </div>
              <span className="text-sm text-white/80">Multi-tenant analytics with role-based access</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-white/10 rounded-full flex items-center justify-center">
                <ShieldCheck className="w-4 h-4" />
              </div>
              <span className="text-sm text-white/80">Enterprise-grade data governance</span>
            </div>
          </div>
        </div>

        <p className="text-white/40 text-xs">©2026 FinInsightsAnalytics. All rights reserved.</p>
      </div>

      {/* Right Panel, Login Form */}
      <div className="flex-1 flex flex-col items-center justify-center p-8 md:p-16">
        {/* Mobile brand */}
        <div className="lg:hidden flex items-center gap-2 mb-10">
          <Image src="/logo1.png" alt="FinInsights" width={32} height={32} />
          <span className="text-xl font-bold text-gray-900 tracking-tight">FinInsights</span>
        </div>

        <div className="w-full max-w-sm">
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight mb-1">Welcome back</h1>
          <p className="text-gray-500 text-sm mb-8">Sign in to access your analytics dashboard.</p>

          <button
            onClick={handleLogin}
            disabled={loading}
            className="group w-full flex items-center justify-center gap-3 bg-white text-gray-800 px-6 py-3.5 rounded-xl font-semibold border border-gray-200 transition-all hover:border-gray-300 hover:shadow-md  disabled:opacity-70 cursor-pointer"
          >
            {loading ? (
              <div className="w-5 h-5 border-2 border-gray-300 border-t-gray-800 rounded-full animate-spin" />
            ) : (
              <>
                {/* Google G Logo SVG */}
                <svg className="w-5 h-5" viewBox="0 0 24 24">
                  <path
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    fill="#4285F4"
                  />
                  <path
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    fill="#34A853"
                  />
                  <path
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                    fill="#FBBC05"
                  />
                  <path
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                    fill="#EA4335"
                  />
                </svg>
                <span>Continue with Google</span>
              </>
            )}
          </button>

          <div className="mt-10 pt-8 border-t border-gray-100">
            {process.env.NEXT_PUBLIC_API_URL?.includes('localhost') || process.env.NODE_ENV === 'development' ? (
              <div className="mb-8">
                <p className="text-xs text-gray-500 font-semibold mb-3">DEV MODE QUICK LOGIN</p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => signIn('credentials', { email: 'omeshmehta70@gmail.com', callbackUrl: '/login' })}
                    className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 py-2 rounded-lg font-medium transition-colors"
                  >
                    As Super Admin
                  </button>
                  <button
                    onClick={() => signIn('credentials', { email: 'omeshmehta03@gmail.com', callbackUrl: '/login' })}
                    className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 py-2 rounded-lg font-medium transition-colors"
                  >
                    As App Admin
                  </button>
                </div>
              </div>
            ) : null}

            <p className="text-xs text-gray-400 text-center mb-4">
              Access is restricted to authorized administrators only.
            </p>
            <div className="grid grid-cols-1 gap-3">
              <div className="flex items-center gap-3 p-3 rounded-lg bg-blue-100 border border-blue-100">
                <div>
                  <p className="text-xs font-semibold text-gray-900">Super Admin</p>
                  <p className="text-[10px] text-gray-500">Aggregated cloud-level overview</p>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-lg bg-gray-100 border border-gray-100">
                <div>
                  <p className="text-xs font-semibold text-gray-900">App Admin</p>
                  <p className="text-[10px] text-gray-500">Full detailed analytics for assigned app</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
