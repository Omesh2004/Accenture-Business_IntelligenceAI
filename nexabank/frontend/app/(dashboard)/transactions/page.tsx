"use client";

import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  CalendarIcon,
  Filter,
  Search,
} from "lucide-react";
import { Transaction } from "@/types/Interface";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { format } from "date-fns";
import { UserData } from "@/components/context/UserContext";
import { Skeleton } from "@/components/ui/skeleton";
import { useRouter } from "next/navigation";
import { API_BASE_URL } from "@/lib/api";
import axios from "axios";
import { toast } from "sonner";
import { useEventTracker } from "@/hooks/useEventTracker";

export default function HistoryPage() {
  const [accountNo, setAccountNo] = useState<string>("");
  const [allTransactions, setAllTransactions] = useState<Transaction[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const { track } = useEventTracker();

  useEffect(() => {
    track('transactions.page.view');
    track('transactions.history.view');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [searchTerm, setSearchTerm] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [date, setDate] = useState<Date | undefined>(undefined);

  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  const { isAuth, userId } = UserData();
  const router = useRouter();

  useEffect(() => {
    if (!isAuth) {
      router.push("/login");
    }
  }, [isAuth, router]);

  // Status mapping
  const mapping: Record<string, string> = {
    true: "completed",
    false: "pending",
  };

  useEffect(() => {
    const fetchUserAndTransactions = async () => {
      if (!userId || !isAuth) return;
      setIsLoading(true);
      try {
        // Fetch accounts for account-level actions (e.g. statement export)
        const accountsRes = await axios.get(`${API_BASE_URL}/customers/accounts/${userId}`, {
          withCredentials: true
        });

        let primaryAccount = "";
        if (accountsRes.data && accountsRes.data.length > 0) {
           primaryAccount = accountsRes.data[0].accNo;
           setAccountNo(primaryAccount);
        }

        // Fetch all transactions across all active customer accounts.
        const txRes = await axios.get(`${API_BASE_URL}/byCustomer/${userId}`, {
          withCredentials: true,
        });
        setAllTransactions(txRes.data || []);
        
        setError(null);
      } catch (error) {
        console.error("Error fetching transactions:", error);
        setError("Failed to load transactions. Please try again later.");
        setAllTransactions([]);
      } finally {
        setIsLoading(false);
      }
    };

    fetchUserAndTransactions();
  }, [userId, isAuth]);

  useEffect(() => {
    setCurrentPage(1);
    if (searchTerm) track('transactions.search_transactions.success', { searchTerm });
    if (date) track('transactions.filter_by_date.success', { date: String(date) });
  }, [searchTerm, typeFilter, categoryFilter, statusFilter, date]);

  const filteredTransactions = allTransactions.filter(
    (transaction: Transaction) => {
      const description = transaction.description || (transaction as any).remark || "";
      const category = transaction.category || "GENERAL";
      const transactionType = transaction.transactionType || "";
      const status = transaction.status !== undefined ? transaction.status.toString() : "";
      const timestamp = transaction.timestamp ? new Date(transaction.timestamp) : new Date();

      const matchesSearch =
        description.toLowerCase().includes(searchTerm.toLowerCase()) ||
        category.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesType = typeFilter === "all" || transactionType === typeFilter;
      const matchesCategory = categoryFilter === "all" || category === categoryFilter;
      const matchesStatus = statusFilter === "all" || mapping[status] === statusFilter.toLowerCase();
      const matchesDate = !date || format(timestamp, "MMM dd, yyyy") === format(date, "MMM dd, yyyy");

      return matchesSearch && matchesType && matchesCategory && matchesStatus && matchesDate;
    }
  );

  const totalPages = Math.max(1, Math.ceil(filteredTransactions.length / itemsPerPage));
  const paginatedTransactions = filteredTransactions.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  const types = ["all", ...Array.from(new Set(allTransactions.map(t => t.transactionType).filter(Boolean)))];
  const categories = ["all", ...Array.from(new Set(allTransactions.map(t => t.category || "GENERAL").filter(Boolean)))];
  const statuses = ["all", ...Array.from(new Set(allTransactions.map(t => t.status !== undefined ? mapping[t.status.toString()] : null).filter(Boolean)))];

  const downloadPDF = async (accNo: string) => {
    try {
      if (!accNo) {
        toast.error("No active account number found");
        return;
      }
      track('payments.history.download');
      const response = await fetch(`${API_BASE_URL}/export-pdf/${accNo}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to download PDF");
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `transactions_${accNo}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (error) {
      toast.error("Failed to export transactions");
    }
  };

  const isAccountSender = (transaction: Transaction) => {
    return transaction.senderAccNo === accountNo;
  };
  
  const toSelf = (transaction: Transaction) => {
    return transaction.transactionType === "TRANSFER" && transaction.senderAccNo === transaction.receiverAccNo;
  };

  if (isLoading && allTransactions.length === 0 && !error) {
    return (
      <div className='flex flex-col gap-6 animate-fade-in'>
        <div className='flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4'>
          <div>
            <Skeleton className="h-10 w-64 rounded-lg bg-zinc-200 mb-2" />
            <Skeleton className="h-5 w-80 rounded bg-zinc-100" />
          </div>
          <div className='flex gap-3'>
            <Skeleton className="h-10 w-32 rounded-full bg-zinc-200" />
            <Skeleton className="h-10 w-32 rounded-full bg-zinc-200" />
          </div>
        </div>
        <Card className="border border-violet-100 shadow-sm overflow-hidden">
          <CardContent className='p-6 bg-white'>
            <div className='flex flex-col sm:flex-row gap-4 mb-8 bg-gray-100/50 p-4 rounded-xl border border-gray-100'>
              <Skeleton className="h-10 flex-1 rounded-lg bg-zinc-200" />
              <div className='flex flex-wrap gap-2'>
                <Skeleton className="h-10 w-[140px] rounded-lg bg-zinc-200" />
                <Skeleton className="h-10 w-[140px] rounded-lg bg-zinc-200" />
              </div>
            </div>
            <div className='space-y-4'>
               {Array.from({ length: 5 }).map((_, i) => (
                 <div key={i} className='flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-xl border border-gray-100 bg-white'>
                   <div className='flex flex-col sm:flex-row sm:items-center gap-4 mb-2 sm:mb-0'>
                     <Skeleton className="w-12 h-12 rounded-full bg-zinc-200" />
                     <div className="space-y-2">
                       <Skeleton className="h-5 w-40 rounded bg-zinc-200" />
                       <Skeleton className="h-3 w-48 rounded bg-zinc-100" />
                     </div>
                   </div>
                   <div className='flex flex-col sm:flex-row sm:items-center gap-4 mt-2 sm:mt-0'>
                     <Skeleton className="h-6 w-20 rounded-full bg-zinc-200" />
                     <Skeleton className="h-5 w-24 rounded bg-zinc-200" />
                   </div>
                 </div>
               ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className='flex flex-col gap-6 animate-fade-in'>
      <div className='flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4'>
        <div>
          <h1 className='text-3xl font-bold tracking-tight text-zinc-900'>
            Transaction History
          </h1>
          <p className='text-muted-foreground mt-1'>
            View your complete transaction timeline in Rupees (₹).
          </p>
        </div>
        <div className='flex gap-3'>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant='outline' className="rounded-full cursor-pointer hover:shadow-sm">
                <CalendarIcon className='mr-2 h-4 w-4 text-violet-600' />
                {date ? format(date, "PPP") : "Filter by date"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className='w-auto p-0' align='end'>
              <Calendar mode='single' selected={date} onSelect={setDate} initialFocus />
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <Card className="border border-violet-100 shadow-sm overflow-hidden">
        <CardContent className='p-6 bg-white'>
          <div className='flex flex-col sm:flex-row gap-4 mb-8 bg-gray-100/50 p-4 rounded-xl border border-gray-100'>
            <div className='relative flex-1'>
              <Search className='absolute left-3 top-3 h-4 w-4 text-muted-foreground' />
              <Input
                placeholder='Search transactions...'
                className='pl-10 rounded-lg bg-white border-gray-200'
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            <div className='flex flex-wrap gap-2'>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className='w-[140px] rounded-lg bg-white cursor-pointer'>
                  <SelectValue placeholder='Type' />
                </SelectTrigger>
                <SelectContent>
                  {types.map((type) => (
                    <SelectItem key={type as string} value={type as string} className="cursor-pointer">
                      {type === "all" ? "All Types" : type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger className='w-[140px] rounded-lg bg-white cursor-pointer'>
                  <SelectValue placeholder='Category' />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((category) => (
                    <SelectItem key={category as string} value={category as string} className="cursor-pointer">
                      {category === "all" ? "All Categories" : category}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {date && (
                <Button variant='outline' size='icon' className="rounded-lg cursor-pointer hover:bg-rose-50 hover:text-rose-600 hover:border-rose-100 transition-colors" onClick={() => setDate(undefined)} title='Clear date filter'>
                  <Filter className='h-4 w-4' />
                </Button>
              )}
            </div>
          </div>

          <div className='space-y-4'>
            {error ? (
              <div className='text-center py-12 bg-rose-50/50 rounded-xl border border-rose-100'>
                <p className='text-rose-600 font-medium mb-4'>{error}</p>
                <Button className='rounded-full cursor-pointer bg-rose-600 hover:bg-rose-700' onClick={() => window.location.reload()}>
                  Refresh Page
                </Button>
              </div>
            ) : paginatedTransactions.length === 0 ? (
              <div className='text-center py-16 bg-gray-100/50 rounded-xl border border-dashed border-gray-200'>
                <div className="h-16 w-16 bg-violet-100 rounded-full flex flex-col items-center justify-center mx-auto mb-4">
                   <ArrowLeftRight className="h-6 w-6 text-violet-500" />
                </div>
                <h3 className="text-lg font-semibold text-zinc-900 mb-1">No transactions found</h3>
                <p className='text-muted-foreground'>Try adjusting your filters or search terms.</p>
              </div>
            ) : (
              paginatedTransactions.map((transaction) => {
                const isSender = isAccountSender(transaction);
                const toself = toSelf(transaction);
                const amount = Math.abs(transaction.amount || 0);

                return (
                  <div key={transaction.id} className='flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-xl border border-gray-100 hover:border-violet-200 hover:shadow-sm transition-all group cursor-pointer bg-white'>
                    <div className='flex flex-col sm:flex-row sm:items-center gap-4 mb-2 sm:mb-0'>
                      <div className='flex-shrink-0 w-12 h-12 rounded-full bg-violet-50 group-hover:bg-violet-100 transition-colors flex items-center justify-center'>
                        {isSender ? (
                          <ArrowDown className='h-5 w-5 text-rose-500' />
                        ) : toself ? (
                          <ArrowLeftRight className='h-5 w-5 text-blue-500' />
                        ) : (
                          <ArrowUp className='h-5 w-5 text-emerald-500' />
                        )}
                      </div>
                      <div>
                        <h4 className='font-semibold text-zinc-900 group-hover:text-violet-700 transition-colors'>
                          {transaction.description || (transaction as any).remark || transaction.transactionType}
                        </h4>
                        <div className='flex flex-wrap gap-2 text-xs text-muted-foreground mt-1'>
                          <span>{transaction.timestamp ? format(new Date(transaction.timestamp), "MMM dd, yyyy") : "No date"}</span>
                          <span>•</span>
                          <span className="font-mono bg-gray-100 px-1.5 rounded text-gray-500">
                             {isSender ? "Sent to" : "Received from"} {isSender ? (transaction.receiverAccount?.accNo || transaction.receiverAccNo) : (transaction.senderAccount?.accNo || transaction.senderAccNo)}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className='flex flex-col sm:flex-row sm:items-center gap-4 mt-2 sm:mt-0'>
                      <div className='flex justify-center' style={{ minWidth: "6rem" }}>
                        <Badge variant="outline" className={`capitalize rounded-full font-normal ${isSender ? "bg-rose-50 text-rose-700 border-rose-200" : "bg-emerald-50 text-emerald-700 border-emerald-200"}`}>
                          {transaction.transactionType || "Transfer"}
                        </Badge>
                      </div>
                      <div className='flex flex-col sm:items-end min-w-[100px]'>
                        <span className={`font-bold text-lg tracking-tight ${isSender ? "text-rose-600" : "text-emerald-600"}`}>
                          {isSender ? "-" : "+"}₹{amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {totalPages > 1 && (
            <Pagination className='mt-8 pt-4 border-t border-gray-100'>
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious href='#' className="cursor-pointer hover:bg-violet-50 hover:text-violet-700 rounded-lg" onClick={(e) => { e.preventDefault(); setCurrentPage(Math.max(1, currentPage - 1)); }} />
                </PaginationItem>
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  const pageNumber = i + 1;
                  return (
                    <PaginationItem key={pageNumber}>
                      <PaginationLink href='#' isActive={pageNumber === currentPage} className={`cursor-pointer rounded-lg ${pageNumber === currentPage ? 'bg-violet-600 hover:bg-violet-700 text-white border-0' : 'hover:bg-violet-50 hover:text-violet-700 border-0'}`} onClick={(e) => { e.preventDefault(); setCurrentPage(pageNumber); }}>
                        {pageNumber}
                      </PaginationLink>
                    </PaginationItem>
                  );
                })}
                {totalPages > 5 && (
                  <>
                    <PaginationItem><PaginationEllipsis /></PaginationItem>
                    <PaginationItem><PaginationLink href='#' isActive={totalPages === currentPage} className="cursor-pointer rounded-lg hover:bg-violet-50" onClick={(e) => { e.preventDefault(); setCurrentPage(totalPages); }}>{totalPages}</PaginationLink></PaginationItem>
                  </>
                )}
                <PaginationItem>
                  <PaginationNext href='#' className="cursor-pointer hover:bg-violet-50 hover:text-violet-700 rounded-lg" onClick={(e) => { e.preventDefault(); setCurrentPage(Math.min(totalPages, currentPage + 1)); }} />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
