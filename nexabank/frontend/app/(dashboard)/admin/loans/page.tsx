"use client"

import { useEffect, useState, useCallback, useMemo, memo } from "react"
import axios from "axios"
import { API_BASE_URL } from "@/lib/api"
import { AdminGuard } from "@/components/AdminGuard"
import { UserData } from "@/components/context/UserContext"
import { useEventTracker } from "@/hooks/useEventTracker"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { 
  CheckCircle2, 
  XCircle, 
  Eye, 
  Loader2,
  User, 
  IdCard,
  Target,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
} from "@/components/ui/dialog"
import { toast } from "sonner"
import { format } from "date-fns"
import { Skeleton } from "@/components/ui/skeleton"

const TableRowSkeleton = memo(() => (
  <TableRow className="border-zinc-50">
    <TableCell className="pl-8"><Skeleton className="h-4 w-24 rounded bg-zinc-100" /></TableCell>
    <TableCell>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-32 rounded bg-zinc-100" />
        <Skeleton className="h-3 w-40 rounded bg-zinc-100/50" />
      </div>
    </TableCell>
    <TableCell><Skeleton className="h-4 w-20 rounded bg-zinc-100" /></TableCell>
    <TableCell className="text-right"><Skeleton className="h-4 w-24 rounded bg-zinc-100 ml-auto" /></TableCell>
    <TableCell><Skeleton className="h-4 w-28 rounded bg-zinc-100" /></TableCell>
    <TableCell><Skeleton className="h-6 w-20 rounded-full bg-zinc-100" /></TableCell>
    <TableCell className="pr-8"><Skeleton className="h-8 w-20 rounded-full bg-zinc-100 ml-auto" /></TableCell>
  </TableRow>
))
TableRowSkeleton.displayName = "TableRowSkeleton"

interface LoanApplication {
  id: string
  customerId: string
  loanType: string
  principalAmount: number
  term: number
  interestRate: number
  status: "PENDING" | "APPROVED" | "REJECTED"
  kycData: any
  createdOn: string
  customer: {
    name: string
    email: string
    phone: string
  }
}

