'use client';

import { useSession, signOut } from 'next-auth/react';
import { ShieldAlert, LogOut, ExternalLink } from 'lucide-react';

export default function UnauthorizedPage() {
  const { data: session } = useSession();

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 p-6 selection:bg-blue-100 selection:text-blue-900">
      <div className="bg-white border border-red-100 p-8 rounded-2xl shadow-xl max-w-md w-full text-center">
        <div className="flex justify-center mb-6">
          <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center">
            <ShieldAlert className="w-8 h-8 text-red-500" />
          </div>
        </div>
        
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Dashboard Access Denied</h1>
        <p className="text-gray-500 mb-2">
          Your account <strong className="text-gray-800">{session?.user?.email}</strong> does not have administrator permissions for the analytics dashboard.
        </p>
        <p className="text-gray-400 text-sm mb-6">
          Only authorized App Admins and Company Admins can access this area.
        </p>
        
        <div className="space-y-3">
          <a
            href={process.env.NEXT_PUBLIC_MAIN_APP_URL || "http://localhost:3002"}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white p-3 rounded-lg transition-colors font-medium"
          >
            <ExternalLink className="w-4 h-4" />
            Go to Main App
          </a>
          
          <button
            onClick={() => signOut({ callbackUrl: '/login' })}
            className="w-full flex items-center justify-center gap-2 bg-gray-100 hover:bg-gray-100 text-gray-700 p-3 rounded-lg transition-colors font-medium"
          >
            <LogOut className="w-4 h-4" />
            Sign Out &amp; Switch Account
          </button>
        </div>

        <div className="mt-6 p-3 bg-gray-100 rounded-lg border border-gray-100">
          <p className="text-[11px] text-gray-400">
            <strong>Need access?</strong> Contact your organization administrator to request App Admin or Company Admin privileges.
          </p>
        </div>
      </div>
    </div>
  );
}
