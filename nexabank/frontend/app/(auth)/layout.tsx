import type React from "react";
import Link from "next/link";
import { Shield, Lock, CreditCard, ChartBar } from "lucide-react";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col md:flex-row">
      {/* Decorative Side Panel - Visible on md and larger screens */}
      <div className="hidden md:flex md:w-1/2 bg-violet-700 text-white relative overflow-hidden">
        {/* Background shapes */}
        <div className="absolute inset-0 opacity-20">
          <div className="absolute top-0 left-0 w-64 h-64 bg-violet-500 rounded-full filter blur-3xl -translate-x-1/2 -translate-y-1/2"></div>
          <div className="absolute bottom-0 right-0 w-96 h-96 bg-violet-800 rounded-full filter blur-3xl translate-x-1/4 translate-y-1/4"></div>
        </div>

        {/* Content */}
        <div className="w-full h-full flex flex-col justify-center items-center p-12 relative z-10">
          <div className="max-w-xl text-center">
            <div className="flex justify-center mb-8">
              <div className="h-16 w-16 rounded-xl bg-white/10 backdrop-blur-sm flex items-center justify-center shadow-lg">
                <Shield className="h-10 w-10 text-white" />
              </div>
            </div>
            <h1 className="text-4xl font-bold mb-6">Welcome to NexaBank</h1>
            <p className="text-xl text-violet-100 mb-8">
              Secure, simple banking for a complex world. Manage your finances
              with confidence.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-12">
              <div className="p-5 rounded-xl bg-white/10 backdrop-blur-sm border border-white/5 flex flex-col items-center justify-center">
                <div className="h-10 w-10 rounded-full bg-violet-600/30 flex items-center justify-center mb-3">
                  <Lock className="h-5 w-5 text-white" />
                </div>
                <h3 className="font-medium text-white">Secure Banking</h3>
                <p className="text-xs text-violet-100 mt-1">
                  Advanced encryption & protection
                </p>
              </div>

              <div className="p-5 rounded-xl bg-white/10 backdrop-blur-sm border border-white/5 flex flex-col items-center justify-center">
                <div className="h-10 w-10 rounded-full bg-violet-600/30 flex items-center justify-center mb-3">
                  <CreditCard className="h-5 w-5 text-white" />
                </div>
                <h3 className="font-medium text-white">Digital Cards</h3>
                <p className="text-xs text-violet-100 mt-1">
                  Manage all your cards in one place
                </p>
              </div>

              <div className="p-5 rounded-xl bg-white/10 backdrop-blur-sm border border-white/5 flex flex-col items-center justify-center">
                <div className="h-10 w-10 rounded-full bg-violet-600/30 flex items-center justify-center mb-3">
                  <ChartBar className="h-5 w-5 text-white" />
                </div>
                <h3 className="font-medium text-white">Smart Analytics</h3>
                <p className="text-xs text-violet-100 mt-1">
                  Track spending & financial insights
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Form Area */}
      <div className="w-full md:w-1/2 bg-gradient-to-b from-gray-50 to-white flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          {/* Brand for mobile view */}
          <div className="md:hidden flex items-center justify-center mb-8">
            <Link href="/" className="flex items-center space-x-2">
              <div className="h-10 w-10 rounded-xl bg-violet-600 flex items-center justify-center">
                <Shield className="h-6 w-6 text-white" />
              </div>
              <span className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-violet-600 to-violet-400">
                NexaBank
              </span>
            </Link>
          </div>

          {children}

          <div className="mt-8 text-center">
            <Link
              href="/"
              className="text-sm text-gray-500 hover:text-violet-600 transition-colors"
            >
              ← Back to home
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