export default function AdminLoansPage() {
  const [applications, setApplications] = useState<LoanApplication[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedApp, setSelectedApp] = useState<LoanApplication | null>(null)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [processingId, setProcessingId] = useState<string | null>(null)
  
  // To handle account number input for disbursal (simplified to first account for now)
  const [targetAccNo, setTargetAccNo] = useState("")

  const { isAuth } = UserData()
  const { track, measureAndTrack } = useEventTracker()

  useEffect(() => {
    if (isAuth) {
      track('admin_loans.page.view')
      fetchApplications()
    }
  }, [isAuth, track])

  const fetchApplications = useCallback(async () => {
    setLoading(true)
    try {
      const res = await axios.get(`${API_BASE_URL}/admin/applications`, { withCredentials: true })
      setApplications(res.data)
    } catch (err) {
      console.error("Failed to fetch applications:", err)
      toast.error("Failed to load applications")
    } finally {
      setLoading(false)
    }
  }, [])

  const handleOpenDetails = useCallback(async (app: LoanApplication) => {
    setSelectedApp(app)
    setIsDialogOpen(true)
    
    // Fetch the customer's first account to pre-fill target account for disbursal
    try {
      const accRes = await axios.get(`${API_BASE_URL}/customers/accounts/${app.customerId}`, { withCredentials: true })
      if (accRes.data && accRes.data.length > 0) {
        setTargetAccNo(accRes.data[0].accNo)
      }
    } catch (e) {
      console.error("Could not fetch user accounts", e)
    }
  }, [])

  const handleAction = useCallback(async (id: string, action: "approve" | "reject") => {
    setProcessingId(id)
    try {
      let disbursalAcc = targetAccNo;

      if (action === "approve" && !disbursalAcc) {
        // Find the application to get the customerId
        const app = applications.find(a => a.id === id);
        if (app) {
          const accRes = await axios.get(`${API_BASE_URL}/customers/accounts/${app.customerId}`, { withCredentials: true });
          if (accRes.data && accRes.data.length > 0) {
            disbursalAcc = accRes.data[0].accNo;
          }
        }
      }

      if (action === "approve" && !disbursalAcc) {
        toast.error("Could not find a target account for disbursal");
        return;
      }

      if (action === "approve") {
        await measureAndTrack('admin_loans.approve', async () => {
          await axios.post(`${API_BASE_URL}/approve/${id}`, { accNo: disbursalAcc }, { withCredentials: true })
        })
        toast.success("Application approved and funds disbursed!")
      } else {
        await measureAndTrack('admin_loans.reject', async () => {
          await axios.post(`${API_BASE_URL}/reject/${id}`, {}, { withCredentials: true })
        })
        toast.success("Application rejected")
      }
      setIsDialogOpen(false)
      fetchApplications()
    } catch (err: any) {
      console.error(`${action} failed:`, err)
      toast.error(err.response?.data?.error || `Failed to ${action} loan`)
    } finally {
      setProcessingId(null)
    }
  }, [applications, targetAccNo, fetchApplications])

  const getStatusBadge = useCallback((status: string) => {
    switch (status) {
      case "PENDING": return <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100 border-amber-200 shadow-sm">Pending</Badge>
      case "APPROVED": return <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100 border-emerald-200 shadow-sm">Approved</Badge>
      case "REJECTED": return <Badge className="bg-rose-100 text-rose-700 hover:bg-rose-100 border-rose-200 shadow-sm">Rejected</Badge>
      default: return <Badge className="text-yellow-600 bg-yellow-100 shadow-sm">{status}</Badge>
    }
  }, [])

  const renderedApplications = useMemo(() => {
    if (applications.length === 0) {
      return (
        <TableRow>
           <TableCell colSpan={7} className="h-64 text-center text-muted-foreground font-medium">
              No loan applications found.
           </TableCell>
        </TableRow>
      )
    }

    return applications.map((app) => (
      <TableRow key={app.id} className="border-zinc-50 hover:bg-zinc-50/50 transition-colors">
        <TableCell className="font-mono text-xs font-bold text-zinc-400 pl-8">
          #{app.id.slice(0, 8)}
        </TableCell>
        <TableCell>
          <div className="flex flex-col">
            <span className="font-bold text-zinc-900">{app.customer?.name}</span>
            <span className="text-xs text-muted-foreground">{app.customer?.email}</span>
          </div>
        </TableCell>
        <TableCell className="font-bold text-xs text-zinc-600 uppercase tracking-wider">
          {app.loanType}
        </TableCell>
        <TableCell className="text-right font-black text-zinc-900">
          ₹{app.principalAmount.toLocaleString('en-IN')}
        </TableCell>
        <TableCell className="text-xs font-bold text-zinc-500 italic">
          {format(new Date(app.createdOn), "dd MMM yyyy")}
        </TableCell>
        <TableCell>
          {getStatusBadge(app.status)}
        </TableCell>
        <TableCell className="text-right pr-4">
          <div className="flex items-center justify-end gap-2">
            {app.status === "PENDING" && (
              <>
                <Button 
                  variant="ghost" 
                  size="sm" 
                  className="rounded-full h-9 w-9 p-0 bg-emerald-50 text-emerald-600 hover:bg-emerald-500 hover:text-white transition-all cursor-pointer border border-emerald-100"
                  onClick={() => {
                    toast.message("Approve this application?", {
                      description: `Principal: ₹${app.principalAmount.toLocaleString('en-IN')}`,
                      action: {
                        label: "Confirm",
                        onClick: () => handleAction(app.id, "approve")
                      },
                    });
                  }}
                >
                  <CheckCircle2 className="h-4 w-4" />
                </Button>
                <Button 
                  variant="ghost" 
                  size="sm" 
                  className="rounded-full h-9 w-9 p-0 bg-rose-50 text-rose-600 hover:bg-rose-500 hover:text-white transition-all cursor-pointer border border-rose-100"
                  onClick={() => {
                    toast.message("Reject this application?", {
                      description: "This action cannot be undone.",
                      action: {
                        label: "Reject",
                        onClick: () => handleAction(app.id, "reject")
                      },
                    });
                  }}
                >
                  <XCircle className="h-4 w-4" />
                </Button>
              </>
            )}
            <Button 
              variant="ghost" 
              size="sm" 
              className="rounded-full h-9 w-9 p-0 bg-zinc-50 text-zinc-600 hover:bg-zinc-200 transition-all cursor-pointer"
              onClick={() => handleOpenDetails(app)}
            >
              <Eye className="h-4 w-4" />
            </Button>
          </div>
        </TableCell>
      </TableRow>
    ))
  }, [applications, getStatusBadge, handleAction, handleOpenDetails])

  return (
    <AdminGuard>
      <div className="p-8 max-w-7xl mx-auto space-y-8 animate-fade-in">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-black text-zinc-900 tracking-tight flex items-center gap-3">
              Loan Administration
            </h1>
            <p className="text-muted-foreground font-medium mt-1 uppercase text-[10px] tracking-widest text-violet-600">Review and process system-wide loan applications.</p>
          </div>
          <div className="flex gap-2">
             <Button variant="outline" className="rounded-xl font-bold" onClick={fetchApplications}>
                Refresh List
             </Button>
          </div>
        </div>

        {loading ? (
          <div className="bg-white rounded-[2.5rem] border border-zinc-100 shadow-xl shadow-zinc-200/50 overflow-hidden">
            <Table>
              <TableHeader className="bg-zinc-50/50">
                <TableRow className="border-zinc-100">
                  <TableHead className="py-6 pl-8"><Skeleton className="h-4 w-24 bg-zinc-200" /></TableHead>
                  <TableHead><Skeleton className="h-4 w-20 bg-zinc-200" /></TableHead>
                  <TableHead><Skeleton className="h-4 w-12 bg-zinc-200" /></TableHead>
                  <TableHead className="text-right"><Skeleton className="h-4 w-16 bg-zinc-200 ml-auto" /></TableHead>
                  <TableHead><Skeleton className="h-4 w-16 bg-zinc-200" /></TableHead>
                  <TableHead><Skeleton className="h-4 w-16 bg-zinc-200" /></TableHead>
                  <TableHead className="text-right pr-8"><Skeleton className="h-4 w-20 bg-zinc-200 ml-auto" /></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Array.from({ length: 5 }).map((_, i) => (
                  <TableRowSkeleton key={i} />
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="bg-white rounded-[2.5rem] border border-zinc-100 shadow-xl shadow-zinc-200/50 overflow-hidden">
            <Table>
              <TableHeader className="bg-zinc-50/50">
                <TableRow className="border-zinc-100 hover:bg-transparent">
                  <TableHead className="font-bold text-zinc-500 py-6 pl-8">APPLICATION ID</TableHead>
                  <TableHead className="font-bold text-zinc-500">CUSTOMER</TableHead>
                  <TableHead className="font-bold text-zinc-500">TYPE</TableHead>
                  <TableHead className="font-bold text-zinc-500 text-right">AMOUNT</TableHead>
                  <TableHead className="font-bold text-zinc-500">DATED</TableHead>
                  <TableHead className="font-bold text-zinc-500">STATUS</TableHead>
                  <TableHead className="font-bold text-zinc-500 text-right pr-8">ACTIONS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {renderedApplications}
              </TableBody>
            </Table>
          </div>
        )}

        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogContent className="max-w-2xl p-0 overflow-y-auto max-h-[85vh] border-none shadow-2xl">
            {selectedApp && (
              <div className="flex flex-col">
                <div className="bg-zinc-900 p-8 text-white">
                   <div className="flex justify-between items-start">
                      <div>
                        <Badge className="bg-violet-500 hover:bg-violet-500 text-white font-bold mb-4 rounded-full px-3 py-1 text-[10px] uppercase tracking-widest">
                           Application Review
                        </Badge>
                        <h2 className="text-3xl font-black">₹{selectedApp.principalAmount.toLocaleString()}</h2>
                        <p className="text-zinc-400 font-medium italic mt-1">{selectedApp.loanType} LOAN — {selectedApp.term} MONTHS @ {selectedApp.interestRate}%</p>
                      </div>
                      <div className="p-4 bg-violet-500 rounded-3xl border border-white/10 text-right">
                         <span className="block text-[10px] font-bold text-white uppercase mb-1">Status</span>
                          {getStatusBadge(selectedApp.status)}
                      </div>
                   </div>
                </div>

                <div className="p-8 space-y-8 bg-zinc-50/50">
                  <div className="grid grid-cols-2 gap-8">
                     <div className="space-y-4">
                        <h3 className="text-xs font-black text-zinc-400 uppercase tracking-widest flex items-center gap-2">
                           <User className="h-3 w-3" /> Customer Profile
                        </h3>
                        <div className="bg-white p-6 rounded-3xl border border-zinc-100 shadow-sm space-y-3">
                           <div>
                              <p className="text-[10px] font-black text-zinc-400 uppercase">Full Name</p>
                              <p className="text-sm font-bold text-zinc-900">{selectedApp.customer?.name}</p>
                           </div>
                           <div>
                              <p className="text-[10px] font-black text-zinc-400 uppercase">Email Address</p>
                              <p className="text-sm font-bold text-zinc-900">{selectedApp.customer?.email}</p>
                           </div>
                           <div>
                              <p className="text-[10px] font-black text-zinc-400 uppercase">Contact</p>
                              <p className="text-sm font-bold text-zinc-900">{selectedApp.customer?.phone}</p>
                           </div>
                        </div>
                     </div>

                     <div className="space-y-4">
                        <h3 className="text-xs font-black text-zinc-400 uppercase tracking-widest flex items-center gap-2">
                           <IdCard className="h-3 w-3" /> KYC Information
                        </h3>
                        <div className="bg-white p-6 rounded-3xl border border-zinc-100 shadow-sm space-y-3">
                           <div>
                              <p className="text-[10px] font-black text-zinc-400 uppercase">PAN Number</p>
                              <p className="text-sm font-bold text-zinc-900 uppercase">{selectedApp.kycData?.pan || 'N/A'}</p>
                           </div>
                           <div>
                              <p className="text-[10px] font-black text-zinc-400 uppercase">Aadhaar Number</p>
                              <p className="text-sm font-bold text-zinc-900">{selectedApp.kycData?.aadhaar || 'N/A'}</p>
                           </div>
                           <div className="flex justify-between items-center">
                              <div>
                                 <p className="text-[10px] font-black text-zinc-400 uppercase">Income (Annual)</p>
                                 <p className="text-sm font-bold text-zinc-900 text-emerald-600">₹{Number(selectedApp.kycData?.income || 0).toLocaleString()}</p>
                              </div>
                              <div className="text-right">
                                 <p className="text-[10px] font-black text-zinc-400 uppercase">Employment</p>
                                 <Badge variant="outline" className="font-bold text-[10px] mt-1">{selectedApp.kycData?.employment || 'N/A'}</Badge>
                              </div>
                           </div>
                        </div>
                     </div>
                  </div>

                  {selectedApp.status === "PENDING" && (
                    <div className="bg-amber-50 border border-amber-100 p-6 rounded-3xl">
                       <div className="flex gap-4 items-center">
                          <div className="h-10 w-10 rounded-full bg-amber-100 flex items-center justify-center">
                             <Target className="h-5 w-5 text-amber-600" />
                          </div>
                          <div className="flex-1">
                             <p className="text-sm font-bold text-amber-900">Ready for approval?</p>
                             <p className="text-xs text-amber-700 font-medium">Approved funds will be disbursed to account: <span className="font-black text-amber-900">{targetAccNo || "Loading..."}</span></p>
                          </div>
                       </div>
                    </div>
                  )}
                </div>

                {selectedApp.status === "PENDING" && (
                  <DialogFooter className="p-8 bg-white border-t border-zinc-100 gap-4 sm:justify-between items-center">
                    <Button 
                      variant="outline" 
                      className="w-full sm:w-auto h-14 rounded-2xl font-black text-rose-600 hover:bg-rose-50 hover:text-rose-700 border-none cursor-pointer"
                      onClick={() => handleAction(selectedApp.id, "reject")}
                      disabled={processingId !== null}
                    >
                      {processingId === selectedApp.id ? <Loader2 className="mr-2 animate-spin" /> : <XCircle className="mr-2 h-5 w-5" />}
                      Reject Application
                    </Button>
                    <Button 
                      className="w-full sm:w-auto h-14 px-10 rounded-2xl bg-zinc-900 hover:bg-violet-600 text-white font-black shadow-xl shadow-zinc-200 transition-all cursor-pointer"
                      onClick={() => handleAction(selectedApp.id, "approve")}
                      disabled={processingId !== null || !targetAccNo}
                    >
                      {processingId === selectedApp.id ? <Loader2 className="mr-2 animate-spin" /> : <CheckCircle2 className="mr-2 h-5 w-5" />}
                      Approve & Disburse
                    </Button>
                  </DialogFooter>
                )}
                
                {selectedApp.status !== "PENDING" && (
                   <div className="p-8 bg-white border-t border-zinc-100 text-center text-muted-foreground text-sm font-medium italic">
                      This application was {selectedApp.status.toLowerCase()} on {format(new Date(selectedApp.createdOn), "MMM dd, yyyy")}.
                   </div>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </AdminGuard>
  )
}
