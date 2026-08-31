"use client"

import { useEffect, useState } from "react"
import axios from "axios"
import { API_BASE_URL } from "@/lib/api"
import { AdminGuard } from "@/components/AdminGuard"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { 
  Settings2, 
  Smartphone, 
  CreditCard, 
  ShieldCheck, 
  Zap, 
  Calculator,
  Building2,
  Save,
  Loader2,
  Users,
  Activity,
  Briefcase,
  TrendingUp
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import { useEventTracker } from "@/hooks/useEventTracker"

interface Toggle {
  key: string
  name: string
  description: string
  icon: any
}

const TOGGLE_METADATA: Record<string, Omit<Toggle, 'key'>> = {
  'payee.page.view': { name: 'Payees Management', description: 'Track and toggle the payees management feature.', icon: Users },
  'transaction.page.view': { name: 'Transactions Tracker', description: 'Track user interactions with transaction history.', icon: Activity },
  'loan.page.view': { name: 'Loan Origination', description: 'Enable and track loan dashboard behavior.', icon: Briefcase },
  'crypto-trading.page.view': { name: 'Crypto Trading (Pro)', description: 'Enterprise feature: Advanced cryptocurrency workflow.', icon: Zap },
  'wealth-management-pro.page.view': { name: 'Wealth Management (Pro)', description: 'Enterprise feature: Automated wealth rebalancing.', icon: TrendingUp },
}

const formatToggleLabel = (key: string): string =>
  key
    .replace(/\./g, ' ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())

const normalizeToggleKey = (rawKey: string): string =>
  String(rawKey || '')
    .trim()
    .toLowerCase()
    .replace(/_page[._]view$/i, '.page.view')
    .replace(/\.page_view$/i, '.page.view')
    .replace(/_dashboard[._]view$/i, '.dashboard.view')
    .replace(/\.dashboard_view$/i, '.dashboard.view')
    .replace(/\.{2,}/g, '.')

export default function AdminFeatureToggles() {
  const [activeTab, setActiveTab] = useState("bank_a")
  const [toggles, setToggles] = useState<Record<string, Record<string, boolean>>>({
    bank_a: {},
    bank_b: {}
  })
  const [dynamicToggles, setDynamicToggles] = useState<Toggle[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)

  const { track, measureAndTrack } = useEventTracker()

  useEffect(() => {
    track('admin_feature_toggles.page.view')
    fetchAllToggles()

    const pollId = window.setInterval(() => {
      fetchAllToggles()
    }, 3000)

    return () => window.clearInterval(pollId)
  }, [track])

  const fetchAllToggles = async () => {
    setLoading(true)
    try {
      const [resA, resB] = await Promise.all([
        axios.get(`${API_BASE_URL}/events/toggles/bank_a`),
        axios.get(`${API_BASE_URL}/events/toggles/bank_b`)
      ])
      
      const rawAData = resA.data || {};
      const rawBData = resB.data || {};

      const normalizeMap = (source: Record<string, boolean>) => {
        const out: Record<string, boolean> = {};
        for (const [key, enabled] of Object.entries(source)) {
          const normalizedKey = normalizeToggleKey(key);
          if (!normalizedKey) continue;
          out[normalizedKey] = Boolean(enabled);
        }
        return out;
      };

      const aData = normalizeMap(rawAData);
      const bData = normalizeMap(rawBData);

      setToggles({
        bank_a: aData,
        bank_b: bData
      })

      // Build dynamic toggle cards from backend keys (single source of truth).
      const backendKeys = new Set([...Object.keys(aData), ...Object.keys(bData)]);
      const combined: Toggle[] = [];
      
      backendKeys.forEach(key => {
        const meta = TOGGLE_METADATA[key];
        combined.push({
          key,
          name: meta?.name || formatToggleLabel(key),
          description: meta?.description || `Dynamically tracked event: ${key}`,
          icon: meta?.icon || Settings2,
        });
      });
      setDynamicToggles(combined.sort((x, y) => x.key.localeCompare(y.key)));

    } catch (err) {
      console.error("Failed to fetch toggles:", err)
      toast.error("Could not load feature states")
    } finally {
      setLoading(false)
    }
  }

  const handleToggle = async (tenantId: string, key: string, enabled: boolean) => {
    setSaving(`${tenantId}-${key}`)
    try {
      await measureAndTrack('admin_feature_toggles.toggle_feature', async () => {
        await axios.put(`${API_BASE_URL}/events/toggles/${key}`, { tenantId, enabled }, { withCredentials: true })
      })
      setToggles(prev => ({
        ...prev,
        [tenantId]: {
          ...prev[tenantId],
          [key]: enabled
        }
      }))
      toast.success(`Feature updated for ${tenantId === 'bank_a' ? 'NexaBank' : 'SafeX Bank'}`)
    } catch (err) {
      console.error("Update failed:", err)
      toast.error("Failed to update feature")
    } finally {
      setSaving(null)
    }
  }

  return (
    <AdminGuard>
      <div className="p-8 max-w-5xl mx-auto space-y-8 animate-fade-in">
        <div>
          <h1 className="text-3xl font-black text-zinc-900 tracking-tight flex items-center gap-3">
            Global Feature Toggles
          </h1>
          <p className="text-muted-foreground font-medium mt-1">Manage feature availability across different banking tenants.</p>
        </div>

        <Tabs defaultValue="bank_a" className="w-full" onValueChange={setActiveTab}>
          <div className="flex justify-between items-center mb-6">
            <TabsList className="bg-zinc-100 p-1 rounded-2xl h-14">
              <TabsTrigger value="bank_a" className="rounded-xl px-8 py-3 font-bold data-[state=active]:bg-white data-[state=active]:shadow-sm">
                 NexaBank
              </TabsTrigger>
              <TabsTrigger value="bank_b" className="rounded-xl px-8 py-3 font-bold data-[state=active]:bg-white data-[state=active]:shadow-sm">
                 SafeX Bank
              </TabsTrigger>
            </TabsList>
          </div>

          {[ 'bank_a', 'bank_b' ].map((tenant) => (
            <TabsContent key={tenant} value={tenant} className="mt-0">
               <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {dynamicToggles.map((item) => {
                    const isEnabled = toggles[tenant]?.[item.key] ?? true
                    const Icon = item.icon
                    const isSaving = saving === `${tenant}-${item.key}`

                    return (
                      <Card key={item.key} className="border-zinc-100 shadow-sm hover:shadow-md transition-shadow rounded-[2rem] overflow-hidden">
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                           <div className="h-12 w-12 rounded-2xl bg-zinc-50 flex items-center justify-center text-zinc-600">
                              <Icon className="h-6 w-6" />
                           </div>
                           <Switch 
                             checked={isEnabled} 
                             onCheckedChange={(val) => handleToggle(tenant, item.key, val)}
                             disabled={isSaving}
                           />
                        </CardHeader>
                        <CardContent className="pt-4">
                           <div className="flex items-center gap-2 mb-1">
                              <CardTitle className="text-lg font-black">{item.name}</CardTitle>
                              {isSaving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                           </div>
                           <CardDescription className="font-medium">{item.description}</CardDescription>
                        </CardContent>
                      </Card>
                    )
                  })}
               </div>
            </TabsContent>
          ))}
        </Tabs>

        <div className="bg-zinc-900 p-8 rounded-[2.5rem] text-white flex items-center justify-between">
           <div className="flex gap-4 items-center">
              <div className="h-12 w-12 rounded-2xl bg-white/10 flex items-center justify-center">
                 <Building2 className="h-6 w-6 text-violet-400" />
              </div>
              <div>
                 <p className="font-bold">Tenant Instance Root</p>
                 <p className="text-sm text-zinc-400">Settings applied here take effect immediately for all active user sessions under the selected bank.</p>
              </div>
           </div>
        </div>
      </div>
    </AdminGuard>
  )
}
