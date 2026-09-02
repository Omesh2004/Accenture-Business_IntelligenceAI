"use client"

import { useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { 
  CheckCircle2, 
  ChevronRight, 
  ChevronLeft, 
  Loader2, 
  ShieldCheck, 
  IndianRupee, 
  Percent,
  Briefcase,
  IdCard,
  LockKeyhole,
  Check,
  FileText,
  Info
} from "lucide-react"
import { toast } from "sonner"
import axios from "axios"
import { API_BASE_URL } from "@/lib/api"
import { UserData } from "@/components/context/UserContext"
import { cn } from "@/lib/utils"
import { useEventTracker } from "@/hooks/useEventTracker"

interface ApplyLoanFormProps {
  userId: string
  onSuccess: () => void
  initialLoanType?: string
}

const interestRates: Record<string, number> = {
  HOME: 8.5,
  AUTO: 9.2,
  PERSONAL: 10.5,
  STUDENT: 8.0,
}

export function ApplyLoanForm({ userId, onSuccess, initialLoanType = "PERSONAL" }: ApplyLoanFormProps) {
  const { pan } = UserData()
  const { track, measureAndTrack } = useEventTracker()
  const [step, setStep] = useState(1)
  const [loading, setLoading] = useState(false)
  
  const [formData, setFormData] = useState({
    loanType: initialLoanType,
    amount: 50000,
    term: 12,
    pan: pan || "",
    aadhaar: "",
    income: "",
    employment: "Salaried",
  })

  // Calculations
  const calcEMI = () => {
    const p = formData.amount;
    const r = (interestRates[formData.loanType] / 100) / 12;
    const n = formData.term;
    if (r === 0) return p / n;
    const emi = p * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
    return isNaN(emi) || !isFinite(emi) ? 0 : Math.round(emi);
  }

  const nextStep = () => {
    if (step === 1 && (formData.amount < 1000 || formData.amount > 50000000)) {
      toast.error("Please enter a valid loan amount between ₹1,000 and ₹5Cr");
      return;
    }
    if (step === 2 && (!formData.pan || !formData.aadhaar || !formData.income)) {
      toast.error("Please fill in all details to proceed.");
      return;
    }
    if (step === 1) track('loans.proceed_to_kyc.success');
    setStep(s => s + 1)
  }
  
  const prevStep = () => setStep(s => s - 1)

  const handleApply = async () => {
    setLoading(true)
    try {
      await measureAndTrack('loans.submit_application', async () => {
        await axios.post(`${API_BASE_URL}/apply`, {
          customerId: userId,
          loanType: formData.loanType,
          principalAmount: Number(formData.amount),
          term: Number(formData.term),
          interestRate: interestRates[formData.loanType],
          kycData: {
            pan: formData.pan,
            aadhaar: formData.aadhaar,
            income: formData.income,
            employment: formData.employment
          }
        }, { withCredentials: true });
      });

      toast.success("Application submitted! Our team will review it shortly.")
      onSuccess()
    } catch (error: any) {
      console.error("Application error:", error)
      toast.error(error.response?.data?.error || "Failed to submit application")
    } finally {
      setLoading(false)
    }
  }

  // --- Animation Variants ---
  const slideVariants = {
    enter: (direction: number) => ({
      x: direction > 0 ? 40 : -40,
      opacity: 0,
      filter: "blur(4px)"
    }),
    center: {
      zIndex: 1,
      x: 0,
      opacity: 1,
      filter: "blur(0px)"
    },
    exit: (direction: number) => ({
      zIndex: 0,
      x: direction < 0 ? 40 : -40,
      opacity: 0,
      filter: "blur(4px)"
    })
  };

  const renderStep = () => {
    switch (step) {
      case 1:
        return (
          <motion.div 
            key="step1"
            custom={1}
            variants={slideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="space-y-4"
          >
            <div>
              <h3 className="text-xl font-bold text-zinc-900 tracking-tight">Configure Your Loan</h3>
              <p className="text-zinc-500 text-xs mt-1">Adjust the amount and duration that best fits your needs.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-4">
                {/* Loan Type Selector */}
                <div className="space-y-3">
                  <Label className="uppercase text-[11px] tracking-widest text-zinc-400 font-bold">Category</Label>
                  <Select value={formData.loanType} onValueChange={(v) => setFormData({...formData, loanType: v})}>
                    <SelectTrigger className="w-full h-11 rounded-2xl bg-zinc-50/50 border border-gray-200 shadow-sm focus:ring-violet-500 focus:border-violet-500 text-base font-semibold hover:bg-white transition-all cursor-pointer">
                      <SelectValue placeholder="Select loan type" />
                    </SelectTrigger>
                    <SelectContent className="rounded-xl border-gray-100 shadow-xl">
                      <SelectItem className="cursor-pointer" value="PERSONAL">Personal Loan <span className="text-muted-foreground font-normal ml-1">({interestRates.PERSONAL}%)</span></SelectItem>
                      <SelectItem className="cursor-pointer" value="HOME">Home Loan <span className="text-muted-foreground font-normal ml-1">({interestRates.HOME}%)</span></SelectItem>
                      <SelectItem className="cursor-pointer" value="AUTO">Auto Loan <span className="text-muted-foreground font-normal ml-1">({interestRates.AUTO}%)</span></SelectItem>
                      <SelectItem className="cursor-pointer" value="STUDENT">Student Loan <span className="text-muted-foreground font-normal ml-1">({interestRates.STUDENT}%)</span></SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Amount Input */}
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <Label className="uppercase text-[11px] tracking-widest text-zinc-400 font-bold">Amount Needed</Label>
                    <span className="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-100 flex items-center tracking-widest uppercase">
                      <CheckCircle2 className="w-3 h-3 mr-1 inline" /> Eligible
                    </span>
                  </div>
                  <div className="relative group">
                    <div className="absolute inset-y-0 left-0 pl-5 flex items-center pointer-events-none">
                      <IndianRupee className="h-6 w-6 text-zinc-400 group-focus-within:text-violet-500 transition-colors" />
                    </div>
                    <Input 
                      type="number" 
                      value={formData.amount}
                      onChange={(e) => setFormData({...formData, amount: Number(e.target.value)})}
                      className="pl-14 h-12 rounded-2xl border-gray-200 shadow-sm text-xl font-bold tracking-tight text-zinc-900 focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 transition-all bg-white"
                    />
                  </div>
                </div>

                {/* Term Selection Grid */}
                <div className="space-y-3">
                  <Label className="uppercase text-[11px] tracking-widest text-zinc-400 font-bold">Tenure Mode</Label>
                  <div className="grid grid-cols-2 gap-3">
                    {[12, 24, 36, 60].map((t) => (
                      <button
                        key={t}
                        onClick={() => setFormData({...formData, term: t})}
                        className={cn(
                          "h-12 rounded-2xl flex flex-col items-center justify-center border font-semibold transition-all duration-300 cursor-pointer",
                          formData.term === t 
                            ? "bg-zinc-900 border-zinc-900 text-white shadow-lg shadow-zinc-200 scale-105 z-10" 
                            : "bg-white border-gray-200 text-zinc-600 hover:border-violet-300 hover:text-violet-600"
                        )}
                      >
                         <span className="text-xl leading-none">{t}</span>
                         <span className="text-[9px] opacity-70 uppercase tracking-[0.2em] mt-1 font-bold">Months</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Live Estimate Card */}
              <div>
                <motion.div 
                  className="h-auto rounded-[1.5rem] bg-zinc-900 p-5 text-white shadow-xl relative overflow-hidden flex flex-col justify-between border border-zinc-800"
                  layoutId="summary-card"
                >
                  <div className="absolute top-0 right-0 p-4 opacity-5">
                    <Percent className="w-56 h-56 rotate-12" />
                  </div>
                  
                  <div className="relative z-10 flex flex-col h-full justify-between">
                    <div>
                      <div className="space-y-1">
                        <p className="text-white/50 text-[10px] font-bold tracking-[0.2em] uppercase">Monthly EMI</p>
                        <h4 className="text-3xl lg:text-4xl font-black tracking-tighter text-transparent bg-clip-text bg-gradient-to-br from-white to-white/70">
                          ₹{calcEMI().toLocaleString('en-IN')}
                        </h4>
                      </div>
                    </div>
                    
                    <div className="pt-4 mt-4 border-t border-white/10">
                      <div className="grid grid-cols-2 gap-6">
                        <div>
                          <p className="text-white/50 text-[10px] font-bold tracking-[0.2em] uppercase mb-1">Interest Rate</p>
                          <p className="text-2xl font-semibold tracking-tight">{interestRates[formData.loanType]}% <span className="text-sm font-medium text-white/40">p.a.</span></p>
                        </div>
                        <div>
                          <p className="text-white/50 text-[10px] font-bold tracking-[0.2em] uppercase mb-1">Total Interest</p>
                          <p className="text-lg font-semibold tracking-tight">₹{Math.round((calcEMI() * formData.term) - formData.amount).toLocaleString('en-IN')}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </motion.div>
              </div>
            </div>

            <div className="pt-6 flex justify-end">
              <Button onClick={nextStep} className="h-11 px-8 rounded-2xl bg-violet-600 hover:bg-violet-700 text-white font-bold text-base shadow-xl hover:shadow-violet-200 transition-all cursor-pointer group">
                Proceed to KYC <ChevronRight className="ml-2 h-5 w-5 group-hover:translate-x-1 transition-transform" />
              </Button>
            </div>
          </motion.div>
        )
      case 2:
        return (
          <motion.div 
            key="step2"
            custom={1}
            variants={slideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="space-y-4"
          >
            <div>
              <h3 className="text-xl font-bold text-zinc-900 tracking-tight">KYC Verification</h3>
              <p className="text-zinc-500 text-xs mt-1">Please provide accurate details as per your government records.</p>
            </div>

            <div className="bg-emerald-50/50 border border-emerald-100 p-4 rounded-xl flex gap-3 items-center">
              <div className="h-8 w-8 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center shrink-0">
                <LockKeyhole className="h-4 w-4" />
              </div>
              <div>
                <p className="text-xs font-bold text-zinc-900">Bank-Grade Encryption</p>
                <p className="text-[10px] text-zinc-500 font-medium">Your data is heavily encrypted and protected using TLS 1.3 compliance standards.</p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-3">
                  <Label className="uppercase text-[11px] tracking-widest text-zinc-400 font-bold">PAN Number</Label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                      <IdCard className="h-5 w-5 text-zinc-400" />
                    </div>
                    <Input 
                      placeholder="ABCDE1234F"
                      value={formData.pan}
                      onChange={(e) => setFormData({...formData, pan: e.target.value.toUpperCase()})}
                      className="pl-12 h-11 rounded-xl border-gray-200 shadow-sm uppercase font-mono tracking-wider focus:ring-violet-500 focus:border-violet-500"
                      maxLength={10}
                    />
                    {formData.pan.length === 10 && (
                      <div className="absolute inset-y-0 right-0 pr-4 flex items-center pointer-events-none">
                         <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                      </div>
                    )}
                  </div>
                </div>

                <div className="space-y-3">
                  <Label className="uppercase text-[11px] tracking-widest text-zinc-400 font-bold">Aadhaar Number</Label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                      <IdCard className="h-5 w-5 text-zinc-400" />
                    </div>
                    <Input 
                      placeholder="XXXX XXXX XXXX"
                      value={formData.aadhaar}
                      onChange={(e) => setFormData({...formData, aadhaar: e.target.value.replace(/\D/g, "")})}
                      className="pl-12 h-11 rounded-xl border-gray-200 shadow-sm font-mono tracking-wider focus:ring-violet-500 focus:border-violet-500"
                      maxLength={12}
                    />
                    {formData.aadhaar.length === 12 && (
                      <div className="absolute inset-y-0 right-0 pr-4 flex items-center pointer-events-none">
                         <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-3">
                  <Label className="uppercase text-[11px] tracking-widest text-zinc-400 font-bold">Annual Income (₹)</Label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                      <Briefcase className="h-5 w-5 text-zinc-400" />
                    </div>
                    <Input 
                      type="number"
                      placeholder="e.g. 1200000"
                      value={formData.income}
                      onChange={(e) => setFormData({...formData, income: e.target.value})}
                      className="pl-12 h-11 rounded-xl border-gray-200 shadow-sm font-bold tracking-tight focus:ring-violet-500 focus:border-violet-500"
                    />
                  </div>
                </div>
                
                <div className="space-y-3">
                  <Label className="uppercase text-[11px] tracking-widest text-zinc-400 font-bold">Employment Type</Label>
                  <Select value={formData.employment} onValueChange={(v) => setFormData({...formData, employment: v})}>
                    <SelectTrigger className="w-full h-11 rounded-xl border border-gray-200 shadow-sm focus:ring-violet-500 cursor-pointer text-base">
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                    <SelectContent className="rounded-xl border-gray-100">
                      <SelectItem className="cursor-pointer" value="Salaried">Salaried Professional</SelectItem>
                      <SelectItem className="cursor-pointer" value="Self-Employed">Self-Employed / Business</SelectItem>
                      <SelectItem className="cursor-pointer" value="Freelancer">Freelancer / Consultant</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
            
            <div className="pt-6 flex gap-4">
              <Button variant="outline" onClick={prevStep} className="flex-1 h-11 rounded-2xl border-gray-200 font-bold text-zinc-600 hover:bg-gray-100 cursor-pointer">
                <ChevronLeft className="mr-2 h-5 w-5" /> Back
              </Button>
              <Button onClick={nextStep} className="flex-[2] h-11 rounded-2xl bg-zinc-900 hover:bg-black text-white shadow-xl hover:shadow-zinc-300 transition-all font-bold text-base cursor-pointer">
                Review Application <ChevronRight className="ml-2 h-5 w-5" />
              </Button>
            </div>
          </motion.div>
        )
      case 3:
        return (
          <motion.div 
            key="step3"
            custom={1}
            variants={slideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="space-y-4"
          >
            <div>
              <h3 className="text-xl font-bold text-zinc-900 tracking-tight">Final Review</h3>
              <p className="text-zinc-500 text-xs mt-1">Please verify all terms before submitting your application.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Left Column: Loan Info */}
              <div className="space-y-4">
                <div className="bg-gray-100/70 p-4 rounded-2xl border border-gray-100">
                  <div className="flex items-center gap-2 mb-4 pb-3 border-b border-gray-200/60">
                     <div className="p-2 bg-violet-100 text-violet-600 rounded-lg">
                       <FileText className="h-4 w-4" />
                     </div>
                     <span className="font-bold text-sm text-zinc-900">Application Details</span>
                  </div>
                  <div className="space-y-5">
                    <div className="flex justify-between items-center">
                      <span className="text-xs font-semibold uppercase tracking-widest text-zinc-400">Type</span>
                      <span className="font-bold text-zinc-900 bg-white px-3 py-1 rounded-lg border border-gray-100 shadow-sm">{formData.loanType}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-xs font-semibold uppercase tracking-widest text-zinc-400">Amount</span>
                      <span className="font-bold text-zinc-900 text-lg">₹{formData.amount.toLocaleString('en-IN')}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-xs font-semibold uppercase tracking-widest text-zinc-400">Duration</span>
                      <span className="font-bold text-zinc-900">{formData.term} Months</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-xs font-semibold uppercase tracking-widest text-zinc-400">APR</span>
                      <span className="font-bold text-emerald-600 bg-emerald-50 px-3 py-1 rounded-lg">{interestRates[formData.loanType]}% p.a.</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Right Column: KYC Info & EMI */}
              <div className="space-y-4">
                <div className="bg-violet-600 p-4 rounded-2xl text-white shadow-xl shadow-violet-200">
                  <div className="flex items-center gap-2 mb-1">
                     <span className="text-xs font-semibold tracking-wide text-white/80">Your Estimated EMI</span>
                  </div>
                  <h4 className="text-3xl font-black tracking-tight mb-3">₹{calcEMI().toLocaleString('en-IN')} <span className="text-xs font-medium text-white/60">/mo</span></h4>
                  
                  <div className="bg-black/20 rounded-lg p-3 flex gap-3 text-[10px] font-medium border border-white/10 mt-4">
                    <Info className="h-4 w-4 shrink-0 text-white/60" />
                    <span className="text-white/80 leading-relaxed">This EMI estimation assumes immediate disbursal. Final details will be present in your sanction letter.</span>
                  </div>
                </div>

                <div className="bg-gray-100/70 p-4 rounded-2xl border border-gray-100">
                   <div className="space-y-3">
                      <div className="flex justify-between items-center">
                        <span className="text-xs font-semibold uppercase tracking-widest text-zinc-400 flex"><IdCard className="h-3.5 w-3.5 mr-1" /> PAN</span>
                        <span className="font-mono text-sm font-bold text-zinc-700">{formData.pan.replace(/.(?=.{4})/g, '*')}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-xs font-semibold uppercase tracking-widest text-zinc-400">Income</span>
                        <span className="font-medium text-zinc-700">₹{Number(formData.income).toLocaleString('en-IN')} /yr</span>
                      </div>
                   </div>
                </div>
              </div>
            </div>

            <div className="bg-emerald-50 text-emerald-700 text-xs font-semibold p-3 rounded-xl border border-emerald-100 flex items-center gap-2 mt-2">
              <ShieldCheck className="h-4 w-4 shrink-0" />
              <span>By submitting, you agree to the Terms of Service.</span>
            </div>

            <div className="pt-2 flex gap-4">
              <Button variant="outline" onClick={prevStep} className="flex-1 h-11 rounded-2xl border-gray-200 font-bold text-zinc-600 hover:bg-gray-100 cursor-pointer" disabled={loading}>
                <ChevronLeft className="mr-2 h-5 w-5" /> Back
              </Button>
              <Button 
                onClick={handleApply} 
                className="flex-[2] h-11 rounded-2xl bg-violet-600 hover:bg-violet-700 shadow-xl hover:shadow-violet-200 text-white font-bold text-base transition-all cursor-pointer relative overflow-hidden"
                disabled={loading}
              >
                {loading ? (
                  <span className="flex items-center"><Loader2 className="h-5 w-5 animate-spin mr-2" /> Processing Application...</span>
                ) : (
                  <span className="flex items-center tracking-wide"><Check className="h-5 w-5 mr-2" /> Submit Application Securely</span>
                )}
              </Button>
            </div>
          </motion.div>
        )
    }
  }

  return (
    <div className="w-full">
      {/* Premium minimal stepper */}
      <div className="mb-10 w-full relative">
        <div className="absolute top-1/2 left-0 w-full h-1 bg-gray-100 -translate-y-1/2 rounded-full z-0 overflow-hidden">
           <motion.div 
             className="absolute top-0 left-0 h-full bg-violet-600 rounded-full"
             initial={{ width: "0%" }}
             animate={{ width: `${(step - 1) * 50}%` }}
             transition={{ duration: 0.5, ease: "easeInOut" }}
           />
        </div>
        
        <div className="relative mt-10 z-10 flex justify-between">
          {[
            { num: 1, label: "Configuration" },
            { num: 2, label: "Verification" },
            { num: 3, label: "Summary" }
          ].map((s) => (
            <div key={s.num} className="flex flex-col items-center">
              <motion.div 
                className={cn(
                  "w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm transition-all duration-500",
                  step > s.num ? "bg-violet-600 text-white shadow-lg shadow-violet-200 border-2 border-violet-600" :
                  step === s.num ? "bg-white text-violet-700 border-[3px] border-violet-600 shadow-xl" : 
                  "bg-white text-zinc-300 border-[3px] border-zinc-100"
                )}
                animate={{ scale: step === s.num ? 1.1 : 1 }}
              >
                {step > s.num ? <Check className="h-5 w-5" /> : s.num}
              </motion.div>
              <span className={cn(
                "absolute top-10 mt-2 text-[10px] uppercase tracking-widest font-bold whitespace-nowrap transition-colors duration-300",
                step >= s.num ? "text-violet-700" : "text-zinc-300"
              )}>
                {s.label}
              </span>
            </div>
          ))}
        </div>
      </div>
      
      <div className="pt-6 relative">
        <AnimatePresence mode="wait" custom={1}>
          {renderStep()}
        </AnimatePresence>
      </div>
    </div>
  )
}
