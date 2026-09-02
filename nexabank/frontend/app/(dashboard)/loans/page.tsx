"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useScrollAnimation } from "@/hooks/useScrollAnimation";
import {
  ArrowRight,
  Calculator,
  Clock,
  IndianRupee,
  PercentIcon,
  FileText,
  AlertCircle,
  RefreshCw,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEffect, useState, memo, useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { UserData } from "@/components/context/UserContext";
import { useRouter } from "next/navigation";
import axios from "axios";
import { API_BASE_URL } from "@/lib/api";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApplyLoanForm } from "@/components/loans/ApplyLoanForm";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useEventTracker } from "@/hooks/useEventTracker";

const Loans = () => {
  const { ref, isInView } = useScrollAnimation();
  const { track } = useEventTracker();

  useEffect(() => {
    track('loans.page.view');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [showApplyModal, setShowApplyModal] = useState(false);
  const [selectedLoanType, setSelectedLoanType] = useState("PERSONAL");
  const [applications, setApplications] = useState<any[]>([]);
  const [fetchingApps, setFetchingApps] = useState(false);
  const [expandedApp, setExpandedApp] = useState<string | null>(null);

  // Approve flow state
  const [showApproveDialog, setShowApproveDialog] = useState(false);
  const [approvingApp, setApprovingApp] = useState<any>(null);
  const [approveAccNo, setApproveAccNo] = useState("");
  const [userAccounts, setUserAccounts] = useState<any[]>([]);
  const [actionLoading, setActionLoading] = useState(false);

  const loanFeatures = [
    {
      title: "Competitive Rates",
      description: "Get some of the lowest rates on the market, with transparent terms and no hidden fees.",
    },
    {
      title: "Quick Approval",
      description: "Apply online and get pre-approved in minutes with our streamlined application process.",
    },
    {
      title: "Payment Protection",
      description: "Optional payment protection to safeguard your loan in case of unexpected life events.",
    },
    {
      title: "Flexible Terms",
      description: "Choose payment terms that fit your budget with options from 12 to 84 months.",
    },
  ];

  const loanTypes = [
    { title: "Home Loans", type: "HOME", description: "Make your dream home a reality.", interestRate: 8.5, features: ["Fixed & adjustable rates", "First-time homebuyer programs", "Low down payment"] },
    { title: "Auto Loans", type: "AUTO", description: "Drive your perfect vehicle today.", interestRate: 9.2, features: ["New and used vehicles", "Terms up to 72 months", "Pre-approval available"] },
    { title: "Personal Loans", type: "PERSONAL", description: "Get the funds you need fast.", interestRate: 10.5, features: ["Fixed monthly payments", "No collateral required", "Funds as soon as same day"] },
    { title: "Student Loans", type: "STUDENT", description: "Invest in your education.", interestRate: 8.0, features: ["Undergraduate & graduate", "Deferred payment options", "Refinancing available"] },
  ];

  const [amount, setAmount] = useState(50000);
  const [interest, setInterest] = useState(10.5);
  const [term, setTerm] = useState(2);

  useEffect(() => {
    const t = setTimeout(() => {
      track('loans.emi_estimator.success');
    }, 1500);
    return () => clearTimeout(t);
  }, [amount, interest, term, track]);

  const { isAuth, isAuthLoading, userId } = UserData();
  const router = useRouter();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isAuth) {
      if (!isAuthLoading) router.push("/login");
    }
  }, [isAuth, isAuthLoading, router]);

  useEffect(() => {
    let isMounted = true;
    const fetchAllData = async () => {
      if (!userId || !isAuth) return;
      try {
        setFetchingApps(true);
        const appsRes = await axios.get(`${API_BASE_URL}/applications/${userId}`, { withCredentials: true });
        if (isMounted) setApplications(appsRes.data || []);

        const accRes = await axios.get(`${API_BASE_URL}/customers/accounts/${userId}`, { withCredentials: true });
        if (isMounted) setUserAccounts(accRes.data || []);
      } catch (err) {
        console.error("Fetch data error:", err);
      } finally {
         if (isMounted) {
            setFetchingApps(false);
            setLoading(false);
         }
      }
    };
    
    if (userId) fetchAllData();
    
    return () => { isMounted = false; };
  }, [userId]);

  const fetchApplications = async () => {
    if (!userId) return;
    setFetchingApps(true);
    try {
      const res = await axios.get(`${API_BASE_URL}/applications/${userId}`, { withCredentials: true });
      setApplications(res.data || []);
    } catch (error) {
      console.error("Fetch apps error:", error);
    } finally {
      setFetchingApps(false);
    }
  };

  const fetchUserAccounts = async () => {
    if (!userId) return;
    try {
      const res = await axios.get(`${API_BASE_URL}/customers/accounts/${userId}`, { withCredentials: true });
      setUserAccounts(res.data || []);
    } catch (error) {
      console.error("Fetch accounts error:", error);
    }
  };

  const handleApplyNow = (loanType: string = "PERSONAL") => {
    setSelectedLoanType(loanType);
    setShowApplyModal(true);
    track('loans.apply_loan.success');
  };

  const onApplicationSuccess = () => {
    setShowApplyModal(false);
    fetchApplications();
  };

  if (loading || isAuthLoading || !isAuth) {
    return (
      <div className="flex flex-col min-h-screen animate-fade-in pb-20 p-8 space-y-12">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
          <div className="space-y-6">
            <Skeleton className="h-8 w-48 rounded-full bg-zinc-200" />
            <Skeleton className="h-16 w-3/4 bg-zinc-200 rounded-xl" />
            <Skeleton className="h-20 w-full bg-zinc-100 rounded-xl" />
            <Skeleton className="h-14 w-48 rounded-full bg-zinc-200" />
          </div>
          <Skeleton className="h-[400px] w-full rounded-3xl bg-zinc-100" />
        </div>
      </div>
    );
  }

  const calculateEMI = () => {
    const p = amount;
    const r = (interest / 100) / 12;
    const n = term * 12;
    if (r === 0) return p / n;
    const emi = p * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
    return isNaN(emi) || !isFinite(emi) ? 0 : emi;
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'APPROVED': return 'bg-emerald-00 text-emerald-700 border-emerald-200';
      case 'REJECTED': return 'bg-rose-100 text-rose-700 border-rose-200';
      case 'KYC_PENDING': return 'text-white';
      default: return 'bg-blue-100 text-blue-700 border-blue-200';
    }
  };

  return (
    <div className="flex flex-col min-h-screen animate-fade-in pb-20">
      <main className="flex-grow">
        {/* Hero Section */}
        <section className="relative mt-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            <div>
              <h1 className="text-4xl md:text-4xl lg:text-5xl font-extrabold mb-6 tracking-tight text-zinc-900 leading-[1.1]">
                Smart financing for <br/> <span className="text-4xl">your</span> {" "}
                <span className="text-4xl text-transparent bg-clip-text bg-gradient-to-r from-violet-600 to-purple-500">
                   biggest ambitions
                </span>
              </h1>
              <p className="text-lg text-muted-foreground mb-8 max-w-lg leading-relaxed font-medium">
                Whether it's your dream home or professional growth, our lending platform 
                ensures quick decisions with minimal paperwork.
              </p>
              <div className="flex flex-col sm:flex-row gap-4">
                <Button size="lg" className="h-14 px-8 rounded-full group bg-violet-600 hover:bg-violet-700 text-white shadow-xl hover:shadow-violet-200/50 transition-all cursor-pointer font-bold text-lg" onClick={() => handleApplyNow()}>
                  Apply for a Loan
                  <ArrowRight className="ml-2 h-5 w-5 transition-transform group-hover:translate-x-1" />
                </Button>
              </div>
            </div>

            {/* EMI Calculator */}
            <div className="relative rounded-xl border border-violet-100 bg-white/80 backdrop-blur-2xl shadow-2xl p-8 md:p-10 z-10 transition-all hover:shadow-violet-100 duration-500 group">
              <div className="absolute top-0 right-0 w-full h-3.5  bg-gradient-to-r from-violet-400 to-purple-500 rounded-t-2xl"></div>
              <h3 className="text-2xl font-bold mb-8 text-zinc-900  flex items-center gap-3">
                <div className="p-2 bg-violet-100 rounded-lg"><Calculator className="h-6 w-6 text-violet-600" /></div>
                EMI Estimator
              </h3>
              <div className="space-y-8 mb-10">
                <div className="space-y-6">
                  <div className="space-y-3">
                    <div className="flex justify-between items-center">
                      <Label htmlFor="amount" className="text-zinc-600 font-bold uppercase text-[10px] tracking-widest">Loan Amount</Label>
                      <span className="text-violet-700 font-bold">₹{amount.toLocaleString()}</span>
                    </div>
                    <div className="relative">
                      <IndianRupee className="absolute left-4 top-3.5 h-4 w-4 text-violet-400" />
                      <Input
                        min="1000"
                        step="5000"
                        id="amount"
                        type="number"
                        value={amount}
                        onChange={(e) => setAmount(Number(e.target.value))}
                        className="pl-12 rounded-2xl bg-gray-100/50 border-gray-100 focus:border-violet-500 focus:ring-violet-500 h-12 text-lg font-bold"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-6">
                    <div className="space-y-3">
                      <Label htmlFor="interest" className="text-zinc-600 font-bold uppercase text-[10px] tracking-widest">Rate (%)</Label>
                      <div className="relative">
                        <Input
                          min="0"
                          step="0.1"
                          id="interest"
                          type="number"
                          value={interest}
                          onChange={(e) => setInterest(Number(e.target.value))}
                          className="pr-10 rounded-2xl bg-gray-100/50 border-gray-100 focus:border-violet-500 font-bold h-12"
                        />
                        <PercentIcon className="absolute right-4 top-3.5 h-4 w-4 text-violet-400" />
                      </div>
                    </div>
                    <div className="space-y-3">
                      <Label htmlFor="term" className="text-zinc-600 font-bold uppercase text-[10px] tracking-widest">Term (Years)</Label>
                      <div className="relative">
                        <Input
                          min="1"
                          max="30"
                          id="term"
                          type="number"
                          value={term}
                          onChange={(e) => setTerm(Number(e.target.value))}
                          className="rounded-2xl bg-gray-100/50 border-gray-100 focus:border-violet-500 font-bold h-12"
                        />
                        <Clock className="absolute right-4 top-3.5 h-4 w-4 text-violet-400" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="p-6 bg-gradient-to-br from-violet-600 to-purple-700 rounded-2xl shadow-lg relative overflow-hidden text-white">
                <div className="absolute -top-10 -right-10 p-4 opacity-10">
                  <IndianRupee className="h-40 w-40" />
                </div>
                <div className="flex flex-col gap-1 relative z-10">
                  <span className="text-xs font-bold text-white/70 tracking-widest uppercase">Monthly Installment</span>
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-extrabold">₹{Math.round(calculateEMI()).toLocaleString('en-IN')}</span>
                    <span className="text-sm font-medium text-white/50">/month*</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>


         {/* Application History Section */}
        <section className="my-20">
          <div className="flex items-center justify-between mb-10">
            <div className="flex items-center gap-4">
              <h2 className="text-4xl font-black text-zinc-900">Application History</h2>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={fetchApplications}
              disabled={fetchingApps}
              className="rounded-xl hover:bg-violet-50 text-violet-600"
            >
              <RefreshCw className={`h-5 w-5 ${fetchingApps ? 'animate-spin' : ''}`} />
            </Button>
          </div>

          {fetchingApps ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
              {[1,2,3].map(i => (
                <Card key={i} className="rounded-[2.5rem] border-zinc-100 overflow-hidden shadow-sm">
                  <Skeleton className="h-2 w-full bg-zinc-200" />
                  <CardContent className="p-8">
                    <div className="flex justify-between items-start mb-6">
                      <div className="space-y-2">
                        <Skeleton className="h-3 w-20 bg-zinc-200 rounded" />
                        <Skeleton className="h-8 w-32 bg-zinc-200 rounded" />
                      </div>
                      <Skeleton className="h-6 w-20 bg-zinc-200 rounded-xl" />
                    </div>
                    <div className="space-y-3 mb-6">
                      <Skeleton className="h-4 w-full bg-zinc-100 rounded" />
                      <Skeleton className="h-4 w-full bg-zinc-100 rounded" />
                      <Skeleton className="h-4 w-full bg-zinc-100 rounded" />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : applications.length === 0 ? (
            <div className="p-20 border-4 border-dashed border-gray-100 rounded-[3rem] text-center bg-gray-100/30">
              <AlertCircle className="h-12 w-12 text-zinc-300 mx-auto mb-4" />
              <p className="text-xl font-bold text-zinc-400 italic">No active loan applications found.</p>
              <p className="text-sm text-zinc-400 mt-2">Submit your first application to see it here.</p>
              <Button onClick={() => handleApplyNow()} className="mt-6 bg-violet-600 hover:bg-violet-700 text-white rounded-2xl px-6">
                Apply Now
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
              {applications.map((app) => (
                <Card key={app.id} className="rounded-[2.5rem] border-violet-100 overflow-hidden shadow-sm hover:shadow-xl transition-all">
                  <div className={`h-2 ${getStatusColor(app.status)} brightness-75`}></div>
                  <CardContent className="p-8">
                    <div className="flex justify-between items-start mb-6">
                      <div>
                        <p className="text-[10px] font-black text-zinc-400 uppercase mb-1">{app.loanType} LOAN</p>
                        <h4 className="text-2xl font-black text-zinc-900">₹{app.principalAmount.toLocaleString()}</h4>
                      </div>
                      <Badge className={`${getStatusColor(app.status)} border rounded-xl px-3 py-1 font-black text-[10px]`}>
                        {app.status}
                      </Badge>
                    </div>
                    <div className="space-y-3 mb-6 text-sm font-bold text-zinc-500 italic">
                      <div className="flex justify-between"><span>Term:</span> <span>{app.term} Months</span></div>
                      <div className="flex justify-between"><span>Rate:</span> <span>{app.interestRate}%</span></div>
                      <div className="flex justify-between"><span>Applied:</span> <span>{new Date(app.createdOn).toLocaleDateString('en-IN')}</span></div>
                    </div>

                    {/* KYC Details Dropdown */}
                    {app.kycData && Object.keys(app.kycData).length > 0 && (
                      <button
                        className="w-full flex items-center justify-between text-xs text-violet-600 font-bold mb-4 hover:text-violet-800 transition-colors"
                        onClick={() => setExpandedApp(expandedApp === app.id ? null : app.id)}
                      >
                        <span>KYC Details</span>
                        {expandedApp === app.id ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                      </button>
                    )}
                    {expandedApp === app.id && app.kycData && (
                      <div className="mb-4 bg-gray-100 rounded-2xl p-4 text-xs space-y-1.5 border border-gray-100">
                        {Object.entries(app.kycData).map(([key, value]) => (
                          <div key={key} className="flex justify-between">
                            <span className="text-zinc-400 font-bold uppercase">{key}:</span>
                            <span className="text-zinc-700 font-semibold">{String(value) || '—'}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Admin actions hidden from user dashboard */}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>

        {/* Loan Types Grid */}
        <section className="mt-24 mb-16">
          <div className="text-center mb-12">
            <h2 className="text-sm font-black tracking-widest text-violet-600 uppercase mb-3">Tailored Solutions</h2>
            <h3 className="text-3xl md:text-4xl font-extrabold text-zinc-900">Choose the perfect loan for your needs</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-20 mx-10">
            {loanTypes.map((loan) => (
              <Card key={loan.type} className="border-zinc-100 shadow-sm hover:shadow-xl hover:border-violet-200 transition-all duration-300 overflow-hidden">
                <div className="h-2 w-full bg-gradient-to-r from-violet-500 to-purple-500 group-hover:h-3 transition-all" />
                <CardContent className="p-8 pb-10">
                  <h4 className="text-2xl font-black text-zinc-900 mb-2">{loan.title}</h4>
                  <p className="text-zinc-500 text-sm font-medium h-10">{loan.description}</p>
                  <div className="mt-6 mb-8 p-4 bg-violet-50 rounded-2xl border border-violet-100/50">
                    <p className="text-[10px] font-black uppercase text-violet-600 tracking-widest mb-1">Starting At</p>
                    <p className="text-3xl font-extrabold text-violet-700">{loan.interestRate}% <span className="text-sm font-bold opacity-60">APR</span></p>
                  </div>
                  <ul className="space-y-3 mb-8">
                    {loan.features.map((feature, i) => (
                      <li key={i} className="flex items-start text-sm font-semibold text-zinc-600">
                        <CheckCircle2 className="h-4 w-4 text-emerald-500 mr-2 shrink-0 mt-0.5" />
                        {feature}
                      </li>
                    ))}
                  </ul>
                  <Button 
                    variant="outline" 
                    className="w-full rounded-xl border-2 border-violet-100 text-violet-700 hover:bg-violet-600 hover:text-white hover:border-violet-600 transition-colors cursor-pointer font-bold h-12"
                    onClick={() => handleApplyNow(loan.type)}
                  >
                    Apply Now
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* Features Section */}
        <section className="py-16 px-4 md:px-12 bg-zinc-900 rounded-[3rem] text-white shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 right-0 w-96 h-96 bg-violet-600 blur-[150px] opacity-20" />
          <div className="absolute bottom-0 left-0 w-96 h-96 bg-purple-600 blur-[150px] opacity-20" />
          
          <div className="relative z-10 text-center max-w-2xl mx-auto mb-16">
            <h2 className="text-sm font-black tracking-widest text-violet-400 uppercase mb-3">The NexaBank Advantage</h2>
            <h3 className="text-3xl md:text-5xl font-extrabold">Why thousands trust us with their financial goals</h3>
          </div>
          
          <div className="relative z-10 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
            {loanFeatures.map((feature, index) => (
              <div key={index} className="bg-white/5 border border-white/10 p-8 rounded-3xl backdrop-blur-sm hover:bg-white/10 transition-colors">
                <h4 className="text-xl font-bold mb-3">{feature.title}</h4>
                <p className="text-zinc-400 text-sm leading-relaxed font-medium">{feature.description}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      {/* Apply Loan Modal */}
      <Dialog open={showApplyModal} onOpenChange={setShowApplyModal}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto rounded-tl-[2rem] rounded-bl-[2rem] p-6 md:p-8 border-none">
          <DialogHeader className="mb-6">
            <DialogTitle className="text-2xl font-black text-zinc-900 tracking-tight">Loan Application</DialogTitle>
          </DialogHeader>
          <ApplyLoanForm userId={userId || ""} onSuccess={onApplicationSuccess} initialLoanType={selectedLoanType} />
        </DialogContent>
      </Dialog>

      {/* Admin Approval Dialog removed for user security */}
    </div>
  );
};

export default Loans;
