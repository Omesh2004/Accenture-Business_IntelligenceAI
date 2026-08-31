"use client"

import { useSearchParams, useRouter } from "next/navigation"
import { Suspense, useState, useEffect, useCallback } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Lock,
  Bitcoin,
  TrendingUp,
  TrendingDown,
  Zap,
  ArrowRight,
  CheckCircle2,
  Gem,
  Receipt,
  Library,
  ArrowUpRight,
  RefreshCcw,
  BookOpen,
  DollarSign,
  Eye,
  Search,
  Plus,
  X,
  Users,
  AlertCircle,
  ExternalLink,
  Wallet,
  BarChart3,
  PieChart as PieChartIcon,
} from "lucide-react"
import { toast } from "sonner"
import axios from "axios"
import { API_BASE_URL } from "@/lib/api"
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend, LineChart, Line } from "recharts"
import { useEventTracker } from "@/hooks/useEventTracker"
import { UserData } from "@/components/context/UserContext"

const featureData: Record<string, {
  title: string
  tagline: string
  description: string
  icon: any
  gradient: string
  perks: string[]
}> = {
  "ai-insights": {
    title: "Finance Library",
    tagline: "Premium knowledge base for professional banking and investments.",
    description: "Access curated eBooks, case studies, and real-time market research. From risk management to advanced portfolio theory, our library is the ultimate resource for the informed investor.",
    icon: Library,
    gradient: "from-violet-600 via-indigo-600 to-blue-600",
    perks: [
      "Exclusive eBooks on Modern Monetary Theory",
      "Real-time institutional research reports",
      "Advanced risk management framework guides",
      "Tax strategy webinars and archives",
    ]
  },
  "crypto-trading": {
    title: "Crypto Trading",
    tagline: "Institutional-grade digital asset management.",
    description: "Trade BTC, ETH, SOL, XRP, and ADA with real-time prices. Integrated cold-storage security and instant fiat-to-crypto conversion.",
    icon: Bitcoin,
    gradient: "from-amber-500 via-orange-500 to-rose-500",
    perks: [
      "Live prices from CoinGecko API",
      "Multi-asset trading (BTC, ETH, SOL, XRP, ADA)",
      "Real-time portfolio tracking",
    ]
  },
  "wealth-management-pro": {
    title: "Wealth Management",
    tagline: "Sophisticated portfolio tracking and rebalancing.",
    description: "Get a 360-degree view of your net worth with real data from your accounts and transactions. Automated asset allocation and category-wise spending analysis.",
    icon: Gem,
    gradient: "from-emerald-600 via-teal-600 to-cyan-600",
    perks: [
      "Real-time portfolio valuation from your accounts",
      "Category-wise spending breakdown",
      "Monthly income vs expenses analysis",
    ]
  },
  "bulk-payroll-processing": {
    title: "Payroll Pro",
    tagline: "Enterprise-scale mass payment automation.",
    description: "Select payees, set a uniform amount, and pay everyone in one click. Real transactions, real balance updates, with comprehensive validations.",
    icon: Receipt,
    gradient: "from-blue-700 via-indigo-700 to-purple-700",
    perks: [
      "Search & add payees by name",
      "Mass payment up to 20 payees",
      "₹10,000 per-payee limit with balance validation",
    ]
  },
}

function ProFeatureContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const featureId = searchParams.get("id") || "ai-insights"
  const feature = featureData[featureId] || featureData["ai-insights"]
  const FeatureIcon = feature.icon

  const [isUnlocked, setIsUnlocked] = useState<boolean>(false)
  const [loading, setLoading] = useState(true)
  const [unlocking, setUnlocking] = useState(false)

  const { isAuth } = UserData()
  const { track } = useEventTracker()

  useEffect(() => {
    track(`${featureId}.page.view`)
  }, [featureId, track])

  useEffect(() => {
    if (isAuth) fetchStatus()
  }, [featureId, isAuth])

  const fetchStatus = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/pro/status`, { withCredentials: true })
      const active = res.data.some((l: any) => l.featureId === featureId)
      setIsUnlocked(active)
      setLoading(false)
    } catch (err) {
      console.error(err)
      setLoading(false)
    }
  }

  const handleUnlock = async () => {
    setUnlocking(true)
    try {
      await axios.post(`${API_BASE_URL}/pro/unlock`, { featureId }, { withCredentials: true })
      toast.success(`Subscription Unlocked! ₹2,000 deducted from your account. ${feature.title} is now active for 30 days.`)
      setIsUnlocked(true)
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || "Unlock failed";
      if (errorMsg.includes("Insufficient")) {
        toast.error("Insufficient Funds to Unlock Pro. Minimum ₹2,000 balance required in your account.");
      } else {
        toast.error(errorMsg);
      }
    } finally {
      setUnlocking(false)
    }
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center p-20">
        <RefreshCcw className="animate-spin h-8 w-8 text-zinc-400" />
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col p-4 md:p-8 space-y-8 animate-fade-in max-w-5xl mx-auto w-full">
      {/* Hero Section */}
      <div className={`relative overflow-hidden rounded-3xl bg-gradient-to-br ${feature.gradient} p-8 md:p-12 text-white shadow-2xl transition-all duration-500`}>
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full filter blur-3xl -translate-y-1/2 translate-x-1/4"></div>
        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-12 w-12 rounded-2xl bg-white/20 backdrop-blur-sm flex items-center justify-center">
              <FeatureIcon className="h-6 w-6" />
            </div>
            <span className="px-3 py-1 bg-white/20 backdrop-blur-sm rounded-full text-xs font-bold uppercase tracking-widest flex items-center gap-2">
              {isUnlocked ? <CheckCircle2 className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
              {isUnlocked ? "Enterprise Pro Active" : "License Required"}
            </span>
          </div>
          <h1 className="text-3xl md:text-4xl font-black tracking-tight mb-2">{feature.title}</h1>
          <p className="text-lg text-white/80 font-medium max-w-xl">{feature.tagline}</p>
        </div>
      </div>

      {!isUnlocked ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <Card className="border-2 border-primary/20 bg-primary/5 shadow-xl">
            <CardHeader>
              <CardTitle className="text-2xl font-black flex items-center gap-2">
                <DollarSign className="text-emerald-500" />
                Unlock Enterprise Access
              </CardTitle>
              <CardDescription>Get full access to {feature.title} for 30 days.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-baseline gap-1 text-4xl font-black text-zinc-900">
                ₹2,000
                <span className="text-sm font-medium text-zinc-500">/ per month</span>
              </div>
              <ul className="space-y-2">
                {feature.perks.map((p, i) => (
                  <li key={i} className="flex items-center gap-2 text-sm text-zinc-600">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    {p}
                  </li>
                ))}
              </ul>
            </CardContent>
            <CardFooter>
              <Button
                onClick={handleUnlock}
                disabled={unlocking}
                className="w-full h-12 rounded-xl bg-zinc-900 text-white hover:bg-zinc-800 font-bold"
              >
                {unlocking ? "Processing Payment..." : "Pay ₹2,000 & Unlock Now"}
              </Button>
            </CardFooter>
          </Card>

          <Card className="border-zinc-100 bg-zinc-50/50">
            <CardHeader>
              <CardTitle className="text-xl font-black">Why upgrade?</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-zinc-600 leading-relaxed space-y-4">
              <p>{feature.description}</p>
              <div className="p-4 bg-white rounded-xl border border-zinc-100 italic text-zinc-500">
                "NexaBank Pro gave us the transparency we needed for our payroll and wealth tracking. Highly recommended."
                <br />— <span className="font-bold text-zinc-700">Abhishek K.</span>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="space-y-8 animate-in slide-in-from-bottom-5 duration-500">
          {featureId === "ai-insights" && <FinanceLibraryModule />}
          {featureId === "crypto-trading" && <CryptoTradingModule />}
          {featureId === "wealth-management-pro" && <WealthManagementModule />}
          {featureId === "bulk-payroll-processing" && <PayrollModule />}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// ─── FINANCE LIBRARY MODULE ─────────────────────────────────
// ═══════════════════════════════════════════════════════════════

function FinanceLibraryModule() {
  const [bookCounts, setBookCounts] = useState<Record<string, number>>({})
  const [loadingStats, setLoadingStats] = useState(true)
  const { track, measureAndTrack } = useEventTracker()

  const books = [
    {
      title: "The Intelligent Investor",
      author: "Benjamin Graham",
      color: "bg-blue-100",
      url: "https://archive.org/details/the-intelligent-investor-by-benjamin-graham",
      category: "Investment Strategy"
    },
    {
      title: "Rich Dad Poor Dad",
      author: "Robert Kiyosaki",
      color: "bg-violet-100",
      url: "https://openlibrary.org/works/OL514453W/Rich_Dad_Poor_Dad",
      category: "Personal Finance"
    },
    {
      title: "The Psychology of Money",
      author: "Morgan Housel",
      color: "bg-emerald-100",
      url: "https://openlibrary.org/works/OL20894283W/The_Psychology_of_Money",
      category: "Behavioral Finance"
    },
    {
      title: "A Random Walk Down Wall Street",
      author: "Burton Malkiel",
      color: "bg-amber-100",
      url: "https://openlibrary.org/works/OL2023027W/A_random_walk_down_Wall_Street",
      category: "Market Theory"
    },
    {
      title: "Common Stocks and Uncommon Profits",
      author: "Philip Fisher",
      color: "bg-rose-100",
      url: "https://openlibrary.org/works/OL3261805W/Common_stocks_and_uncommon_profits",
      category: "Stock Analysis"
    },
    {
      title: "The Little Book of Common Sense Investing",
      author: "John C. Bogle",
      color: "bg-cyan-100",
      url: "https://openlibrary.org/works/OL1970038W/The_little_book_of_common_sense_investing",
      category: "Index Investing"
    },
  ]

  useEffect(() => {
    fetchBookStats()
  }, [])

  const fetchBookStats = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/pro/book_stats`, { withCredentials: true })
      setBookCounts(res.data.counts || {})
    } catch (err) {
      console.error("Failed to load book stats:", err)
    } finally {
      setLoadingStats(false)
    }
  }

  const handleAccessBook = async (book: typeof books[0]) => {
    try {
      await measureAndTrack("ai-insights.book", async () => {
        await axios.post(`${API_BASE_URL}/pro/access_book`, {
          title: book.title,
          url: book.url,
        }, { withCredentials: true })
      })

      // Update local count
      setBookCounts(prev => ({
        ...prev,
        [book.title]: (prev[book.title] || 0) + 1,
      }))

      // Open book in new tab
      window.open(book.url, "_blank")
      toast.success(`Opening "${book.title}"`)
    } catch (err) {
      toast.error("Failed to track book access.")
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-black text-zinc-900">Finance Library</h2>
          <p className="text-sm text-zinc-500 mt-1">Click to read online • Your access count is tracked per book</p>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 bg-violet-50 rounded-full">
          <Eye className="h-4 w-4 text-violet-600" />
          <span className="text-xs font-bold text-violet-700">
            {Object.values(bookCounts).reduce((s, v) => s + v, 0)} total reads
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {books.map((b, i) => (
          <Card key={i} className="group hover:border-violet-300 hover:shadow-lg transition-all duration-300 cursor-pointer overflow-hidden">
            <CardContent className="p-0">
              <div className={`${b.color} p-5 flex items-center justify-between`}>
                <div className="flex items-center gap-3">
                  <div className="h-14 w-10 bg-white/80 rounded shadow-sm flex items-center justify-center">
                    <BookOpen className="h-5 w-5 text-zinc-500" />
                  </div>
                  <div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">{b.category}</span>
                    <h3 className="font-bold text-sm text-zinc-800 leading-tight group-hover:text-violet-700 transition-colors">{b.title}</h3>
                  </div>
                </div>
              </div>
              <div className="p-4 space-y-3">
                <p className="text-xs text-zinc-500">by <span className="font-medium text-zinc-700">{b.author}</span></p>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Eye className="h-3.5 w-3.5 text-zinc-400" />
                    <span className="text-xs font-bold text-zinc-600">
                      {loadingStats ? "..." : (bookCounts[b.title] || 0)} reads
                    </span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full gap-1.5 text-xs hover:bg-violet-50 hover:text-violet-700 hover:border-violet-300 transition-all"
                    onClick={() => handleAccessBook(b)}
                  >
                    Read Online <ExternalLink className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// ─── CRYPTO TRADING MODULE ───────────────────────────────────
// ═══════════════════════════════════════════════════════════════

interface CryptoAsset {
  id: string
  name: string
  price: number
  change24h: number
  volume: number
  marketCap: number
}

function CryptoTradingModule() {
  const [assets, setAssets] = useState<CryptoAsset[]>([])
  const [selectedAsset, setSelectedAsset] = useState<string>("BTC")
  const [amount, setAmount] = useState("")
  const [trading, setTrading] = useState(false)
  const [loadingPrices, setLoadingPrices] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<string>("")
  const [portfolio, setPortfolio] = useState<{ holdings: any[], balance: number }>({ holdings: [], balance: 0 })
  const { track, measureAndTrack } = useEventTracker()

  const fetchPrices = useCallback(async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/pro/crypto_prices`, { withCredentials: true })
      setAssets(res.data.assets || [])
      setLastUpdated(res.data.lastUpdated || "")
      setLoadingPrices(false)
    } catch (err) {
      console.error("Failed to fetch prices:", err)
      setLoadingPrices(false)
    }
  }, [])

  const fetchPortfolio = useCallback(async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/pro/portfolio`, { withCredentials: true })
      setPortfolio(res.data)
    } catch (err) {
      console.error("Failed to fetch portfolio:", err)
    }
  }, [])

  useEffect(() => {
    fetchPrices()
    fetchPortfolio()
    const interval = setInterval(fetchPrices, 30000) // refresh every 30s
    return () => clearInterval(interval)
  }, [fetchPrices, fetchPortfolio])

  const handleTrade = async (type: string) => {
    if (!amount || parseFloat(amount) <= 0) return toast.error("Enter a valid amount")
    const currentAsset = assets.find(a => a.id === selectedAsset)
    if (!currentAsset) return toast.error("Select an asset")

    setTrading(true)
    try {
      await measureAndTrack(`crypto-trading.trade_execution`, async () => {
        await axios.post(`${API_BASE_URL}/pro/trade`, {
          asset: selectedAsset,
          amount: parseFloat(amount),
          price: currentAsset.price,
          type
        }, { withCredentials: true })
      })

      toast.success(`${type} Successful! ${amount} ${selectedAsset} at ₹${currentAsset.price.toLocaleString('en-IN')}`)
      setAmount("")
      fetchPortfolio()
    } catch (err: any) {
      const tradeErr = err.response?.data?.error || "Trade failed";
      toast.error(tradeErr)
    } finally {
      setTrading(false)
    }
  }

  const currentAsset = assets.find(a => a.id === selectedAsset)
  const totalValue = amount && currentAsset ? parseFloat(amount) * currentAsset.price : 0

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-black text-zinc-900">₿ Crypto Trading</h2>
          <p className="text-sm text-zinc-500 mt-1">Live prices from CoinGecko • Auto-refreshes every 30s</p>
        </div>
        <div className="flex items-center gap-2">
          {lastUpdated && (
            <span className="text-[10px] text-zinc-400">
              Updated: {new Date(lastUpdated).toLocaleTimeString()}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={fetchPrices} className="rounded-full">
            <RefreshCcw className={`h-4 w-4 ${loadingPrices ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* Price Ticker Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {assets.map(a => (
          <Card
            key={a.id}
            className={`cursor-pointer transition-all duration-200 hover:shadow-md ${selectedAsset === a.id ? 'border-2 border-violet-500 shadow-lg shadow-violet-100' : 'border-zinc-100'}`}
            onClick={() => { setSelectedAsset(a.id); track(`crypto-trading.asset_select.success`) }}
          >
            <CardContent className="p-4 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-black text-zinc-900">{a.id}</span>
                {a.change24h >= 0 ? (
                  <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />
                ) : (
                  <TrendingDown className="h-3.5 w-3.5 text-rose-500" />
                )}
              </div>
              <p className="text-sm font-bold text-zinc-800">₹{a.price.toLocaleString('en-IN')}</p>
              <p className={`text-xs font-bold ${a.change24h >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                {a.change24h >= 0 ? '+' : ''}{a.change24h?.toFixed(2)}%
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Trade Terminal */}
        <Card className="lg:col-span-1 border-2 border-zinc-100">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg font-black">Trade Terminal</CardTitle>
            <CardDescription>
              {currentAsset ? `${currentAsset.name} (${currentAsset.id})` : 'Select an asset'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-bold uppercase text-zinc-400">Order Size ({selectedAsset})</label>
              <Input
                type="number"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="h-12 text-lg font-mono"
              />
            </div>
            {totalValue > 0 && (
              <div className="p-3 bg-zinc-50 rounded-xl text-center">
                <span className="text-xs text-zinc-500">Total Value</span>
                <p className="text-xl font-black text-zinc-900">₹{totalValue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</p>
              </div>
            )}
            <div className="flex items-center gap-2 text-xs text-zinc-400">
              <Wallet className="h-3.5 w-3.5" />
              Available: ₹{portfolio.balance.toLocaleString('en-IN')}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Button onClick={() => handleTrade("BUY")} disabled={trading} className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold h-12 rounded-xl">
                BUY
              </Button>
              <Button onClick={() => handleTrade("SELL")} disabled={trading} className="bg-rose-600 hover:bg-rose-700 text-white font-bold h-12 rounded-xl">
                SELL
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Holdings */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg font-black">Your Holdings</CardTitle>
            <CardDescription>Current crypto portfolio</CardDescription>
          </CardHeader>
          <CardContent>
            {portfolio.holdings.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <Bitcoin className="h-10 w-10 text-zinc-300 mb-3" />
                <p className="text-sm text-zinc-500">No crypto holdings yet. Execute a trade to start!</p>
              </div>
            ) : (
              <div className="space-y-3">
                {portfolio.holdings.map((h: any, i: number) => {
                  const livePrice = assets.find(a => a.id === h.asset)?.price || h.avgPrice
                  const currentValue = h.amount * livePrice
                  const costBasis = h.amount * h.avgPrice
                  const pnl = currentValue - costBasis
                  return (
                    <div key={i} className="flex items-center justify-between p-4 bg-zinc-50 rounded-xl border border-zinc-100">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 bg-amber-100 rounded-full flex items-center justify-center">
                          <Bitcoin className="h-5 w-5 text-amber-600" />
                        </div>
                        <div>
                          <p className="font-bold text-sm text-zinc-900">{h.asset}</p>
                          <p className="text-xs text-zinc-500">Qty: {h.amount.toFixed(4)}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-sm text-zinc-900">₹{currentValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</p>
                        <p className={`text-xs font-bold ${pnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {pnl >= 0 ? '+' : ''}₹{pnl.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// ─── WEALTH MANAGEMENT MODULE ────────────────────────────────
// ═══════════════════════════════════════════════════════════════

function WealthManagementModule() {
  const [insights, setInsights] = useState<any>(null)
  const [loadingInsights, setLoadingInsights] = useState(true)
  const [rebalancing, setRebalancing] = useState(false)
  const { track, measureAndTrack } = useEventTracker()

  const CHART_COLORS = ["#7c3aed", "#f59e0b", "#10b981", "#3b82f6", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899"]

  useEffect(() => {
    fetchInsights()
    track('wealth-management-pro.insights.view');
  }, [track])

  const fetchInsights = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/pro/wealth_insights`, { withCredentials: true })
      setInsights(res.data)
    } catch (err) {
      console.error("Failed to fetch wealth insights:", err)
      toast.error("Failed to load wealth data")
    } finally {
      setLoadingInsights(false)
    }
  }

  const handleRebalance = async () => {
    setRebalancing(true)
    try {
      await measureAndTrack("wealth-management-pro.rebalance", async () => {
        await axios.post(`${API_BASE_URL}/pro/rebalance_wealth`, {}, { withCredentials: true })
      })
      toast.success("Portfolio successfully rebalanced!")
      fetchInsights()
    } catch (err: any) {
      toast.error(err.response?.data?.error || "Failed to rebalance portfolio.")
    } finally {
      setRebalancing(false)
    }
  }

  if (loadingInsights) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCcw className="animate-spin h-8 w-8 text-zinc-300" />
      </div>
    )
  }

  if (!insights) {
    return (
      <div className="text-center py-20 text-zinc-500">
        <AlertCircle className="h-10 w-10 mx-auto mb-3 text-zinc-300" />
        <p>Unable to load wealth data. Please try again.</p>
      </div>
    )
  }

  const categoryData = insights.topCategories?.map((c: any, i: number) => ({
    name: c.name,
    value: Math.round(c.amount),
    fill: CHART_COLORS[i % CHART_COLORS.length],
  })) || []

  const investmentData = insights.investmentBreakdown?.map((ib: any, i: number) => ({
    name: ib.type,
    value: Math.round(ib.value),
    fill: CHART_COLORS[i % CHART_COLORS.length],
  })) || []

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-black text-zinc-900">💎 Wealth Management</h2>
          <p className="text-sm text-zinc-500 mt-1">Real-time insights from your accounts & transactions</p>
        </div>
        <Button
          onClick={handleRebalance}
          disabled={rebalancing}
          className="rounded-full bg-zinc-900 text-white hover:bg-zinc-800 gap-2"
        >
          {rebalancing ? "Analyzing..." : "Rebalance"} <RefreshCcw className={`h-4 w-4 ${rebalancing ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Net Worth", value: `₹${insights.netWorth?.toLocaleString('en-IN')}`, icon: Gem, color: "text-emerald-600", bg: "bg-emerald-50" },
          { label: "Cash Balance", value: `₹${insights.totalBalance?.toLocaleString('en-IN')}`, icon: Wallet, color: "text-blue-600", bg: "bg-blue-50" },
          { label: "Investments", value: `₹${insights.investmentValue?.toLocaleString('en-IN')}`, icon: TrendingUp, color: "text-violet-600", bg: "bg-violet-50" },
          { label: "Savings Rate", value: `${insights.savingsRate?.toFixed(1)}%`, icon: BarChart3, color: "text-amber-600", bg: "bg-amber-50" },
        ].map((kpi, i) => (
          <Card key={i} className="border-zinc-100 hover:shadow-md transition-shadow">
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">{kpi.label}</span>
                <div className={`h-8 w-8 ${kpi.bg} rounded-full flex items-center justify-center`}>
                  <kpi.icon className={`h-4 w-4 ${kpi.color}`} />
                </div>
              </div>
              <p className="text-xl font-black text-zinc-900">{kpi.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Spending by Category */}
        <Card className="border-zinc-100">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-black flex items-center gap-2">
              <PieChartIcon className="h-4 w-4 text-violet-500" />
              Spending by Category
            </CardTitle>
            <CardDescription>{insights.transactionCount} transactions analyzed (90 days)</CardDescription>
          </CardHeader>
          <CardContent className="h-[280px]">
            {categoryData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={categoryData}
                    innerRadius={55}
                    outerRadius={85}
                    paddingAngle={4}
                    dataKey="value"
                    label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                  >
                    {categoryData.map((entry: any, index: number) => (
                      <Cell key={`cell-${index}`} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: number) => `₹${v.toLocaleString('en-IN')}`} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-zinc-400 text-sm">No spending data</div>
            )}
          </CardContent>
        </Card>

        {/* Monthly Cash Flow */}
        <Card className="border-zinc-100">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-black flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-blue-500" />
              Monthly Cash Flow
            </CardTitle>
            <CardDescription>Income vs Expenses (last 3 months)</CardDescription>
          </CardHeader>
          <CardContent className="h-[280px]">
            {insights.monthlyFlow?.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={insights.monthlyFlow}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f4f4f5" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}k`} />
                  <Tooltip formatter={(v: number) => `₹${v.toLocaleString('en-IN')}`} />
                  <Legend />
                  <Bar dataKey="income" fill="#10b981" radius={[4, 4, 0, 0]} name="Income" />
                  <Bar dataKey="expenses" fill="#ef4444" radius={[4, 4, 0, 0]} name="Expenses" />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-zinc-400 text-sm">No flow data</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Investment Breakdown + Accounts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="border-zinc-100">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-black">Investment Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            {investmentData.length > 0 ? (
              <div className="space-y-3">
                {investmentData.map((inv: any, i: number) => (
                  <div key={i} className="flex items-center justify-between p-3 bg-zinc-50 rounded-xl">
                    <div className="flex items-center gap-3">
                      <div className="h-3 w-3 rounded-full" style={{ backgroundColor: inv.fill }}></div>
                      <span className="font-bold text-sm text-zinc-800">{inv.name}</span>
                    </div>
                    <span className="font-bold text-sm text-zinc-900">₹{inv.value.toLocaleString('en-IN')}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-zinc-400 py-6 text-center">No investments yet</p>
            )}
          </CardContent>
        </Card>

        <Card className="border-zinc-100">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-black">Account Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {insights.accounts?.map((acc: any, i: number) => (
                <div key={i} className="flex items-center justify-between p-3 bg-zinc-50 rounded-xl">
                  <div>
                    <p className="font-bold text-sm text-zinc-800">{acc.type}</p>
                    <p className="text-xs text-zinc-500 font-mono">****{acc.accNo.slice(-4)}</p>
                  </div>
                  <p className="font-bold text-sm text-zinc-900">₹{acc.balance.toLocaleString('en-IN')}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// ─── PAYROLL PRO MODULE ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

interface PayrollPayee {
  accNo: string
  name: string
  ifsc?: string
}

function PayrollModule() {
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResults, setSearchResults] = useState<PayrollPayee[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [selectedPayees, setSelectedPayees] = useState<PayrollPayee[]>([])
  const [amountPerPayee, setAmountPerPayee] = useState("")
  const [processing, setProcessing] = useState(false)
  const [loadingPayees, setLoadingPayees] = useState(true)
  const [existingPayees, setExistingPayees] = useState<any[]>([])
  const { track, measureAndTrack } = useEventTracker()

  useEffect(() => {
    fetchExistingPayees()
    track('bulk-payroll-processing.payees.view');
  }, [track])

  const fetchExistingPayees = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/pro/payroll_payees`, { withCredentials: true })
      setExistingPayees(res.data || [])
    } catch (err) {
      console.error("Failed to fetch payees:", err)
    } finally {
      setLoadingPayees(false)
    }
  }

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(async () => {
      if (searchQuery.length >= 2) {
        setIsSearching(true)
        try {
          let results: any[] = []
          await measureAndTrack("bulk-payroll-processing.search", async () => {
            const res = await axios.post(`${API_BASE_URL}/pro/search_payees`, {
              query: searchQuery
            }, { withCredentials: true })
            results = res.data || []
          })
          setSearchResults(results)
        } catch (err) {
          console.error("Search failed:", err)
        } finally {
          setIsSearching(false)
        }
      } else {
        setSearchResults([])
      }
    }, 400)
    return () => clearTimeout(timer)
  }, [searchQuery])

  const addPayee = (payee: PayrollPayee) => {
    if (selectedPayees.length >= 20) {
      toast.error("Maximum 20 payees per batch")
      return
    }
    if (selectedPayees.some(p => p.accNo === payee.accNo)) {
      toast.error("Payee already added")
      return
    }
    setSelectedPayees(prev => [...prev, payee])
    setSearchQuery("")
    setSearchResults([])
    track("bulk-payroll-processing.add_payee.success")
  }

  const removePayee = (accNo: string) => {
    setSelectedPayees(prev => prev.filter(p => p.accNo !== accNo))
  }

  const addFromExisting = (payee: any) => {
    addPayee({
      accNo: payee.payeeAccNo,
      name: payee.name,
      ifsc: payee.payeeifsc,
    })
  }

  const totalAmount = parseFloat(amountPerPayee || "0") * selectedPayees.length

  const handleProcessPayroll = async () => {
    const amt = parseFloat(amountPerPayee)
    if (!amt || amt <= 0) return toast.error("Enter a valid amount per payee")
    if (amt > 10000) return toast.error("Maximum ₹10,000 per payee")
    if (selectedPayees.length === 0) return toast.error("Add at least one payee")
    if (selectedPayees.length > 20) return toast.error("Maximum 20 payees per batch")

    setProcessing(true)
    try {
      let res: any;
      await measureAndTrack("bulk-payroll-processing.batch", async () => {
        res = await axios.post(`${API_BASE_URL}/pro/process_payroll`, {
          payees: selectedPayees.map(p => ({ accNo: p.accNo, name: p.name })),
          amountPerPayee: amt,
        }, { withCredentials: true })
      })

      toast.success(res.data.message || "Payroll processed successfully!")
      setSelectedPayees([])
      setAmountPerPayee("")
    } catch (err: any) {
      const errMsg = err.response?.data?.error || "Payroll processing failed"
      toast.error(errMsg)
    } finally {
      setProcessing(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-black text-zinc-900">Payroll Pro</h2>
          <p className="text-sm text-zinc-500 mt-1">Mass payment to multiple payees in one go</p>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 rounded-full">
          <Users className="h-4 w-4 text-blue-600" />
          <span className="text-xs font-bold text-blue-700">{selectedPayees.length}/20 payees</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Search & Add Payees */}
        <div className="lg:col-span-2 space-y-4">
          {/* Search */}
          <Card className="border-zinc-100">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-black flex items-center gap-2">
                <Search className="h-4 w-4 text-violet-500" />
                Search & Add Payees
              </CardTitle>
              <CardDescription>Search by name across all banking customers</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="relative">
                <Search className="absolute left-3 top-3.5 h-4 w-4 text-zinc-400" />
                <Input
                  placeholder="Type name to search..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10 h-12 rounded-xl"
                />
                {isSearching && (
                  <RefreshCcw className="absolute right-3 top-3.5 h-4 w-4 text-zinc-400 animate-spin" />
                )}
              </div>

              {/* Search Results */}
              {searchResults.length > 0 && (
                <div className="border border-zinc-100 rounded-xl overflow-hidden divide-y divide-zinc-50">
                  {searchResults.map((r, i) => (
                    <div key={i} className="flex items-center justify-between p-3 hover:bg-violet-50 transition-colors">
                      <div>
                        <p className="font-bold text-sm text-zinc-900">{r.name}</p>
                        <p className="text-xs text-zinc-500 font-mono">****{r.accNo.slice(-4)} • {r.ifsc}</p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => addPayee(r)}
                        disabled={selectedPayees.some(p => p.accNo === r.accNo)}
                        className="rounded-full gap-1 text-xs"
                      >
                        <Plus className="h-3 w-3" /> Add
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {/* Existing Payees */}
              {existingPayees.length > 0 && searchQuery.length < 2 && (
                <div>
                  <p className="text-xs font-bold uppercase text-zinc-400 mb-2">Your Existing Payees</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {existingPayees.slice(0, 8).map((p, i) => (
                      <div key={i} className="flex items-center justify-between p-3 bg-zinc-50 rounded-xl border border-zinc-100">
                        <div>
                          <p className="font-bold text-xs text-zinc-800">{p.name}</p>
                          <p className="text-[10px] text-zinc-500 font-mono">****{p.payeeAccNo?.slice(-4)}</p>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => addFromExisting(p)}
                          disabled={selectedPayees.some(sp => sp.accNo === p.payeeAccNo)}
                          className="h-7 rounded-full text-xs text-violet-600 hover:bg-violet-50"
                        >
                          <Plus className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right: Payment Summary */}
        <Card className="border-2 border-zinc-200 lg:sticky lg:top-4 self-start">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-black">Payment Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Amount Input */}
            <div className="space-y-2">
              <label className="text-xs font-bold uppercase text-zinc-400">Amount Per Payee</label>
              <div className="relative">
                <span className="absolute left-3 top-3 text-zinc-400 font-bold">₹</span>
                <Input
                  type="number"
                  placeholder="0"
                  value={amountPerPayee}
                  onChange={(e) => setAmountPerPayee(e.target.value)}
                  className="pl-8 h-12 text-lg font-mono"
                  max={10000}
                />
              </div>
              <p className="text-[10px] text-zinc-400">Max ₹10,000 per payee</p>
            </div>

            {/* Selected Payees List */}
            {selectedPayees.length > 0 ? (
              <div className="space-y-2 max-h-[300px] overflow-y-auto">
                {selectedPayees.map((p, i) => (
                  <div key={i} className="flex items-center justify-between p-2.5 bg-zinc-50 rounded-lg border border-zinc-100">
                    <div className="flex items-center gap-2">
                      <div className="h-7 w-7 bg-gradient-to-br from-violet-400 to-blue-500 rounded-full flex items-center justify-center text-[10px] text-white font-bold">
                        {p.name[0]}
                      </div>
                      <div>
                        <p className="font-bold text-xs text-zinc-800">{p.name}</p>
                        <p className="text-[10px] text-zinc-500 font-mono">****{p.accNo.slice(-4)}</p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removePayee(p.accNo)}
                      className="h-6 w-6 p-0 rounded-full text-rose-400 hover:text-rose-600 hover:bg-rose-50"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-6 text-center">
                <Users className="h-8 w-8 text-zinc-200 mx-auto mb-2" />
                <p className="text-xs text-zinc-400">Add payees to get started</p>
              </div>
            )}

            {/* Totals */}
            {selectedPayees.length > 0 && parseFloat(amountPerPayee || "0") > 0 && (
              <div className="p-3 bg-gradient-to-br from-zinc-900 to-zinc-800 rounded-xl text-white space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-zinc-400">Payees</span>
                  <span className="font-bold">{selectedPayees.length}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-zinc-400">Per Payee</span>
                  <span className="font-bold">₹{parseFloat(amountPerPayee).toLocaleString('en-IN')}</span>
                </div>
                <div className="border-t border-zinc-700 my-1"></div>
                <div className="flex justify-between text-sm">
                  <span className="font-bold">Total</span>
                  <span className="font-black text-lg">₹{totalAmount.toLocaleString('en-IN')}</span>
                </div>
              </div>
            )}

            <Button
              onClick={handleProcessPayroll}
              disabled={processing || selectedPayees.length === 0 || !amountPerPayee}
              className="w-full h-12 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl gap-2 shadow-lg"
            >
              {processing ? (
                <>
                  <RefreshCcw className="h-4 w-4 animate-spin" /> Processing...
                </>
              ) : (
                <>
                  Pay All <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export default function ProFeaturePage() {
  return (
    <Suspense fallback={<div className="flex-1 flex items-center justify-center"><RefreshCcw className="animate-spin" /></div>}>
      <ProFeatureContent />
    </Suspense>
  )
}
