'use client';

import { useEffect, useState } from 'react';
import { CreditCard, PlusCircle, ArrowRightLeft, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import TransferModal from '@/components/modals/TransferModal';
import OpenAccountModal from '@/components/modals/OpenAccountModal';
import { toast } from "sonner";
import { useRouter } from 'next/navigation';
import { UserData } from '@/components/context/UserContext';
import axios from 'axios';
import { Skeleton } from "@/components/ui/skeleton";
import { API_BASE_URL } from '@/lib/api';
import { useEventTracker } from '@/hooks/useEventTracker';


const Accounts = () => {
  const { track } = useEventTracker();
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [showOpenAccountModal, setShowOpenAccountModal] = useState(false);
  const { isAuth, isAuthLoading, userId, globalAccounts, fetchGlobalAccounts } = UserData();
  const router = useRouter();
  
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isAuth) {
      if (!isAuthLoading) router.push("/login");
    }
  }, [isAuth, isAuthLoading, router]);

  // Track page view
  useEffect(() => {
    if (isAuth && !isAuthLoading) {
      track('accounts.page.view');
    }
  }, [isAuth, isAuthLoading]);

  // Derive local state from global accounts (auto-fetched in Auth)
  useEffect(() => {
    if (!isAuthLoading && isAuth) {
      setLoading(false);
    }
  }, [isAuthLoading, isAuth, globalAccounts]);


  // rawAccounts for TransferModal
  const rawAccounts = globalAccounts;

  // Map global accounts to UI format
  const accounts = (globalAccounts || []).map((acc: any) => ({
    id: acc.accNo,
    name: acc.accountType,
    number: acc.accNo || "XXXXX",
    balance: acc.balance,
    type: acc.accountType.toLowerCase(),
    isMain: acc.accountType === 'SAVINGS' || acc.accountType === 'MAIN',
    ifsc: acc.ifsc
  }));

  const refreshAccounts = async () => {
    await fetchGlobalAccounts(userId);
  };



  if (loading || isAuthLoading || !isAuth) {
    return (
      <div className="space-y-8 animate-fade-in">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <Skeleton className="h-10 w-48 rounded-lg bg-zinc-200 mb-2" />
            <Skeleton className="h-5 w-64 rounded bg-zinc-100" />
          </div>
          <div className="flex gap-3">
            <Skeleton className="h-10 w-40 rounded-full bg-zinc-200" />
            <Skeleton className="h-10 w-40 rounded-full bg-zinc-200" />
          </div>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          {Array.from({ length: 4 }).map((_, i) => (
             <Card key={i} className="border border-violet-100 shadow-sm overflow-hidden">
                <CardContent className="p-6 space-y-3">
                   <Skeleton className="h-4 w-24 bg-zinc-200 rounded" />
                   <Skeleton className="h-8 w-32 bg-zinc-200 rounded" />
                   <Skeleton className="h-3 w-40 bg-zinc-100 rounded" />
                </CardContent>
             </Card>
          ))}
        </div>

        <Skeleton className="h-12 max-w-xl rounded-xl bg-zinc-200" />

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {Array.from({ length: 3 }).map((_, i) => (
             <Card key={i} className="h-[220px] border border-violet-100 shadow-sm">
                <CardContent className="p-5 h-full flex flex-col justify-between">
                   <div className="flex justify-between items-start">
                     <div className="flex gap-3">
                        <Skeleton className="h-10 w-10 rounded-lg bg-zinc-200" />
                        <div className="space-y-2">
                           <Skeleton className="h-4 w-24 bg-zinc-200 rounded" />
                           <Skeleton className="h-3 w-32 bg-zinc-100 rounded" />
                        </div>
                     </div>
                   </div>
                   <div className="space-y-2">
                     <Skeleton className="h-3 w-28 bg-zinc-200 rounded" />
                     <Skeleton className="h-8 w-40 bg-zinc-200 rounded" />
                   </div>
                   <div className="flex gap-3 mt-4">
                     <Skeleton className="h-8 flex-1 rounded-lg bg-zinc-200" />
                     <Skeleton className="h-8 flex-1 rounded-lg bg-zinc-200" />
                   </div>
                </CardContent>
             </Card>
          ))}
        </div>
      </div>
    );
  }

  const totalBalance = accounts.reduce((sum, account) => sum + account.balance, 0);
  
  const checkingAccounts = accounts.filter(account => account.type.includes('current') || account.type.includes('checking'));
  const savingsAccounts = accounts.filter(account => account.type.includes('saving'));
  const investmentAccounts = accounts.filter(account => account.type.includes('credit'));
  const loanAccounts = accounts.filter(account => account.type.includes('loan'));

  const formatBalance = (balance: number) => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 2,
    }).format(Math.abs(balance));
  };
  
  const renderAccountCards = (accountsList: any[]) => {
    if (accountsList.length === 0) {
       return (
         <Card className="border-dashed border-2 p-8 text-center bg-gray-100 flex items-center justify-center min-h-[200px]">
           <p className="text-muted-foreground">No accounts found in this category.</p>
         </Card>
       )
     }

    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {accountsList.map((account, idx) => (
          <Card key={account.id || idx} className="h-auto border border-violet-100 shadow-sm hover:shadow-lg transition-all duration-300">
            <CardContent className="p-5">
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center">
                  <div>
                    <h3 className="font-semibold text-zinc-900 capitalize cursor-default">{account.name.toLowerCase()}</h3>
                    <p className="text-xs font-mono text-muted-foreground tracking-widest">{account.number.replace(/(.{4})/g, '$1 ')}</p>
                  </div>
                </div>
                {account.isMain && (
                  <span className="px-3 py-1 bg-violet-100 text-violet-800 rounded-full text-[10px] font-bold uppercase tracking-wider">
                    Primary
                  </span>
                )}
              </div>
              
              <div className="mt-4 bg-gray-100 p-4 rounded-xl">
                <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold mb-1">Available Balance</p>
                <p className={`text-2xl font-bold tracking-tight ${account.balance < 0 ? 'text-rose-600' : 'text-zinc-900'}`}>
                  {account.balance < 0 ? '-' : ''}{formatBalance(account.balance)}
                </p>
              </div>
              
              <div className="mt-5 flex gap-3">
                <Button size="sm" className="flex-1 rounded-lg bg-violet-600 hover:bg-violet-700 cursor-pointer" onClick={() => setShowTransferModal(true)}>Transfer</Button>
              </div>
            </CardContent>
          </Card>
        ))}
        <Card 
          onClick={() => setShowOpenAccountModal(true)} 
          className="h-auto border-dashed border-2 hover:border-violet-300 transition-colors flex items-center justify-center p-5 bg-gray-100 hover:bg-violet-50/30 cursor-pointer group"
        >
          <div className="flex flex-col items-center justify-center py-6">
            <div className="h-12 w-12 rounded-full bg-violet-100 flex items-center justify-center mb-3 group-hover:scale-110 transition-transform">
               <PlusCircle className="h-6 w-6 text-violet-600" />
            </div>
            <p className="font-semibold text-zinc-700 group-hover:text-violet-700 transition-colors">Create New Account</p>
          </div>
        </Card>
      </div>
    );
  };

  return (
    <div className="space-y-8 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-zinc-900 tracking-tight">Accounts</h1>
          <p className="text-muted-foreground mt-1">Manage your active bank accounts and balances.</p>
        </div>
        <div className="flex gap-3">
          <Button 
            variant="outline" 
            className="gap-2 rounded-full cursor-pointer hover:shadow-sm"
            onClick={() => setShowTransferModal(true)}
          >
            <ArrowRightLeft className="h-4 w-4" />
            <span>Transfer Money</span>
          </Button>
          <Button className="gap-2 rounded-full bg-violet-600 hover:bg-violet-700 shadow-md hover:shadow-lg cursor-pointer" onClick={() => setShowOpenAccountModal(true)}>
            <PlusCircle className="h-4 w-4" />
            <span>Open Account</span>
          </Button>
        </div>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card className="border-0 shadow-md bg-gradient-to-br from-violet-600 to-purple-700 text-white relative overflow-hidden transition-transform hover:-translate-y-1 duration-300">
          <div className="absolute top-0 right-0 w-24 h-24 bg-white/10 rounded-full filter blur-xl -translate-y-1/2 translate-x-1/4"></div>
          <CardHeader className="pb-2 relative z-10">
            <CardTitle className="text-sm text-white/80 font-medium">Total Balance</CardTitle>
          </CardHeader>
          <CardContent className="relative z-10">
            <div className="text-3xl font-bold tracking-tight">{formatBalance(totalBalance)}</div>
            <p className="text-xs text-white/70 mt-1">Across {accounts.length} active accounts</p>
          </CardContent>
        </Card>
        
        <Card className="border border-violet-100 shadow-sm hover:shadow-md transition-all">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground font-medium">Savings Details</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-zinc-900">
              {formatBalance(savingsAccounts.reduce((sum, account) => sum + account.balance, 0))}
            </div>
            <p className="text-xs text-muted-foreground mt-1">{savingsAccounts.length} savings accounts</p>
          </CardContent>
        </Card>

        <Card className="border border-violet-100 shadow-sm hover:shadow-md transition-all">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground font-medium">Current Details</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-zinc-900">
              {formatBalance(checkingAccounts.reduce((sum, account) => sum + account.balance, 0))}
            </div>
            <p className="text-xs text-muted-foreground mt-1">{checkingAccounts.length} current accounts</p>
          </CardContent>
        </Card>
        
        <Card className="border border-violet-100 shadow-sm hover:shadow-md transition-all">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground font-medium">Loans / Invest</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-zinc-900">
              {formatBalance(investmentAccounts.reduce((sum, account) => sum + account.balance, 0) + loanAccounts.reduce((sum, acc) => sum + acc.balance, 0))}
            </div>
            <p className="text-xs text-muted-foreground mt-1">{investmentAccounts.length + loanAccounts.length} linked accounts</p>
          </CardContent>
        </Card>
      </div>
      
      <Tabs defaultValue="all" className="w-full">
        <TabsList className="mb-8 grid grid-cols-4 max-w-xl bg-violet-50/50 p-1 border border-violet-100 rounded-xl">
          <TabsTrigger value="all" className="rounded-lg cursor-pointer data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-violet-700">All Accounts</TabsTrigger>
          <TabsTrigger value="savings" className="rounded-lg cursor-pointer data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-violet-700">Savings</TabsTrigger>
          <TabsTrigger value="checking" className="rounded-lg cursor-pointer data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-violet-700">Current</TabsTrigger>
          <TabsTrigger value="other" className="rounded-lg cursor-pointer data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-violet-700">Credit Card</TabsTrigger>
        </TabsList>
        
        <TabsContent value="all" className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-500">
          {renderAccountCards(accounts)}
        </TabsContent>
        
        <TabsContent value="savings" className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-500">
          {renderAccountCards(savingsAccounts)}
        </TabsContent>
        
        <TabsContent value="checking" className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-500">
          {renderAccountCards(checkingAccounts)}
        </TabsContent>
        
        <TabsContent value="other" className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-500">
          {renderAccountCards([...investmentAccounts, ...loanAccounts])}
        </TabsContent>
      </Tabs>
      
      <TransferModal
        isOpen={showTransferModal}
        onClose={() => setShowTransferModal(false)}
        accounts={rawAccounts}
        onSuccess={refreshAccounts}
      />
      <OpenAccountModal
        isOpen={showOpenAccountModal}
        onClose={() => setShowOpenAccountModal(false)}
        userId={userId || ""}
        onSuccess={refreshAccounts}
      />
    </div>
  );
};

export default Accounts;
