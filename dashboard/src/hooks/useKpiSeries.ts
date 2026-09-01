'use client';

/**
 * The five governed KPI series, fetched once and shared.
 *
 * The KPI cards want a sparkline and the trend charts want the full path; both are the same
 * numbers. Fetching them in one place behind React Query means the row of cards costs nothing on
 * top of the charts that were already loading, and the sparkline can never disagree with the
 * chart below it.
 */
import { useQuery } from '@tanstack/react-query';
import { dashboardAPI, type MovedWindow } from '@/lib/api';

export interface KpiSpec {
  id: string;
  label: string;
  unit: 'count' | 'rate' | 'money';
  /** Which stored fundamentals make up the plotted value. A rate is numerator then denominator. */
  pick: readonly string[];
}

export const KPI_SPECS: readonly KpiSpec[] = [
  { id: 'signups', label: 'New Account Signups', unit: 'count', pick: ['accounts_opened'] },
  { id: 'kyc_completion_rate', label: 'KYC Completion Rate', unit: 'rate',
    pick: ['kyc_completed', 'kyc_started'] },
  { id: 'loan_approval_volume', label: 'Loan Approval Volume', unit: 'count',
    pick: ['loans_approved'] },
  { id: 'revenue', label: 'Revenue', unit: 'money',
    pick: ['fee_revenue', 'interest_accrued', 'pro_revenue'] },
  { id: 'transaction_failure_rate', label: 'Transaction Failure Rate', unit: 'rate',
    pick: ['txn_failed', 'txn_total'] },
];

export interface SeriesPoint { date: string; value: number }

export interface KpiSeries {
  points: SeriesPoint[];
  window?: MovedWindow;
}

/** A rate is derived from its two counts per day; a count or money sums its fundamentals. */
function toPoints(
  d: { dates?: string[]; fundamentals?: Record<string, number[]> },
  unit: string, pick: readonly string[],
): SeriesPoint[] {
  const dates = d.dates || [];
  const f = d.fundamentals || {};
  return dates.map((date, i) => {
    if (unit === 'rate') {
      const [num, den] = pick;
      const dv = Number(f[den]?.[i] ?? 0);
      return { date, value: dv > 0 ? Number(f[num]?.[i] ?? 0) / dv : 0 };
    }
    return { date, value: pick.reduce((a, n) => a + Number(f[n]?.[i] ?? 0), 0) };
  });
}

export function useKpiSeries(tenant: string, days: number, persona: string) {
  return useQuery({
    queryKey: ['kpiSeries', tenant, days, persona],
    staleTime: 60_000,
    queryFn: async (): Promise<{ series: Record<string, KpiSeries>; allowed: string[] }> => {
      const visible = await dashboardAPI.getVisibleKpis([tenant], days, persona);
      const allowed = visible.length ? visible : KPI_SPECS.map((k) => k.id);
      // The window scored over the range on screen, so a chart marks the right days.
      const moved = await dashboardAPI.getMovedKpis([tenant], days);
      const wanted = KPI_SPECS.filter((k) => allowed.includes(k.id));
      const loaded = await Promise.all(
        wanted.map(async (k) => {
          const d = await dashboardAPI.getMetricSeries(tenant, k.id, days);
          return [k.id, d ? { points: toPoints(d, k.unit, k.pick), window: moved[k.id] } : null] as const;
        }),
      );
      const series: Record<string, KpiSeries> = {};
      for (const [id, value] of loaded) if (value) series[id] = value;
      return { series, allowed };
    },
  });
}
