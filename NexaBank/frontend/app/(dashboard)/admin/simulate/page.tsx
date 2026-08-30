"use client"

import { useState, useEffect, type ChangeEvent } from "react"
import axios from "axios"
import { API_BASE_URL } from "@/lib/api"
import { AdminGuard } from "@/components/AdminGuard"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { 
  Database, 
  Play, 
  CheckCircle2, 
  Loader2,
  TrendingUp,
  Activity,
  UserPlus,
   ShieldAlert,
   Sparkles,
   Clock3,
   Rocket,
   BarChart3,
   Server
} from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { UserData } from "@/components/context/UserContext"
import { useEventTracker } from "@/hooks/useEventTracker"
import { BehaviorControls, type BehaviorPayload, type SimCatalog } from "@/components/admin/BehaviorControls"

interface ProcessingSummary {
   users?: { requested?: number; created?: number; skipped?: number };
   funnel?: {
      compliantUsers?: number;
      analyticsOptInUsers?: number;
      applicationsCreated?: number;
   };
   generated?: {
      eventsCreated?: number;
      transactionsCreated?: number;
      payeesCreated?: number;
   };
}

interface SimulationResult {
   message?: string;
   usersCreated?: number;
   totalUsers?: number;
   transactionsCreated?: number;
   eventsCreated?: number;
   applicationsCreated?: number;
   loansApplied?: number;
   compliantUsers?: number;
   kycCompleted?: number;
   analyticsOptInUsers?: number;
   fullyCompleted?: number;
   payeesCreated?: number;
   simulatedDays?: number;
   runMs?: number;
   throughputEventsPerSec?: number;
   requestedUsers?: number;
   requestedTenant?: string;
   resolvedTenant?: string;
   /** Which path ran and which population it acted on. Both modes report these. */
   mode?: string;
   population?: string;
   createAccounts?: boolean;
   simulatedUsers?: number;
   processingSummary?: ProcessingSummary;
   /** Echo of the behaviour the run applied. Shown here only; never persisted. */
   behaviorApplied?: BehaviorPayload | null;
   behaviorSummary?: string[];
}

type StepState = "idle" | "active" | "done";

interface BankOption {
   tenantId: string;
   bankName: string;
}

