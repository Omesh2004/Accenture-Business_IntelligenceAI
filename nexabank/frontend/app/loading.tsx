export default function GlobalLoading() {
  return (
    <div className="min-h-screen bg-white flex items-center justify-center">
      <div className="relative h-10 w-10 shrink-0">
        <div className="absolute inset-0 rounded-full border-2 border-blue-100" />
        <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-[#8f1ae8] border-r-[#961ae8] animate-spin" />
      </div>
    </div>
  );
}
