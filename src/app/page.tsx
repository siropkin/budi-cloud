import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { DashboardPreview } from "./_components/dashboard-preview";

export const dynamic = "force-dynamic";

const VALUE_PROPS = [
  {
    title: "Unified AI spend view",
    description:
      "See all your Claude Code, Cursor, Copilot, and Windsurf usage in one dashboard.",
    icon: ChartIcon,
  },
  {
    title: "Budgets & alerts",
    description: "Set budgets and get notified before costs spike.",
    icon: BellIcon,
  },
  {
    title: "Model & repo breakdown",
    description:
      "Drill into cost by model, repository, and branch to find what's driving spend.",
    icon: LayersIcon,
  },
  {
    title: "Open-source & self-hostable",
    description:
      "Run Budi entirely on your own infrastructure, or use Budi Cloud's free tier.",
    icon: CodeIcon,
  },
];

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) redirect("/dashboard");

  return (
    <main className="flex flex-1 flex-col bg-[#0a0a0a]">
      <nav className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        <span className="text-lg font-bold text-white">Budi Cloud</span>
        <div className="flex items-center gap-4">
          <a
            href="https://github.com/siropkin/budi-cloud"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-zinc-400 transition-colors hover:text-white"
          >
            GitHub
          </a>
          <a
            href="https://getbudi.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-zinc-400 transition-colors hover:text-white"
          >
            Docs
          </a>
          <Link
            href="/login"
            className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
          >
            Sign in
          </Link>
        </div>
      </nav>

      <section className="mx-auto flex w-full max-w-6xl flex-col items-center px-6 pt-16 pb-20 text-center sm:pt-24 sm:pb-28">
        <h1 className="max-w-2xl text-4xl font-bold tracking-tight text-white sm:text-5xl">
          AI cost visibility for developers and teams
        </h1>
        <p className="mt-5 max-w-xl text-lg text-zinc-400">
          Track what you spend on Claude Code, Cursor, Copilot, and Windsurf —
          in one place. Set budgets, catch spikes early, and make informed
          decisions about AI tooling.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/login"
            className="rounded-lg bg-accent px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
          >
            Get started free
          </Link>
          <a
            href="https://github.com/siropkin/budi-cloud"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-white/10 bg-white/5 px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-white/10"
          >
            View on GitHub
          </a>
        </div>
      </section>

      <section className="mx-auto w-full max-w-5xl px-6 pb-20">
        <div className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.02] shadow-2xl shadow-blue-500/5">
          <DashboardPreview />
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-6 pb-24">
        <div className="grid gap-6 sm:grid-cols-2">
          {VALUE_PROPS.map((prop) => (
            <div
              key={prop.title}
              className="rounded-xl border border-white/10 bg-white/[0.02] p-6"
            >
              <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-blue-400">
                <prop.icon />
              </div>
              <h3 className="text-base font-semibold text-white">
                {prop.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                {prop.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-6 pb-24 text-center">
        <h2 className="text-2xl font-bold text-white sm:text-3xl">
          Ready to see where your AI budget goes?
        </h2>
        <p className="mt-3 text-zinc-400">
          Free to use. Self-host or use Budi Cloud. No credit card required.
        </p>
        <Link
          href="/login"
          className="mt-6 inline-block rounded-lg bg-accent px-8 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-700"
        >
          Get started free
        </Link>
      </section>

      <footer className="border-t border-white/10 py-8">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 px-6 sm:flex-row">
          <span className="text-sm text-zinc-500">
            &copy; {new Date().getFullYear()} Budi. Open-source under MIT.
          </span>
          <div className="flex items-center gap-5">
            <a
              href="https://github.com/siropkin/budi-cloud"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-zinc-500 transition-colors hover:text-white"
            >
              GitHub
            </a>
            <a
              href="https://getbudi.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-zinc-500 transition-colors hover:text-white"
            >
              Docs
            </a>
            <a
              href="https://github.com/siropkin/budi-cloud/blob/main/CHANGELOG.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-zinc-500 transition-colors hover:text-white"
            >
              Changelog
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}

function ChartIcon() {
  return (
    <svg
      className="h-5 w-5"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z"
      />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg
      className="h-5 w-5"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0"
      />
    </svg>
  );
}

function LayersIcon() {
  return (
    <svg
      className="h-5 w-5"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M6.429 9.75 2.25 12l4.179 2.25m0-4.5 5.571 3 5.571-3m-11.142 0L2.25 7.5 12 2.25l9.75 5.25-4.179 2.25m0 0L12 12.75 6.429 9.75m11.142 0 4.179 2.25-9.75 5.25-9.75-5.25 4.179-2.25"
      />
    </svg>
  );
}

function CodeIcon() {
  return (
    <svg
      className="h-5 w-5"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5"
      />
    </svg>
  );
}
