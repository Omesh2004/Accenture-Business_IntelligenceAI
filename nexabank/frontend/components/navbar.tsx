"use client"

import type React from "react"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { BarChart3, Menu, User, Wallet } from "lucide-react"
import axios from "axios"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { TenantIndicator } from "@/components/TenantIndicator"
import { useGeoLocation } from "@/hooks/useGeoLocation"
import { UserData } from "@/components/context/UserContext"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Sheet, SheetContent, SheetTrigger, SheetTitle, SheetHeader } from "@/components/ui/sheet"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { API_BASE_URL } from "@/lib/api"
import Image from "next/image"
import { Badge } from "./ui/badge"

export function Navbar() {
  const pathname = usePathname()
  const { userId, role, isAuth } = UserData()
  const analyticsDashboardBase = (process.env.NEXT_PUBLIC_DASHBOARD_URL || "http://localhost:3001").replace(/\/$/, "")

  useGeoLocation(userId, isAuth)

  const isAuthPage = pathname?.includes("/login") || pathname?.includes("/register")
  const isHomePage = pathname === "/"

  const handleLogout = async () => {
    try {
      await axios.post(`${API_BASE_URL}/auth/logout`, {}, { withCredentials: true })
      toast.success("Logged out successfully")
      window.location.href = "/login" // Force full reload to wipe React auth state
    } catch (error) {
      console.error("Logout failed:", error)
      toast.error("Failed to log out")
    }
  }

  if (isAuthPage) return null

  const pages = [
    { name: "Dashboard", href: "/dashboard" },
    { name: "Accounts", href: "/accounts" },
    { name: "Transactions", href: "/transactions" },
    { name: "Payees", href: "/payees" },
    { name: "Loans", href: "/loans" },
  ]

  const proPages = [
    { name: "Finance Library", href: "/pro-feature?id=ai-insights", pro: true },
    { name: "Crypto Trading", href: "/pro-feature?id=crypto-trading", pro: true },
    { name: "Wealth Mgmt", href: "/pro-feature?id=wealth-management-pro", pro: true },
    { name: "Payroll Pro", href: "/pro-feature?id=bulk-payroll-processing", pro: true },
  ]

  return (
    <header
      className={`sticky top-0 z-50 w-full border-b ${isHomePage ? "bg-transparent border-transparent" : "bg-background border-border"}`}
    >
      <div className="container mx-auto px-4 md:px-6 flex h-16 items-center justify-between">
        <div className="flex items-center gap-2 md:gap-4">
          {!isHomePage && (
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open Menu">
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="p-0 bg-white">
                <div className="h-full flex flex-col">
                  <div className="p-6 border-b border-sidebar-border">
                    <div className="flex items-center gap-2">
                      <SheetHeader><SheetTitle>
                        <div className="flex justify-center items-center gap-2">
                          <Image src="/logo.png" alt="Logo" width={36} height={36} className="rounded-full" />
                          <span className="font-bold text-xl">NexaBank</span>
                        </div>
                      </SheetTitle></SheetHeader>
                    </div>
                  </div>
                  <div className="flex-1 overflow-auto py-2">
                    <nav className="grid gap-1 px-2">
                      {pages.map((page) => (
                        <Link
                          key={page.name}
                          href={page.href}
                          className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${pathname === page.href
                            ? "bg-primary text-primary-foreground"
                            : "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                            }`}
                        >
                          {page.name}
                        </Link>
                      ))}
                      <div className="mt-4 mb-2 px-3 text-xs font-semibold text-muted-foreground uppercase tracking-widest">
                        ✨ Pro Features
                      </div>
                      {proPages.map((page) => (
                        <Link
                          key={page.name}
                          href={page.href}
                          className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${pathname === page.href
                            ? "bg-primary text-primary-foreground"
                            : "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                            }`}
                        >
                          {page.name}
                          <Badge variant="secondary" className="bg-amber-100 text-amber-800 text-[9px] px-1.5 py-0 h-4 uppercase tracking-widest border-0 ml-auto">Pro</Badge>
                        </Link>
                      ))}
                    </nav>
                  </div>
                </div>
              </SheetContent>
            </Sheet>
          )}

          <Link href={isHomePage ? "/" : "/dashboard"} className="flex items-center gap-2">
            <Image src="/logo.png" alt="Logo" width={36} height={36} className="rounded-full" />
            <span className={`font-bold text-xl tracking-tight ${isHomePage ? "text-white" : "text-zinc-900"}`}>NexaBank</span>
          </Link>

          {!isHomePage && (
            <div className="ml-4 flex items-center">
              <TenantIndicator />
            </div>
          )}

          {!isHomePage && (
            <nav className="hidden md:flex items-center gap-6 ml-6">
              {pages.map((page) => (
                <Link
                  key={page.name}
                  href={page.href}
                  className={`text-sm font-medium transition-colors hover:text-foreground flex items-center gap-1 ${pathname === page.href ? "text-nav hover:text-nav" : "text-muted-foreground"
                    }`}
                >
                  {page.name}
                </Link>
              ))}
              <DropdownMenu>
                <DropdownMenuTrigger className={`text-sm font-medium transition-colors hover:text-foreground flex items-center gap-1 text-muted-foreground outline-none`}>
                  ✨ Pro Features
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  {proPages.map((page) => (
                    <DropdownMenuItem key={page.name} asChild>
                      <Link href={page.href} className="w-full flex justify-between items-center cursor-pointer">
                        {page.name}
                        <Badge variant="secondary" className="bg-amber-100 text-amber-800 text-[9px] px-1 py-0 h-4 uppercase tracking-widest border-0 ml-2">Pro</Badge>
                      </Link>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </nav>
          )}
        </div>

        <div className="flex items-center gap-2">
          {!isHomePage && (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="rounded-full overflow-hidden border border-violet-200" aria-label="User menu">
                    <Avatar className="h-8 w-8 hover:scale-110 transition-transform">
                      <AvatarImage src="/user.png" alt="User Profile" />
                      <AvatarFallback className="bg-violet-100 text-violet-700 font-bold">AK</AvatarFallback>
                    </Avatar>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <div className="flex items-center justify-center">
                    <DropdownMenuLabel>My Account</DropdownMenuLabel>

                    {role === "ADMIN" && (
                      <Link href="/admin/loans">
                        <Badge className="bg-zinc-900 text-white cursor-pointer text-[10px] uppercase font-semibold px-2 py-0.5 rounded-md tracking-wider transition-colors">
                          Admin
                        </Badge>
                      </Link>
                    )}
                  </div>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link href="/profile" className="cursor-pointer">
                      <User className="mr-2 h-4 w-4" />
                      Profile
                    </Link>
                  </DropdownMenuItem>
                  {role === "ADMIN" && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel className="text-[10px] font-black text-muted-foreground uppercase tracking-widest px-2 py-1">Admin Control</DropdownMenuLabel>
                      <DropdownMenuItem asChild>
                        <Link href="/admin/loans" className="cursor-pointer">
                          Loan Queue
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href="/admin/feature-toggles" className="cursor-pointer">
                          Feature Toggles
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href="/admin/simulate" className="cursor-pointer">
                          Simulate Users
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel className="text-[10px] font-black text-muted-foreground uppercase tracking-widest px-2 py-1">FinInsightsPlatform</DropdownMenuLabel>
                      <DropdownMenuItem asChild>
                        <a href={`${analyticsDashboardBase}/nexabank/dashboard`} target="_blank" rel="noopener noreferrer" className="cursor-pointer">
                          <BarChart3 className="mr-2 h-4 w-4" />
                          Analytics Dashboard
                        </a>
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="cursor-pointer text-rose-600 focus:text-rose-700 focus:bg-rose-50" onClick={handleLogout}>
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}

          {isHomePage && (
            <div className="flex items-center gap-2">
              <Button asChild variant="ghost" className="text-white hover:bg-white/10">
                <Link href="/login">Sign In</Link>
              </Button>
              <Button asChild className="bg-white text-purple-700 hover:bg-gray-100">
                <Link href="/register">Get Started</Link>
              </Button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}

