export function DashboardPreview() {
  return (
    <div className="bg-[#0e0e0e] p-5 sm:p-6">
      <div className="mb-4 flex items-center gap-2">
        <div className="h-2.5 w-2.5 rounded-full bg-red-500/60" />
        <div className="h-2.5 w-2.5 rounded-full bg-yellow-500/60" />
        <div className="h-2.5 w-2.5 rounded-full bg-green-500/60" />
        <span className="ml-3 text-xs text-zinc-600">
          app.getbudi.dev/dashboard
        </span>
      </div>

      <div className="space-y-4">
        <div className="flex items-baseline justify-between">
          <p className="text-sm font-medium text-zinc-400">Overview</p>
          <div className="flex gap-2">
            {["7d", "30d", "All"].map((label) => (
              <span
                key={label}
                className={`rounded px-2 py-0.5 text-xs ${
                  label === "7d"
                    ? "bg-blue-600/20 text-blue-400"
                    : "text-zinc-600"
                }`}
              >
                {label}
              </span>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <MockStatCard label="Total Cost" value="$1,247.82" delta="+12%" />
          <MockStatCard label="Messages" value="34,891" delta="+8%" />
          <MockStatCard label="Sessions" value="1,204" delta="+5%" />
        </div>

        <div className="rounded-lg border border-white/5 bg-white/[0.02] p-4">
          <p className="mb-3 text-xs text-zinc-500">Daily Activity (Cost)</p>
          <MockBarChart />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
            <p className="text-xs text-zinc-500">Top model</p>
            <p className="mt-1 text-sm font-medium text-white">
              Claude Sonnet 4
            </p>
            <p className="text-xs text-zinc-600">62% of spend</p>
          </div>
          <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
            <p className="text-xs text-zinc-500">Top repo</p>
            <p className="mt-1 text-sm font-medium text-white">acme/backend</p>
            <p className="text-xs text-zinc-600">38% of spend</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function MockStatCard({
  label,
  value,
  delta,
}: {
  label: string;
  value: string;
  delta: string;
}) {
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-white sm:text-xl">
        {value}
      </p>
      <p className="text-xs font-medium text-emerald-400/80">{delta}</p>
    </div>
  );
}

function MockBarChart() {
  const bars = [35, 52, 48, 65, 42, 58, 72, 60, 45, 68, 55, 80, 62, 50];
  const max = Math.max(...bars);
  return (
    <div className="flex h-20 items-end gap-1 sm:h-24">
      {bars.map((h, i) => (
        <div
          key={i}
          className="flex-1 rounded-sm bg-blue-500/30"
          style={{ height: `${(h / max) * 100}%` }}
        />
      ))}
    </div>
  );
}
