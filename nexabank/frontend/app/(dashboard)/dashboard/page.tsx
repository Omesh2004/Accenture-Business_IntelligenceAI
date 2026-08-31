"use client"

import { useState, useEffect, useMemo } from "react"
import { ArrowDown, ArrowRightLeft, ArrowUp, DollarSign, Wallet } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import AnalyticsSection from "@/components/sections/AnalyticsSection"
import { UserData } from "@/components/context/UserContext"
import { useRouter } from "next/navigation"
import axios from "axios"
import { API_BASE_URL } from "@/lib/api"
import Link from "next/link"
import { Skeleton } from "@/components/ui/skeleton"
import { useEventTracker } from "@/hooks/useEventTracker"

export default function DashboardPage() {
  const { track } = useEventTracker();
  const { userId, isAuth, isAuthLoading, globalAccounts, fetchGlobalAccounts } = UserData();
  const router = useRouter()
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("overview")
  const [transactions, setTransactions] = useState<any[]>([])

  // Track page view on mount
  useEffect(() => {
    track('dashboard.page.view');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Accounts are auto-fetched in Auth() — just wait for them and load transactions
  useEffect(() => {
    if (isAuthLoading) return; // Still waiting for auth
    if (!isAuth) return; // Not authenticated

    let isMounted = true;
    const loadTransactions = async () => {
       try {
          // Use the new customer-wide endpoint instead of single account
          const transRes = await axios.get(`${API_BASE_URL}/byCustomer/${userId}`, {
            withCredentials: true
          });
          if (isMounted) setTransactions(transRes.data || []);
       } catch (error) {
          console.error("Failed to load transactions", error);
       }
       if (isMounted) setLoading(false);
    };
    loadTransactions();
    return () => { isMounted = false; };
  }, [userId, isAuth, isAuthLoading]);

  // Safe calculation of analytics from transactions
  const { monthlyIncome, monthlyExpenses, savingsRate } = useMemo(() => {
    const userAccNos = new Set(globalAccounts.map(a => a.accNo));
    let inc = 0;
    let exp = 0;

    // Filter transactions from the last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    transactions.forEach(tx => {
       const txDate = new Date(tx.timestamp || tx.createdOn);
       if (txDate < thirtyDaysAgo) return;

       const amount = tx.amount || 0;
       const isSender = userAccNos.has(tx.senderAccNo);
       const isReceiver = userAccNos.has(tx.receiverAccNo);

       if (isReceiver && isSender) {
          // Internal transfer, ignore from income/expense
       } else if (isReceiver) {
          inc += amount;
       } else if (isSender) {
          exp += amount;
       }
    });

    const rate = inc > 0 ? Math.max(0, Math.min(100, ((inc - exp) / inc) * 100)) : 0;

    return { monthlyIncome: inc, monthlyExpenses: exp, savingsRate: rate };
  }, [transactions, globalAccounts]);

  if (loading || isAuthLoading || !isAuth) {
    return (
      <div className="flex flex-col gap-8 animate-fade-in">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <Skeleton className="h-10 w-48 rounded-lg bg-zinc-200 mb-2" />
            <Skeleton className="h-5 w-64 rounded bg-zinc-100" />
          </div>
          <div className="flex gap-3">
            <Skeleton className="h-10 w-48 rounded-full bg-zinc-200" />
            <Skeleton className="h-10 w-40 rounded-full bg-zinc-200" />
          </div>
        </div>

        <Skeleton className="h-10 w-64 rounded-lg bg-zinc-200" />

        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
             <Card key={i} className="border border-violet-100 shadow-sm">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                   <Skeleton className="h-4 w-24 rounded bg-zinc-200" />
                   <Skeleton className="h-8 w-8 rounded-full bg-zinc-200" />
                </CardHeader>
                <CardContent>
                   <Skeleton className="h-8 w-32 rounded bg-zinc-200 mb-2" />
                   <Skeleton className="h-3 w-20 rounded bg-zinc-100" />
                </CardContent>
             </Card>
          ))}
        </div>

        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-7">
           <Card className="col-span-4 border border-violet-100 shadow-sm">
             <CardContent className="pt-6">
               <Skeleton className="h-8 w-48 rounded bg-zinc-200 mb-6" />
               <div className="space-y-4">
                 {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-12 w-full rounded bg-zinc-100" />
                 ))}
               </div>
             </CardContent>
           </Card>
           <Card className="col-span-3 border border-violet-100 shadow-sm">
             <CardContent className="pt-6 space-y-4">
               <Skeleton className="h-8 w-40 rounded bg-zinc-200 mb-4" />
               {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-24 w-full rounded-xl bg-zinc-100" />
               ))}
             </CardContent>
           </Card>
        </div>
      </div>
    );
  }

  const totalBalance = globalAccounts.reduce((sum: number, acc: any) => sum + (acc.balance || 0), 0);

  return (
    <div className="flex flex-col gap-8 animate-fade-in">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900">Dashboard</h1>
          <p className="text-muted-foreground mt-1">Here's an overview of your finances.</p>
        </div>
        <div className="flex gap-3">
          <Button asChild className="rounded-full bg-violet-600 hover:bg-violet-700 text-white shadow-md hover:shadow-lg cursor-pointer transition-all">
            <Link href="/accounts">
              <ArrowUp className="mr-2 h-4 w-4" />
              Transfer Money
            </Link>
          </Button>
        </div>
      </div>

      <Tabs defaultValue="overview" className="space-y-6" onValueChange={(tab) => {
          setActiveTab(tab);
          track(tab === 'analytics' ? 'dashboard.analytics_tab.view' : 'dashboard.overview.view');
        }}>
        <TabsList className="bg-violet-50/50 p-1 border border-violet-100 rounded-lg inline-flex">
          <TabsTrigger value="overview" className="rounded-md cursor-pointer data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-violet-700">Overview</TabsTrigger>
          <TabsTrigger value="analytics" className="rounded-md cursor-pointer data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-violet-700">Analytics</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="space-y-6 mt-0">
          {/* Overview Cards */}
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            <Card className="border-0 shadow-md bg-gradient-to-br from-violet-600 to-purple-700 text-white relative overflow-hidden transition-transform hover:-translate-y-1 duration-300">
              <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full filter blur-2xl -translate-y-1/2 translate-x-1/4"></div>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 relative z-10">
                <CardTitle className="text-sm font-medium text-white/80">Total Balance</CardTitle>
                <Wallet className="h-5 w-5 text-white/80" />
              </CardHeader>
              <CardContent className="relative z-10">
                <div className="text-3xl font-bold">₹{totalBalance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
                <p className="text-xs text-white/70 mt-1">Available across {globalAccounts.length} accounts</p>
              </CardContent>
            </Card>

            <Card className="border border-violet-100 shadow-sm hover:shadow-md transition-all duration-300">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-gray-500">Income</CardTitle>
                <div className="h-8 w-8 rounded-full bg-emerald-100 flex items-center justify-center">
                  <ArrowDown className="h-4 w-4 text-emerald-600" />
                </div>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-zinc-900">₹{monthlyIncome.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
                <p className="text-xs text-muted-foreground mt-1">Last 30 days</p>
              </CardContent>
            </Card>

            <Card className="border border-violet-100 shadow-sm hover:shadow-md transition-all duration-300">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-gray-500">Expenses</CardTitle>
                <div className="h-8 w-8 rounded-full bg-rose-100 flex items-center justify-center">
                  <ArrowUp className="h-4 w-4 text-rose-600" />
                </div>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-zinc-900">₹{monthlyExpenses.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
                <p className="text-xs text-muted-foreground mt-1">Last 30 days</p>
              </CardContent>
            </Card>

            <Card className="border border-violet-100 shadow-sm hover:shadow-md transition-all duration-300">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-gray-500">Savings Rate</CardTitle>
                <div className="h-8 w-8 rounded-full bg-blue-100 flex items-center justify-center">
                  <DollarSign className="h-4 w-4 text-blue-600" />
                </div>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-zinc-900">{savingsRate.toFixed(1)}%</div>
                <p className="text-xs text-muted-foreground mt-1">Savings from income</p>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-7">
            {/* Recent Transactions */}
            <Card className="col-span-4 border border-violet-100 shadow-sm flex flex-col h-full">
              <CardHeader className="border-b border-gray-50 pb-4 shrink-0">
                <CardTitle className="text-lg text-zinc-900">Recent Transactions</CardTitle>
                <CardDescription>Your latest financial activity.</CardDescription>
              </CardHeader>
              <CardContent className="pt-6 flex-1 flex flex-col justify-start">
                {transactions.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10 text-center">
                    <div className="h-16 w-16 bg-violet-50 rounded-full flex items-center justify-center mb-4">
                      <ArrowRightLeft className="h-6 w-6 text-violet-400" />
                    </div>
                    <h3 className="font-semibold text-zinc-900 mb-1">No transactions yet</h3>
                    <p className="text-sm text-muted-foreground max-w-sm">
                      When you transfer money or receive payments, they will appear here.
                    </p>
                    <Button asChild variant="outline" className="mt-6 rounded-full cursor-pointer hover:bg-violet-50 hover:text-violet-700">
                      <Link href="/accounts">Make a Transfer</Link>
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="overflow-x-auto rounded-xl border border-gray-100 shadow-sm">
                      <table className="w-full text-sm text-left">
                        <thead className="bg-gray-100/80 text-xs uppercase font-semibold text-zinc-500 border-b border-gray-100">
                          <tr>
                            <th className="px-4 py-3 text-center w-12 border-r border-gray-100">#</th>
                            <th className="px-4 py-3">Account</th>
                            <th className="px-4 py-3">Date</th>
                            <th className="px-4 py-3 text-right">Amount</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50 bg-white">
                          {(transactions || []).slice(0, 10).map((transaction, index) => {
                            const isSender = globalAccounts.some(a => a.accNo === transaction.senderAccNo);
                            const isReceiver = globalAccounts.some(a => a.accNo === transaction.receiverAccNo);
                            
                            const isInternal = isSender && isReceiver;
                            const isIncome = !isSender || (isInternal && false); // For internal, we can display as expense or gray out
                            const displayAccount = isInternal 
                              ? `Internal: ${transaction.senderAccNo.slice(-4)} -> ${transaction.receiverAccNo.slice(-4)}`
                              : isSender 
                                ? (transaction.receiverAccount?.accNo || transaction.receiverAccNo || "External")
                                : (transaction.senderAccount?.accNo || transaction.senderAccNo || "External");

                            return (
                              <tr key={transaction.id || index} className="hover:bg-violet-50/30 transition-colors group cursor-pointer">
                                <td className="px-4 py-3 text-center text-muted-foreground font-medium border-r border-gray-100/50 group-hover:bg-violet-50/50">
                                  {index + 1}
                                </td>
                                <td className="px-4 py-3 font-medium text-zinc-900 group-hover:text-violet-700 transition-colors">
                                  {displayAccount}
                                </td>
                                <td className="px-4 py-3 text-muted-foreground">
                                  {new Date(transaction.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                                </td>
                                <td className={`px-4 py-3 text-right font-semibold ${isInternal ? 'text-gray-500' : isIncome ? 'text-emerald-600' : 'text-rose-600'}`}>
                                  {isInternal ? '' : isIncome ? '+' : '-'}₹{transaction.amount.toLocaleString('en-IN')}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="mt-auto pt-4 shrink-0">
                      <Button asChild variant="ghost" className="w-full text-violet-600 hover:text-violet-700 hover:bg-violet-50 cursor-pointer text-xs font-bold uppercase tracking-widest">
                        <Link href="/transactions">View all transactions &rarr;</Link>
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
            
            {/* Accounts Summary Panel */}
            <Card className="col-span-3 border border-violet-100 shadow-sm bg-gray-100/50 flex flex-col h-full">
              <CardHeader className="border-b border-gray-50 pb-4 bg-white/50 backdrop-blur-sm rounded-t-xl">
                <CardTitle className="text-lg text-zinc-900">Your Accounts</CardTitle>
                <CardDescription>Active bank accounts and balances</CardDescription>
              </CardHeader>
              <CardContent className="pt-6 space-y-4">
                {globalAccounts.length === 0 ? (
                  <div className="text-center py-6 text-muted-foreground text-sm">
                    No active accounts found.
                  </div>
                ) : (
                  globalAccounts.map((acc, i) => (
                    <div key={i} className="flex flex-col p-4 bg-white border border-gray-100 rounded-xl shadow-sm hover:shadow-md transition-shadow cursor-pointer">
                      <div className="flex justify-between items-center mb-2">
                        <div className="flex items-center gap-2">
                          <Wallet className="h-4 w-4 text-violet-600" />
                          <span className="font-semibold text-sm text-zinc-900">{acc.accountType}</span>
                        </div>
                        <span className="text-xs px-2 py-0.5 bg-violet-100 text-violet-700 rounded-full font-medium">Active</span>
                      </div>
                      <div className="text-xs text-muted-foreground font-mono mb-3">{acc.ifsc} • {acc.accNo?.slice(-4) || 'XXXX'}</div>
                      <div className="text-xl font-bold text-zinc-900">₹{acc.balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
                    </div>
                  ))
                )}
                <Button asChild variant="ghost" className="w-full text-violet-600 hover:text-violet-700 hover:bg-violet-50 cursor-pointer mt-2">
                  <Link href="/accounts">Manage Accounts</Link>
                </Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
        
        <TabsContent value="analytics" className="space-y-4 mt-0">
          <Card className="border border-violet-100 shadow-sm">
            <CardHeader className="border-b border-gray-50 pb-4">
              <CardTitle className="text-2xl text-zinc-900">Analytics</CardTitle>
              <CardDescription>View detailed analytics of your spending patterns.</CardDescription>
            </CardHeader>
            <CardContent className="flex justify-center pt-8 pb-10">
              <AnalyticsSection accounts={globalAccounts} transactions={transactions} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      
      {/* Import to fix breaking undefined error initially */}
      <ArrowRightLeft className="hidden" />
    </div>
  )
}
