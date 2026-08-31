import type React from "react"
import { BankSidebar } from "@/components/bank-sidebar"
import { Navbar } from "@/components/navbar"

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="flex">
        <BankSidebar />
        <div className="flex mx-auto flex-col flex-1 container p-4 md:p-6">
          <main className="flex-1">{children}</main>
        </div>
      </div>
    </div>
  )
}

