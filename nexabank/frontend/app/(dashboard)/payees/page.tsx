"use client"

import axios from "axios";
import { useEffect, useState, memo, useMemo } from "react"
import { Building, Check, Copy, Edit, MoreHorizontal, Plus, Search, Trash, User, Wallet } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { UserData } from "@/components/context/UserContext"

import PaymentModal from "@/components/modals/PaymentModal"
import { useRouter } from "next/navigation"
import { API_BASE_URL } from "@/lib/api";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { useEventTracker } from "@/hooks/useEventTracker";

const PayeeCardSkeleton = memo(() => (
  <Card className="overflow-hidden border border-gray-100 shadow-sm">
    <CardHeader className="p-5 pb-3 flex flex-row items-start justify-between space-y-0 bg-white">
      <div className="flex items-center space-x-3 w-full">
        <Skeleton className="h-12 w-12 rounded-full ring-2 ring-violet-50 bg-zinc-200" />
        <div className="flex-1 overflow-hidden space-y-2">
          <Skeleton className="h-5 w-3/4 rounded bg-zinc-200" />
          <Skeleton className="h-3 w-1/2 rounded bg-zinc-100" />
        </div>
      </div>
    </CardHeader>
    <CardContent className="p-5 pt-3 bg-white">
      <div className="grid grid-cols-1 gap-3 mb-4 p-3 bg-gray-100 rounded-lg border border-gray-100">
        <div className="space-y-2">
          <Skeleton className="h-3 w-1/3 rounded bg-zinc-200" />
          <Skeleton className="h-4 w-1/2 rounded bg-zinc-300" />
        </div>
        <div className="grid grid-cols-2 gap-2 pt-2 border-t border-gray-100 mt-2">
          <div className="space-y-2">
            <Skeleton className="h-3 w-2/3 rounded bg-zinc-200" />
            <Skeleton className="h-4 w-full rounded bg-zinc-300" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-3 w-2/3 rounded bg-zinc-200" />
            <Skeleton className="h-4 w-full rounded bg-zinc-300" />
          </div>
        </div>
      </div>
      <Skeleton className="h-10 w-full rounded-xl bg-zinc-200" />
    </CardContent>
  </Card>
))
PayeeCardSkeleton.displayName = "PayeeCardSkeleton"

