/** Auth pages suspend on the session check; without this the screen goes blank mid-navigation. */
export default function AuthLoading() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center" role="status" aria-busy="true">
      <div className="relative h-10 w-10 shrink-0">
        <div className="absolute inset-0 rounded-full border-2 border-blue-100" />
        <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-[#8f1ae8] border-r-[#961ae8] animate-spin" />
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
