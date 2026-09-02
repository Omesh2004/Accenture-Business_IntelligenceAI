/**
 * Navigation skeleton for every page under (dashboard).
 *
 * Next.js renders the nearest `loading.tsx` while a route segment suspends. The per-page files
 * here returned `null`, so a navigation showed the previous page frozen and then a blank area --
 * which reads as the app having hung. One skeleton at the group level covers every page; a page
 * that wants a bespoke one still wins by being nearer.
 *
 * The shell (navbar, sidebar) is in the layout and stays mounted, so this fills only the main
 * column and matches its padding.
 */

function Bar({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-muted ${className}`} />;
}

export default function DashboardLoading() {
  return (
    <div className="space-y-6" role="status" aria-busy="true" aria-label="Loading page">
      {/* Page heading */}
      <div className="space-y-2">
        <Bar className="h-7 w-52" />
        <Bar className="h-4 w-72" />
      </div>

      {/* Summary tiles — most dashboard pages open with a row of them */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-xl border bg-card p-5 space-y-3">
            <Bar className="h-3.5 w-24" />
            <Bar className="h-7 w-32" />
            <Bar className="h-3 w-20" />
          </div>
        ))}
      </div>

      {/* Main panel: a table or chart */}
      <div className="rounded-xl border bg-card">
        <div className="flex items-center justify-between border-b p-5">
          <Bar className="h-5 w-40" />
          <Bar className="h-8 w-28" />
        </div>
        <div className="divide-y">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex items-center gap-4 p-4">
              <Bar className="h-9 w-9 rounded-full" />
              <div className="flex-1 space-y-2">
                <Bar className="h-4 w-1/3" />
                <Bar className="h-3 w-1/5" />
              </div>
              <Bar className="h-4 w-20" />
            </div>
          ))}
        </div>
      </div>

      <span className="sr-only">Loading…</span>
    </div>
  );
}