export default function PayeesPage() {
  const { track, measureAndTrack } = useEventTracker();
  
  useEffect(() => {
    track('payees.page.view');
  }, [track]);

  const [searchTerm, setSearchTerm] = useState("")
  const [isAddPayeeOpen, setIsAddPayeeOpen] = useState(false)
  const [isEditPayeeOpen, setIsEditPayeeOpen] = useState(false)
  // rawAccounts now comes from globalAccounts in context
  const [payeeSearchResults, setPayeeSearchResults] = useState<any[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [bankList, setBankList] = useState<any[]>([])
  const [searchQuery, setSearchQuery] = useState("")

  const {
    fetchPayees,
    AddPayeeById,
    EditPayee,
    DeletePayee,
    CheckPayeeName,
    PayeeName,
    payees,
    isAuth,
    isAuthLoading,
    userId,
    globalAccounts,
    fetchGlobalAccounts,
  } = UserData()

  useEffect(() => {
    const fetchBanks = async () => {
      try {
        const res = await axios.get(`${API_BASE_URL}/tenants/ifsc-list`, { withCredentials: true });
        setBankList(res.data || []);
      } catch (err) {
        console.error("Failed to fetch bank list:", err);
      }
    };
    if (isAuth) fetchBanks();
  }, [isAuth]);

  const [newPayee, setNewPayee] = useState({
    name: "",
    payeeAccNo: "",
    ifsc: "",
    payeeType: "OTHERS"
  })
  const [editPayee, setEditPayee] = useState({
    payeeAccNo: "",
    name: "",
    ifsc: "",
    payeeType: "OTHERS"
  })

  const rawAccounts = globalAccounts;

  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [selectedPayee, setSelectedPayee] = useState<any>(null);

  const router = useRouter()
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isAuth) {
      if (!isAuthLoading) router.push("/login");
    }
  }, [isAuth, isAuthLoading, router]);

  // Initial data fetch — accounts come from globalAccounts (auto-fetched in Auth)
  useEffect(() => {
    let isMounted = true;
    const loadData = async () => {
      if (userId) {
        try {
          await fetchPayees(userId);
        } catch (err) {
          console.error("Could not fetch payees:", err);
        } finally {
          if (isMounted) setLoading(false);
        }
      }
    };
    
    if (userId) loadData();
    
    return () => { isMounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  useEffect(() => {
    const delayDebounceFn = setTimeout(() => {
      if (searchQuery.length > 2) {
        setIsSearching(true)
        track('payees.search_payee.success', { searchQuery });
        axios.get(`${API_BASE_URL}/payees/search?q=${searchQuery}`, { withCredentials: true })
          .then(res => {
            // Filter out user's own accounts
            const ownAccountNumbers = new Set(rawAccounts.map(a => a.accNo));
            const filteredResults = (res.data || []).filter((a: any) => !ownAccountNumbers.has(a.accNo));
            setPayeeSearchResults(filteredResults);
          })
          .catch(err => console.error("Search failed:", err))
          .finally(() => setIsSearching(false))
      } else {
        setPayeeSearchResults([])
      }
    }, 500)
    return () => clearTimeout(delayDebounceFn)
  }, [searchQuery])

  const handleSelectSearchResult = (result: any) => {
    setNewPayee({
      ...newPayee,
      name: result.name,
      payeeAccNo: result.accNo,
      ifsc: result.ifsc,
      payeeType: "OTHERS"
    })
    setSearchQuery("")
    setPayeeSearchResults([])
    toast.success("Payee details auto-filled!")
  }

  const filteredPayees = payees.filter(
    (payee) =>
      payee.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      payee.payeeAccNo.toLowerCase().includes(searchTerm.toLowerCase()) ||
      payee.payeeType.toLowerCase().includes(searchTerm.toLowerCase())
  )

  const handleAddPayee = async () => {
    if (newPayee.name && newPayee.payeeAccNo && newPayee.ifsc) {
      if (!userId) return toast.error("User context missing");
      try {
        await measureAndTrack('payees.add_payee', async () => {
          await AddPayeeById(userId, newPayee.name, newPayee.ifsc, newPayee.payeeAccNo, newPayee.payeeType);
        });
        setNewPayee({ name: "", payeeAccNo: "", payeeType: "OTHERS", ifsc: "" })
        setIsAddPayeeOpen(false)
        fetchPayees(userId)
        toast.success("Payee added successfully!");
      } catch (error: any) {
        console.error("Error adding payee:", error)
        toast.error(error?.response?.data?.error || "Failed to add payee");
      }
    } else {
      toast.error("Please fill in all details");
    }
  }

  const handleEditPayee = async (updatedPayee: { name: string; payeeAccNo: string; ifsc: string; payeeType: string }) => {
    if (!userId) return;
    try {
      await measureAndTrack('payees.edit_payee', async () => {
        await EditPayee(userId, updatedPayee.name, updatedPayee.ifsc, updatedPayee.payeeAccNo, updatedPayee.payeeType);
      });
      fetchPayees(userId)
      setIsEditPayeeOpen(false)
      toast.success("Payee updated successfully!");
    } catch (error) {
      console.error("Error editing payee:", error)
      toast.error("Failed to update payee");
    }
  }

  const handleDeletePayee = async (delPayeeAccNo: string) => {
    if (!userId) return;
    try {
      await measureAndTrack('payees.remove_payee', async () => {
        await DeletePayee(userId, delPayeeAccNo);
      });
      fetchPayees(userId)
      toast.success("Payee deleted");
    } catch (error) {
      console.error("Error deleting payee:", error)
      toast.error("Failed to delete payee");
    }
  }

  // Fixed: CheckPayeeName(payeeAccNo, payeeifsc) — was called with swapped args before
  const handleCheckPayeeName = async (checkAccNo: string, checkIfsc: string, event: React.MouseEvent) => {
    event.preventDefault()
    if (!checkAccNo || !checkIfsc) {
      toast.error("Enter account number and IFSC first");
      return;
    }
    try {
      await CheckPayeeName(checkAccNo, checkIfsc)
      toast.success("Account verified!");
    } catch (error) {
      console.error("Error checking payee name:", error)
      toast.error("Could not verify account. Check details.");
    }
  }

  const handleOpenEditDialog = (payee: any) => {
    setEditPayee({
      payeeAccNo: payee.payeeAccNo,
      name: payee.name,
      ifsc: payee.payeeifsc,
      payeeType: payee.payeeType
    })
    setIsEditPayeeOpen(true)
  }

  const handleCopyAccNo = (accNo: string) => {
    navigator.clipboard.writeText(accNo).then(
      () => {
        toast.success("Account number copied to clipboard");
        track('payees.copy_account_number.success');
      },
      () => toast.error("Failed to copy")
    );
  };

  if (loading || isAuthLoading || !isAuth) {
    return (
      <div className="space-y-8 animate-fade-in">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <Skeleton className="h-10 w-32 rounded-lg bg-zinc-200 mb-2" />
            <Skeleton className="h-5 w-64 rounded bg-zinc-100" />
          </div>
          <Skeleton className="h-10 w-32 rounded-full bg-zinc-200" />
        </div>
        <Card className="border border-violet-100 shadow-sm overflow-hidden">
          <CardContent className="p-6">
            <div className="mb-8">
              <Skeleton className="h-12 w-full rounded-xl bg-zinc-200" />
            </div>
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
               {Array.from({ length: 6 }).map((_, i) => (
                 <PayeeCardSkeleton key={i} />
               ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900">Payees</h1>
          <p className="text-muted-foreground mt-1">Manage your payees and make direct payments.</p>
        </div>
        <Dialog open={isAddPayeeOpen} onOpenChange={setIsAddPayeeOpen}>
          <DialogTrigger asChild>
            <Button className="rounded-full bg-violet-600 hover:bg-violet-700 text-white shadow-md hover:shadow-lg transition-all cursor-pointer">
              <Plus className="mr-2 h-4 w-4" />
              Add Payee
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto w-[95vw]">
            <DialogHeader>
              <DialogTitle className="text-xl">Add New Payee</DialogTitle>
              <DialogDescription>Enter the details of the payee you want to add.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-5 py-4">
              <div className="space-y-2 relative">
                <Label htmlFor="searchUser">Search All Banking Customers (Optional)</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="searchUser"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search name or account (All Banks)..."
                    className="pl-9 rounded-lg border-violet-200 focus-visible:ring-violet-500"
                  />
                </div>
                {payeeSearchResults.length > 0 && (
                  <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden max-h-48 overflow-y-auto">
                    {payeeSearchResults.map((res, i) => (
                      <div 
                        key={i} 
                        className="px-4 py-3 hover:bg-violet-50 cursor-pointer border-b border-gray-50 last:border-0"
                        onClick={() => handleSelectSearchResult(res)}
                      >
                        <p className="font-bold text-sm text-zinc-900 flex items-center justify-between">
                          {res.name}
                          <span className="text-[9px] bg-violet-100 text-violet-600 px-1.5 py-0.5 rounded uppercase tracking-tighter ml-2">
                             {res.bankName}
                          </span>
                        </p>
                        <p className="text-xs text-muted-foreground font-mono">
                          ***{res.accNo.slice(-5)} • {res.ifsc}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="relative flex items-center py-2">
                <div className="flex-grow border-t border-gray-100"></div>
                <span className="flex-shrink-0 mx-4 text-muted-foreground text-xs uppercase font-medium">Or enter manually</span>
                <div className="flex-grow border-t border-gray-100"></div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="name">Payee Nickname</Label>
                <Input
                  id="name"
                  value={newPayee.name}
                  onChange={(e) => setNewPayee({ ...newPayee, name: e.target.value })}
                  placeholder="e.g. John Doe, Electricity Bill"
                  className="rounded-lg"
                />
                {PayeeName ? (
                  <p className="ml-1 text-sm text-zinc-700 mt-2">Verified Banking Name: <span className="text-violet-600 font-semibold">{PayeeName}</span></p>
                ) : null}
              </div>
              <div className="space-y-2">
                <Label htmlFor="payeeAccNo">Account Number</Label>
                <Input
                  id="payeeAccNo"
                  value={newPayee.payeeAccNo}
                  onChange={(e) => setNewPayee({ ...newPayee, payeeAccNo: e.target.value })}
                  placeholder="Enter exact account number"
                  className="rounded-lg font-mono"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ifsc">Bank Name (IFSC)</Label>
                <Select 
                  value={newPayee.ifsc} 
                  onValueChange={(value) => setNewPayee({ ...newPayee, ifsc: value })}
                >
                  <SelectTrigger id="ifsc" className="cursor-pointer rounded-lg uppercase font-mono">
                    <SelectValue placeholder="Select Bank" />
                  </SelectTrigger>
                  <SelectContent>
                    {bankList.map((bank) => (
                      <SelectItem key={bank.ifsc} value={bank.ifsc} className="cursor-pointer">
                        {bank.bankName} ({bank.ifsc})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="payeeType">Category</Label>
                <Select value={newPayee.payeeType} onValueChange={(value) => setNewPayee({ ...newPayee, payeeType: value })}>
                  <SelectTrigger id="payeeType" className="cursor-pointer">
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SHOPPING" className="cursor-pointer">Shopping</SelectItem>
                    <SelectItem value="ENTERTAINMENT" className="cursor-pointer">Entertainment</SelectItem>
                    <SelectItem value="HOUSING" className="cursor-pointer">Housing</SelectItem>
                    <SelectItem value="FOOD" className="cursor-pointer">Food & Dining</SelectItem>
                    <SelectItem value="OTHERS" className="cursor-pointer">Others</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter className="flex flex-col sm:flex-row gap-3 sm:space-x-0 w-full sm:justify-between items-center">
              <Button
                onClick={(e) => handleCheckPayeeName(newPayee.payeeAccNo, newPayee.ifsc, e)}
                variant="secondary"
                className="w-full sm:w-auto cursor-pointer rounded-lg bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border-none"
              >
                <Check className="mr-2 h-4 w-4" /> Verify Account
              </Button>
              <div className="flex gap-2 w-full sm:w-auto">
                <Button variant="outline" onClick={() => setIsAddPayeeOpen(false)} className="flex-1 rounded-lg cursor-pointer">Cancel</Button>
                <Button onClick={handleAddPayee} className="flex-1 bg-violet-600 hover:bg-violet-700 rounded-lg cursor-pointer">Add Payee</Button>
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="border border-violet-100 shadow-sm overflow-hidden">
        <CardContent className="p-6">
          <div className="relative mb-8 bg-gray-100 p-4 rounded-xl border border-gray-100">
            <Search className="absolute left-7 top-7 h-5 w-5 text-muted-foreground" />
            <Input
              placeholder="Search payees by name, account number, or type..."
              className="pl-12 bg-white rounded-lg border-gray-200 shadow-sm h-12 text-md"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {filteredPayees.length === 0 ? (
              <div className="col-span-1 md:col-span-2 lg:col-span-3 text-center py-16 bg-gray-100 rounded-xl border border-dashed border-gray-200">
                <div className="h-16 w-16 bg-violet-50 rounded-full flex flex-col items-center justify-center mx-auto mb-4">
                  <User className="h-6 w-6 text-violet-400" />
                </div>
                <h3 className="text-lg font-semibold text-zinc-900 mb-1">No payees found</h3>
                <p className="text-muted-foreground max-w-sm mx-auto">You haven't added any payees yet, or your search didn't match.</p>
              </div>
            ) : (
              filteredPayees.map((payee) => (
                <Card key={payee.payeeAccNo} className="overflow-hidden border border-gray-100 hover:border-violet-200 transition-all duration-300 hover:shadow-md group">
                  <CardHeader className="p-5 pb-3 flex flex-row items-start justify-between space-y-0 bg-white">
                    <div className="flex items-center space-x-3">
                      <Avatar className="h-12 w-12 border-2 border-white shadow-sm ring-2 ring-violet-50">
                        <AvatarFallback
                          className={`
                            ${payee.payeeType.toUpperCase() === "OTHERS" || payee.payeeType.toUpperCase() === "GENERAL" ? "bg-gradient-to-br from-blue-400 to-blue-600" : ""}
                            ${payee.payeeType.toUpperCase() === "HOUSING" ? "bg-gradient-to-br from-emerald-400 to-emerald-600" : ""}
                            ${payee.payeeType.toUpperCase() === "FINANCIAL" || payee.payeeType.toUpperCase() === "SHOPPING" ? "bg-gradient-to-br from-purple-400 to-purple-600" : ""}
                            ${payee.payeeType.toUpperCase() === "FOOD" ? "bg-gradient-to-br from-orange-400 to-orange-600" : ""}
                            ${payee.payeeType.toUpperCase() === "ENTERTAINMENT" ? "bg-gradient-to-br from-pink-400 to-pink-600" : ""}
                            ${!["OTHERS", "GENERAL", "HOUSING", "FINANCIAL", "SHOPPING", "FOOD", "ENTERTAINMENT"].includes(payee.payeeType.toUpperCase()) ? "bg-gradient-to-br from-violet-500 to-purple-500" : ""}
                          `}
                        >
                          {payee.payeeType.toUpperCase() === "OTHERS" || payee.payeeType.toUpperCase() === "HOUSING" ? (
                            <Building className="h-5 w-5 text-white" />
                          ) : (
                            <User className="h-5 w-5 text-white" />
                          )}
                        </AvatarFallback>
                      </Avatar>
                      <div className="overflow-hidden">
                        <CardTitle className="text-lg font-semibold truncate group-hover:text-violet-700 transition-colors">{payee.name}</CardTitle>
                        <CardDescription className="text-sm font-mono mt-0.5">•••• {payee.payeeAccNo.slice(-4)}</CardDescription>
                      </div>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full cursor-pointer hover:bg-violet-50">
                          <MoreHorizontal className="h-4 w-4" />
                          <span className="sr-only">Open menu</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="rounded-xl shadow-lg border-gray-100">
                        <DropdownMenuItem onClick={() => handleOpenEditDialog(payee)} className="cursor-pointer">
                          <Edit className="mr-2 h-4 w-4" />
                          <span>Edit Payee</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-rose-600 focus:bg-rose-50 focus:text-rose-700 cursor-pointer"
                          onClick={() => handleDeletePayee(payee.payeeAccNo)}
                        >
                          <Trash className="mr-2 h-4 w-4" />
                          <span>Remove Payee</span>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </CardHeader>
                  <CardContent className="p-5 pt-3 bg-white">
                    <div className="grid grid-cols-1 gap-3 text-sm mb-4 p-3 bg-gray-100 rounded-lg border border-gray-100">
                      {/* Account number — full display with copy button */}
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-xs text-muted-foreground uppercase font-semibold">Account Number</p>
                          <p className="font-mono font-medium text-zinc-900 mt-0.5 tracking-wider">{payee.payeeAccNo}</p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 rounded-lg hover:bg-violet-100 text-muted-foreground hover:text-violet-600"
                          onClick={() => handleCopyAccNo(payee.payeeAccNo)}
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <div className="grid grid-cols-2 gap-2 pt-2 border-t border-gray-100">
                        <div>
                          <p className="text-xs text-muted-foreground uppercase font-semibold">Category</p>
                          <p className="font-medium text-zinc-900 mt-0.5">{payee.payeeType.charAt(0).toUpperCase() + payee.payeeType.slice(1).toLowerCase()}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground uppercase font-semibold">Bank IFSC</p>
                          <p className="font-medium text-zinc-900 mt-0.5 font-mono text-xs">{payee.payeeifsc || "N/A"}</p>
                        </div>
                      </div>
                    </div>
                    <Button
                      className="w-full rounded-xl bg-violet-50 text-violet-700 hover:bg-violet-600 hover:text-white transition-all shadow-none group-hover:shadow-sm cursor-pointer"
                      onClick={() => {
                        setSelectedPayee(payee);
                        setShowPaymentModal(true);
                      }}
                    >
                      <Wallet className="mr-2 h-4 w-4" /> Pay Now
                    </Button>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      {/* Edit Payee Dialog */}
      <Dialog open={isEditPayeeOpen} onOpenChange={setIsEditPayeeOpen}>
        <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto w-[95vw]">
          <DialogHeader>
            <DialogTitle>Edit Payee</DialogTitle>
            <DialogDescription>Update category or nickname for this payee.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="edit-name">Payee Nickname</Label>
              <Input
                id="edit-name"
                value={editPayee.name}
                onChange={(e) => setEditPayee({ ...editPayee, name: e.target.value })}
                className="rounded-lg"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="edit-payeeAccNo">Account Number</Label>
              <Input
                id="edit-payeeAccNo"
                value={editPayee.payeeAccNo}
                disabled
                className="bg-gray-100 cursor-not-allowed rounded-lg text-gray-500 font-mono"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="edit-ifsc">Bank Name (IFSC)</Label>
              <Select 
                value={editPayee.ifsc} 
                onValueChange={(value) => setEditPayee({ ...editPayee, ifsc: value })}
              >
                <SelectTrigger id="edit-ifsc" className="cursor-pointer rounded-lg uppercase font-mono">
                  <SelectValue placeholder="Select Bank" />
                </SelectTrigger>
                <SelectContent>
                  {bankList.map((bank) => (
                    <SelectItem key={bank.ifsc} value={bank.ifsc} className="cursor-pointer">
                      {bank.bankName} ({bank.ifsc})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="edit-payeeType">Payee Type</Label>
              <Select
                value={editPayee.payeeType}
                onValueChange={(value) => setEditPayee({ ...editPayee, payeeType: value })}
              >
                <SelectTrigger id="edit-payeeType" className="cursor-pointer rounded-lg">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SHOPPING" className="cursor-pointer">Shopping</SelectItem>
                  <SelectItem value="ENTERTAINMENT" className="cursor-pointer">Entertainment</SelectItem>
                  <SelectItem value="HOUSING" className="cursor-pointer">Housing</SelectItem>
                  <SelectItem value="FOOD" className="cursor-pointer">Food</SelectItem>
                  <SelectItem value="OTHERS" className="cursor-pointer">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditPayeeOpen(false)} className="rounded-lg cursor-pointer">
              Cancel
            </Button>
            <Button onClick={() => handleEditPayee(editPayee)} className="bg-violet-600 hover:bg-violet-700 rounded-lg shadow-md cursor-pointer">
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Payment Modal - uses raw accounts with accNo */}
      {rawAccounts.length > 0 && selectedPayee && (
        <PaymentModal
          isOpen={showPaymentModal}
          onClose={() => {
            setShowPaymentModal(false);
            setSelectedPayee(null);
          }}
          accounts={rawAccounts}
          payeeAccNo={selectedPayee.payeeAccNo}
          payeeName={selectedPayee.name}
          onSuccess={() => {
            if (userId) {
              fetchGlobalAccounts(userId);
            }
          }}
        />
      )}
    </div>
  )
}