export default function AdminSimulatePage() {
   const [count, setCount] = useState(20)
   const [days, setDays] = useState(30)
   const [tenantId, setTenantId] = useState("")
   const [loading, setLoading] = useState(false)
   const [result, setResult] = useState<SimulationResult | null>(null)
   const [bankList, setBankList] = useState<BankOption[]>([])
   const [activeStep, setActiveStep] = useState(0)
   const [templateId, setTemplateId] = useState("baseline")
   const [behavior, setBehavior] = useState<BehaviorPayload | null>(null)
   const [catalog, setCatalog] = useState<SimCatalog | null>(null)
  // Slow mode proves the real pipeline works: every row goes to Postgres, then the ingestion API,
  // Kafka and the worker. Fast mode writes the analytics tables directly -- mock data only, for
  // testing the intelligence layer on volume it would otherwise take hours to produce.
  const [fastMode, setFastMode] = useState(false)
  const [purgeFirst, setPurgeFirst] = useState(false)
  // Off by default: a run generates activity for customers the bank already has. Creating a
  // population every time gave each run its own cohort, so openings spiked on every run and a
  // planted rate movement was diluted by arrivals rather than measured against a stable base.
  const [createAccounts, setCreateAccounts] = useState(false)

  const { isAuth } = UserData()

  const { track, measureAndTrack } = useEventTracker()

   const processingSteps = [
      "Validating tenant and simulation payload",
      "Creating realistic user profiles",
      "Generating KYC, loans and events",
      "Syncing analytics and finalizing stats",
   ]

  useEffect(() => {
    track('admin_simulate.page.view')
    const fetchBanks = async () => {
      try {
        const res = await axios.get(`${API_BASE_URL}/tenants/ifsc-list`, { withCredentials: true });
        setBankList(res.data || []);
        if (res.data && res.data.length > 0) {
          setTenantId(res.data[0].tenantId);
        }
      } catch (err) {
        console.error("Failed to fetch bank list:", err);
      }
    };
    const fetchCatalog = async () => {
      try {
        const res = await axios.get(`${API_BASE_URL}/events/simulate/catalog`, { withCredentials: true });
        setCatalog(res.data || null);
      } catch (err) {
        console.error("Failed to fetch simulate catalog:", err);
      }
    };
    if (isAuth) {
      fetchBanks();
      fetchCatalog();
    }
  }, [isAuth, track]);

   useEffect(() => {
      if (!loading) {
         setActiveStep(0)
         return
      }
      setActiveStep(0)
      const id = setInterval(() => {
         setActiveStep((prev: number) => (prev < processingSteps.length - 1 ? prev + 1 : prev))
      }, 1200)

      return () => clearInterval(id)
   }, [loading])

   const resolveErrorMessage = (err: any) => {
      const detail = err?.response?.data?.detail
      if (Array.isArray(detail)) {
         return detail.map((d: any) => d?.msg || "Validation error").join(" | ")
      }
      return (
         err?.response?.data?.error ||
         detail ||
         err?.message ||
         "Simulation failed"
      )
   }

  // Fitted to measured runs on this stack (users x days -> wall seconds):
  //   3x7 = 11.5s | 10x14 = 30.9s | 25x21 = 82.8s | 40x30 = 127.8s
  // ~12s of fixed cost plus ~0.10s per user-day, which lands within ~25% across that range. The
  // per-user-day cost falls as the run gets wider because the concurrency pool saturates, so a
  // flat rate over-predicts large runs badly -- an earlier 0.47 constant was 4x high at 40x30.
  const slowEstimateSeconds = Math.round(
    12 + (Number.isFinite(count) ? count : 0) * (Number.isFinite(days) ? days : 0) * 0.10)
  const formatDuration = (s: number) =>
    s < 90 ? `${s} seconds` : s < 5400 ? `${Math.round(s / 60)} minutes` : `${(s / 3600).toFixed(1)} hours`

  const handleSimulate = async () => {
      // The slow-mode caps exist because every user costs hundreds of remote Postgres round
      // trips. Fast mode does not pay that, so it can go much wider.
      const maxCount = fastMode ? 5000 : 100
      const maxDays = fastMode ? 365 : 60
      const safeCount = Number.isFinite(count) ? Math.max(1, Math.min(Math.floor(count), maxCount)) : 20
      const safeDays = Number.isFinite(days) ? Math.max(1, Math.min(Math.floor(days), maxDays)) : 30

      if (!tenantId.trim()) {
         toast.error("Please select a target tenant before running simulation")
         return
      }

      if (safeCount !== count) {
         setCount(safeCount)
      }
      if (safeDays !== days) {
         setDays(safeDays)
      }

    setLoading(true)
    setResult(null)
    try {
      await measureAndTrack('admin_simulate.run_simulation', async () => {
            const res = await axios.post(
               `${API_BASE_URL}/events/simulate`,
               { count: safeCount, days: safeDays, tenantId, behavior,
                 mode: fastMode ? "fast" : "slow", purgeFirst: fastMode && purgeFirst,
                 createAccounts },
               { withCredentials: true }
            )
        setResult(res.data)
      })
      toast.success("Simulation complete!")
    } catch (err: any) {
      console.error("Simulation failed:", err)
         toast.error(resolveErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

   const computedStats = [
      {
         label: "Total Users",
         value: result?.totalUsers ?? result?.usersCreated ?? 0,
         icon: UserPlus,
      },
      {
         label: "Loan Applications",
         value: result?.applicationsCreated ?? result?.loansApplied ?? 0,
         icon: Database,
      },
      {
         label: "Compliant",
         value: result?.compliantUsers ?? result?.kycCompleted ?? 0,
         icon: CheckCircle2,
      },
      {
         label: "Analytics Opt-in",
         value: result?.analyticsOptInUsers ?? result?.fullyCompleted ?? 0,
         icon: TrendingUp,
      },
   ]

  return (
    <AdminGuard>
         <div className="p-6 md:p-8 max-w-6xl mx-auto space-y-8 animate-fade-in bg-gradient-to-b from-white via-white to-violet-50/30 min-h-screen">
        <div className="flex justify-between items-start">
           <div>
                     <h1 className="text-3xl font-black text-zinc-950 tracking-tight flex items-center gap-3">
                         <Sparkles className="h-7 w-7 text-violet-600" />
                         Admin Simulation Console
              </h1>
                     <p className="text-zinc-600 font-medium mt-1">Generate high-fidelity synthetic user data with transparent processing diagnostics and analytics sync details.</p>
           </div>
           
                <div className="bg-white border border-violet-200 px-6 py-4 rounded-3xl flex items-center gap-4 shadow-sm">
              <ShieldAlert className="h-6 w-6 text-amber-600" />
              <div>
                 <p className="text-xs font-black text-amber-900 uppercase">Warning</p>
                 <p className="text-xs font-bold text-amber-700">Creates permanent mock records in database.</p>
              </div>
           </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
           <div className="lg:col-span-1 space-y-6">
              <Card className="rounded-[2rem] border-violet-100 shadow-xl shadow-violet-100/30 bg-white">
                 <CardHeader>
                    <CardTitle className="text-xl font-black text-zinc-900">Simulator Config</CardTitle>
                    <CardDescription className="font-medium">Define population parameters.</CardDescription>
                 </CardHeader>
                 <CardContent className="space-y-6">
                    <div className="space-y-2">
                       <Label className="text-xs font-black uppercase text-zinc-400">Target Tenant</Label>
                       <Select value={tenantId} onValueChange={setTenantId}>
                          <SelectTrigger className="h-12 rounded-2xl font-bold border-zinc-100">
                             <SelectValue placeholder="Select Bank" />
                          </SelectTrigger>
                          <SelectContent className="rounded-2xl border-zinc-100">
                             {bankList.map((bank: BankOption) => (
                               <SelectItem key={bank.tenantId} value={bank.tenantId} className="font-bold">
                                 {bank.bankName} ({bank.tenantId})
                               </SelectItem>
                             ))}
                          </SelectContent>
                       </Select>
                    </div>

                              <div className="space-y-2">
                                  <Label className="text-xs font-black uppercase text-zinc-400">User Count (Max 100)</Label>
                                  <Input
                                     type="number" 
                                     value={count} 
                                     onChange={(e: ChangeEvent<HTMLInputElement>) => setCount(Number(e.target.value))}
                                     min={1}
                                     max={100}
                                     className="h-12 rounded-2xl font-bold border-zinc-100"
                                  />
                              </div>

                              <div className="space-y-2">
                                  <Label className="text-xs font-black uppercase text-zinc-400">Historical Days (Max 60)</Label>
                                  <Input
                                     type="number" 
                                     value={days} 
                                     onChange={(e: ChangeEvent<HTMLInputElement>) => setDays(Number(e.target.value))}
                                     min={1}
                                     max={60}
                                     className="h-12 rounded-2xl font-bold border-zinc-100"
                                  />
                                  <p className="text-xs text-zinc-500 font-medium">Generate activities spanning the last N days</p>
                              </div>

                              <div className="pt-2 border-t border-zinc-100">
                                 <BehaviorControls
                                    value={behavior}
                                    onChange={setBehavior}
                                    templateId={templateId}
                                    // A population-shift scenario is about who the customers ARE,
                                    // so it needs new arrivals; every other scenario changes a
                                    // rate and wants the existing base held still. Still a
                                    // default, not a lock -- the operator can override it.
                                    onTemplateChange={(id: string) => {
                                       setTemplateId(id)
                                       setCreateAccounts(id.startsWith("shift_"))
                                    }}
                                    catalog={catalog}
                                    disabled={loading}
                                 />
                              </div>

                              {/* Mode. Slow proves the pipeline; fast produces volume. */}
                              <div className="pt-2 border-t border-zinc-100 space-y-3">
                                 <div className="flex items-start justify-between gap-3">
                                    <div>
                                       <p className="text-sm font-bold text-zinc-800">
                                          {fastMode ? 'Fast mode — pipeline bypassed' : 'Slow mode — full pipeline'}
                                       </p>
                                       <p className="text-xs text-zinc-500 font-medium mt-0.5">
                                          {fastMode
                                             ? 'Writes the analytics tables directly. Mock data only: no bank records, and the ingestion path is not exercised.'
                                             : 'Every row goes through Postgres, ingestion, Kafka and the worker — this is what proves the pipeline works.'}
                                       </p>
                                    </div>
                                    <button
                                       type="button"
                                       role="switch"
                                       aria-checked={fastMode}
                                       aria-label="Fast mode"
                                       disabled={loading}
                                       onClick={() => setFastMode(v => !v)}
                                       className={`shrink-0 mt-1 h-6 w-11 rounded-full transition-colors cursor-pointer disabled:opacity-50 ${fastMode ? 'bg-violet-600' : 'bg-zinc-300'}`}
                                    >
                                       <span className={`block h-5 w-5 bg-white rounded-full shadow transform transition-transform ${fastMode ? 'translate-x-5' : 'translate-x-0.5'}`} />
                                    </button>
                                 </div>

                                 {fastMode && (
                                    <label className="flex items-center gap-2 text-xs font-medium text-zinc-600 cursor-pointer">
                                       <input type="checkbox" checked={purgeFirst} disabled={loading}
                                              onChange={(e) => setPurgeFirst(e.target.checked)} />
                                       Clear previously fast-seeded data first
                                    </label>
                                 )}

                                 {/* Population. A run generates activity for customers the bank
                                     already has; creating more is a separate decision. */}
                                 <label className="flex items-start gap-2 text-xs font-medium text-zinc-600 cursor-pointer">
                                    <input type="checkbox" checked={createAccounts} disabled={loading}
                                           className="mt-0.5"
                                           onChange={(e) => setCreateAccounts(e.target.checked)} />
                                    <span>
                                       Create new customers and accounts
                                       <span className="block text-zinc-400 font-normal">
                                          {createAccounts
                                             ? 'Opens new accounts, so account-opening KPIs will move. Use for growth scenarios.'
                                             : 'Off: generates activity for existing customers, so a rate change is measured against a stable base.'}
                                       </span>
                                    </span>
                                 </label>

                                 {/* Only shown when the run is actually long enough to matter. A
                                     warning on every run is a warning nobody reads. */}
                                 {!fastMode && slowEstimateSeconds > 60 && (
                                    <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
                                       <p className="text-xs font-bold text-amber-800">
                                          This run will take roughly {formatDuration(slowEstimateSeconds)}.
                                       </p>
                                       <p className="text-[11px] text-amber-700 mt-0.5">
                                          Slow mode writes every row to a remote database one round trip at a time.
                                          {slowEstimateSeconds > 300 && ' Runs beyond ~5 minutes may be dropped by the database connection pooler.'}
                                          {' '}Switch to fast mode for volume.
                                       </p>
                                    </div>
                                 )}
                              </div>

                    <Button 
                      className="w-full h-14 rounded-2xl bg-black hover:bg-violet-700 text-white font-black shadow-lg shadow-violet-200 transition-all cursor-pointer"
                      onClick={handleSimulate}
                      disabled={loading || !tenantId}
                    >
                       {loading ? <Loader2 className="mr-2 animate-spin h-5 w-5" /> : <Play className="mr-2 h-5 w-5" />}
                       {loading ? 'Processing...' : 'Run Simulation'}
                    </Button>
                 </CardContent>
              </Card>

              <div className="bg-white border border-violet-100 p-8 rounded-[2rem] space-y-4 shadow-sm">
                 <h3 className="font-black text-zinc-900 flex items-center gap-2">
                    <Activity className="h-4 w-4 text-violet-600" />
                    How it works
                 </h3>
                 <ul className="space-y-3">
                    {[
                      'Generates unique names & emails',
                      'Assigns valid bank IFSC prefixes',
                      'Simulates KYC document uploads',
                      'Creates random loan histories',
                      'Logs realistic login events'
                    ].map((step, i) => (
                      <li key={i} className="flex gap-2 text-xs font-medium text-zinc-600">
                         <div className="h-1.5 w-1.5 rounded-full bg-violet-400 mt-1 opacity-50" />
                         {step}
                      </li>
                    ))}
                 </ul>
              </div>
           </div>

           <div className="lg:col-span-2 space-y-6">
              {!result && !loading && (
                         <div className="h-full min-h-[420px] border-2 border-dashed border-violet-200 rounded-[2rem] flex flex-col items-center justify-center text-center p-12 bg-white">
                    <Database className="h-16 w-16 text-zinc-200 mb-4" />
                    <h3 className="text-xl font-bold text-zinc-400 italic">No Active Results</h3>
                              <p className="text-sm text-zinc-500 max-w-md mt-2 font-medium">Configure the simulator and run it to inspect real generation details, output metrics, and analytics propagation status.</p>
                 </div>
              )}

              {loading && (
                         <div className="h-full min-h-[420px] bg-white border border-violet-200 rounded-[2rem] p-8 shadow-sm space-y-6">
                              <div className="flex items-center gap-4">
                                 <div className="h-14 w-14 rounded-2xl bg-violet-100 flex items-center justify-center">
                                    <Loader2 className="h-7 w-7 animate-spin text-violet-700" />
                                 </div>
                                 <div>
                                    <h3 className="text-xl font-black text-zinc-900">Simulation In Progress</h3>
                                    <p className="text-zinc-600 font-medium text-sm">Live processing phases are shown below.</p>
                                 </div>
                              </div>

                              <div className="rounded-2xl border border-violet-100 bg-violet-50/40 p-5 space-y-3">
                                 {processingSteps.map((step, idx) => {
                                    const state: StepState = idx < activeStep ? "done" : idx === activeStep ? "active" : "idle"
                                    return (
                                       <div key={step} className="flex items-center gap-3">
                                          <div
                                             className={`h-6 w-6 rounded-full flex items-center justify-center text-xs font-black ${
                                                state === "done"
                                                   ? "bg-violet-700 text-white"
                                                   : state === "active"
                                                      ? "bg-black text-white"
                                                      : "bg-white border border-zinc-300 text-zinc-400"
                                             }`}
                                          >
                                             {state === "done" ? "✓" : idx + 1}
                                          </div>
                                          <p className={`text-sm font-medium ${state === "idle" ? "text-zinc-400" : "text-zinc-800"}`}>{step}</p>
                                       </div>
                                    )
                                 })}
                              </div>
                 </div>
              )}

              {result && (
                         <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                    {result.behaviorSummary && result.behaviorSummary.length > 0 && (
                       <div className="bg-white p-6 rounded-[1.5rem] border-2 border-amber-200 shadow-sm">
                          <h3 className="text-base font-black text-zinc-900 flex items-center gap-2">
                             <ShieldAlert className="h-4 w-4 text-amber-600" />
                             Behaviour applied
                             {result.behaviorApplied?.relaxJourney === true && (
                                <span className="ml-2 inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wide text-red-700">
                                   Realism safeguard off
                                </span>
                             )}
                          </h3>
                          <ul className="mt-3 space-y-1.5">
                             {result.behaviorSummary.map((line: string, i: number) => (
                                <li key={i} className="text-sm text-zinc-700 font-medium flex gap-2">
                                   <span className="text-amber-500">•</span>
                                   {line}
                                </li>
                             ))}
                          </ul>
                          <p className="mt-4 text-xs text-zinc-500 font-medium leading-relaxed border-t border-zinc-100 pt-3">
                             Shown here only. Nothing recorded what changed — the movement exists
                             solely as the shape of the events, so the intelligence layer has to
                             work it out rather than look it up.
                          </p>
                       </div>
                    )}

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                  {computedStats.map((stat) => (
                                     <div key={stat.label} className="bg-white p-6 rounded-[1.5rem] border border-violet-100 shadow-sm flex flex-col items-center text-center">
                                          <stat.icon className="h-6 w-6 text-violet-700 mb-3" />
                            <span className="text-3xl font-black text-zinc-900">{stat.value}</span>
                            <span className="text-[10px] font-black text-zinc-400 uppercase tracking-widest mt-1">{stat.label}</span>
                         </div>
                       ))}
                    </div>

                              <div className="grid md:grid-cols-2 gap-4">
                                  <div className="bg-white p-6 rounded-2xl border border-violet-100">
                                     <h3 className="text-base font-black text-zinc-900 flex items-center gap-2"><Rocket className="h-4 w-4 text-violet-700" /> Processing Details</h3>
                                     <div className="mt-4 space-y-2 text-sm">
                                        {/* Which mode and which population. Without these a fast
                                            run and a slow one looked identical here, and a
                                            126s slow run read as fast mode being slow. */}
                                        <p className="text-zinc-600"><span className="font-semibold text-zinc-900">Mode:</span> {result.mode === 'fast' ? 'Fast — pipeline bypassed' : 'Slow — full pipeline'}</p>
                                        <p className="text-zinc-600"><span className="font-semibold text-zinc-900">Population:</span> {result.population || (result.createAccounts ? 'created' : 'existing')}</p>
                                        <p className="text-zinc-600"><span className="font-semibold text-zinc-900">Runtime:</span> {((result.runMs || 0) / 1000).toFixed(2)}s</p>
                                        {result.throughputEventsPerSec ? (
                                           <p className="text-zinc-600"><span className="font-semibold text-zinc-900">Throughput:</span> {result.throughputEventsPerSec} events/sec</p>
                                        ) : null}
                                        <p className="text-zinc-600"><span className="font-semibold text-zinc-900">Users requested:</span> {result.requestedUsers ?? count}</p>
                                        {/* On a reuse run nothing is created, so "Users created: 0"
                                            alone reads as a failed run. Say how many were simulated. */}
                                        <p className="text-zinc-600"><span className="font-semibold text-zinc-900">Users simulated:</span> {result.simulatedUsers ?? result.usersCreated ?? 0}</p>
                                        <p className="text-zinc-600"><span className="font-semibold text-zinc-900">New accounts created:</span> {result.usersCreated ?? 0}</p>
                                        <p className="text-zinc-600"><span className="font-semibold text-zinc-900">Transactions:</span> {result.transactionsCreated ?? 0}</p>
                                        <p className="text-zinc-600"><span className="font-semibold text-zinc-900">Events:</span> {result.eventsCreated ?? 0}</p>
                                     </div>
                                  </div>

                                  <div className="bg-black p-6 rounded-2xl text-white">
                                     <h3 className="text-base font-black tracking-tight flex items-center gap-2"><Server className="h-4 w-4 text-violet-300" /> Analytics Propagation</h3>
                                     <p className="text-violet-100 text-sm mt-3 leading-relaxed">
                                        Simulation completed for tenant <span className="font-semibold text-white">{result.resolvedTenant || tenantId}</span>. Generated records are now available in Admin processing queues and are pushed to analytics ingestion for dashboard updates.
                                     </p>
                                     <div className="mt-4 text-xs text-violet-200 space-y-1">
                                        <p>Simulated days: {result.simulatedDays ?? 0}</p>
                                        <p>Payees linked: {result.payeesCreated ?? 0}</p>
                                        <p>Loan Applications created: {result.applicationsCreated ?? result.loansApplied ?? 0}</p>
                                     </div>
                                  </div>
                              </div>

                              <div className="bg-white p-6 rounded-2xl border border-violet-100">
                                  <div className="flex gap-6 items-start">
                          <div>
                                           <h3 className="text-xl font-black tracking-tight text-zinc-900 flex items-center gap-2"><BarChart3 className="h-5 w-5 text-violet-700" /> Records Live</h3>
                                           <p className="text-zinc-600 font-medium mt-1 leading-relaxed">
                                                This simulation run has completed and the generated data is now queryable across admin processing and analytics surfaces.
                             </p>
                                           <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                                              <div className="rounded-xl bg-violet-50 border border-violet-100 p-3">
                                                 <p className="text-zinc-500">Compliant</p>
                                                 <p className="text-xl font-black text-zinc-900">{result.compliantUsers ?? result.kycCompleted ?? 0}</p>
                                              </div>
                                              <div className="rounded-xl bg-violet-50 border border-violet-100 p-3">
                                                 <p className="text-zinc-500">Analytics Opt-in</p>
                                                 <p className="text-xl font-black text-zinc-900">{result.analyticsOptInUsers ?? result.fullyCompleted ?? 0}</p>
                                              </div>
                                              <div className="rounded-xl bg-violet-50 border border-violet-100 p-3">
                                                 <p className="text-zinc-500">Run Duration</p>
                                                 <p className="text-xl font-black text-zinc-900 flex items-center gap-1"><Clock3 className="h-4 w-4 text-violet-700" /> {((result.runMs || 0) / 1000).toFixed(2)}s</p>
                                              </div>
                                           </div>
                          </div>
                       </div>
                    </div>
                 </div>
              )}
           </div>
        </div>
      </div>
    </AdminGuard>
  )
}
