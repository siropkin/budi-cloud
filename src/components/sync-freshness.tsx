"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import { ChevronDown } from "lucide-react";

/**
 * Freshness threshold beyond which a linked daemon is considered "stalled".
 *
 * The budi daemon syncs on a periodic timer (typically every 10–15 minutes
 * while running) and again whenever the user opens a surface that pushes an
 * ingest. If we haven't heard anything in more than a day, something is
 * wrong (machine off, network dropped, token revoked, ingest 401).
 */
const STALLED_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Maximum gap between the latest rollup and the latest session before we
 * call the session ingest stream "stalled" relative to rollups (#84).
 * Rollups and sessions ride in the same envelope, so on a healthy daemon
 * their watermarks track within minutes; a multi-hour drift means the
 * envelope is landing partial and the Sessions page would silently empty.
 */
const SESSIONS_LAG_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Cadence for polling `/api/freshness` to spot a newer daemon upload than
 * what the page was SSR'd with. 60s is comfortably below the daemon's own
 * 10–15 min sync cadence; the request itself is two cheap COUNT/MAX queries
 * (see `getSyncFreshness` in `dal.ts`).
 */
const FRESHNESS_POLL_INTERVAL_MS = 60_000;

export function SyncFreshness({
  deviceCount,
  lastSeenAt,
  lastRollupAt,
  lastSessionAt,
  renderedRollupAt,
}: {
  deviceCount: number;
  lastSeenAt: string | null;
  lastRollupAt: string | null;
  lastSessionAt: string | null;
  /**
   * The `lastRollupAt` the page was SSR'd with. Snapshotted on the server
   * and passed down so the client poll can detect when a newer upload has
   * landed and trigger `router.refresh()` (#133).
   */
  renderedRollupAt?: string | null;
}) {
  // Not-linked is rendered as a call-to-action so it's obvious what to do
  // next instead of looking like a silent empty dashboard.
  if (deviceCount === 0) {
    return (
      <Link
        href="/dashboard/settings"
        className="group inline-flex items-center gap-2 rounded-md border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-xs font-medium text-amber-300 transition-colors hover:border-amber-400/60 hover:bg-amber-400/20"
        data-testid="sync-freshness"
        data-sync-state="not_linked"
        title="Not linked yet — link your local Budi"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
        {/* Below `sm` the full CTA wraps the header; keep just "Link Budi". */}
        <span className="hidden sm:inline">
          Not linked yet — link your local Budi
        </span>
        <span className="sm:hidden">Link Budi</span>
      </Link>
    );
  }

  return (
    <LinkedSyncFreshness
      lastSeenAt={lastSeenAt}
      lastRollupAt={lastRollupAt}
      lastSessionAt={lastSessionAt}
      renderedRollupAt={renderedRollupAt ?? lastRollupAt}
    />
  );
}

/**
 * Inner component that is only rendered once we know the account has at
 * least one device. Splitting this out keeps the `useNow` hook unconditional
 * (React hook ordering rules) while still allowing the parent to short-
 * circuit the not-linked state.
 */
function LinkedSyncFreshness({
  lastSeenAt,
  lastRollupAt,
  lastSessionAt,
  renderedRollupAt,
}: {
  lastSeenAt: string | null;
  lastRollupAt: string | null;
  lastSessionAt: string | null;
  renderedRollupAt: string | null;
}) {
  const now = useNow(60_000);
  const isRefreshing = useFreshnessAutoRefresh(renderedRollupAt);
  const effective = lastRollupAt ?? lastSeenAt;
  const isStalled =
    effective !== null && now - Date.parse(effective) > STALLED_AFTER_MS;
  // Sessions-stalled is only meaningful once the viewer has both a rollup
  // and a previously-seen session: a brand-new account legitimately has
  // rollups but no sessions until the daemon closes its first one. Total
  // daemon-stalled wins, since the popover already covers that case.
  const isSessionsStalled =
    !isStalled &&
    lastRollupAt !== null &&
    lastSessionAt !== null &&
    Date.parse(lastRollupAt) - Date.parse(lastSessionAt) >
      SESSIONS_LAG_THRESHOLD_MS;
  const state:
    | "linked_no_data"
    | "stalled"
    | "sessions_stalled"
    | "refreshing"
    | "ok" = !lastRollupAt
    ? "linked_no_data"
    : isStalled
      ? "stalled"
      : isSessionsStalled
        ? "sessions_stalled"
        : isRefreshing
          ? "refreshing"
          : "ok";

  // Stalled mirrors the `not_linked` CTA pattern: make it actionable so the
  // user can self-serve. The popover names the two CLI commands and the
  // config file that are almost always the answer (#53).
  if (state === "stalled") {
    return <StalledBadge effective={effective} now={now} />;
  }

  if (state === "sessions_stalled") {
    return (
      <SessionsStalledBadge
        lastRollupAt={lastRollupAt!}
        lastSessionAt={lastSessionAt!}
        now={now}
      />
    );
  }

  return (
    <div
      className={clsx(
        "inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs font-medium",
        state === "ok" &&
          "border-emerald-400/20 bg-emerald-400/5 text-emerald-300",
        state === "refreshing" &&
          "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
        state === "linked_no_data" &&
          "border-sky-400/20 bg-sky-400/5 text-sky-300"
      )}
      data-testid="sync-freshness"
      data-sync-state={state}
      title={
        effective
          ? `Last contact: ${new Date(effective).toLocaleString()}`
          : "No sync activity recorded yet"
      }
    >
      <span
        className={clsx(
          "h-1.5 w-1.5 rounded-full",
          state === "ok" && "bg-emerald-300",
          state === "refreshing" && "animate-pulse bg-emerald-300",
          state === "linked_no_data" && "animate-pulse bg-sky-300"
        )}
      />
      <SyncFreshnessLabel state={state} effective={effective} now={now} />
    </div>
  );
}

function StalledBadge({
  effective,
  now,
}: {
  effective: string | null;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const relative = effective
    ? formatRelative(Date.parse(effective), now)
    : "unknown";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="sync-freshness"
        data-sync-state="stalled"
        title={
          effective
            ? `Last contact: ${new Date(effective).toLocaleString()}`
            : undefined
        }
        className="inline-flex items-center gap-2 rounded-md border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-xs font-medium text-amber-300 transition-colors hover:border-amber-400/60 hover:bg-amber-400/20"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
        <span className="hidden sm:inline">Local Budi stalled · </span>
        <span>{relative}</span>
        <ChevronDown
          className={clsx("h-3 w-3 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Cloud sync is stalled"
          className="absolute right-0 top-full z-20 mt-1 w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-white/10 bg-zinc-950 p-3 text-xs text-zinc-300 shadow-xl"
          data-testid="sync-freshness-popover"
        >
          <p className="mb-1 text-zinc-100">
            No data has reached the cloud in over 24 hours.
          </p>
          <p className="mb-2 text-zinc-400">From your local machine:</p>
          <ol className="mb-3 list-decimal space-y-1 pl-4">
            <li>
              <code className="rounded bg-black/40 px-1 text-zinc-200">
                budi cloud status
              </code>{" "}
              — diagnose what&rsquo;s off
            </li>
            <li>
              <code className="rounded bg-black/40 px-1 text-zinc-200">
                budi cloud sync
              </code>{" "}
              — push queued data now
            </li>
            <li>
              Check{" "}
              <code className="rounded bg-black/40 px-1 text-zinc-200">
                ~/.config/budi/cloud.toml
              </code>{" "}
              has{" "}
              <code className="rounded bg-black/40 px-1 text-zinc-200">
                enabled = true
              </code>{" "}
              and a real{" "}
              <code className="rounded bg-black/40 px-1 text-zinc-200">
                api_key
              </code>
              .
            </li>
          </ol>
          <a
            className="text-zinc-400 underline decoration-dotted underline-offset-2 hover:text-zinc-200"
            href="https://github.com/siropkin/budi/blob/main/docs/adr/0083-cloud-ingest-identity-and-privacy-contract.md"
            target="_blank"
            rel="noreferrer"
          >
            ADR-0083 — cloud sync contract
          </a>
        </div>
      )}
    </div>
  );
}

function SessionsStalledBadge({
  lastRollupAt,
  lastSessionAt,
  now,
}: {
  lastRollupAt: string;
  lastSessionAt: string;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const sessionRelative = formatRelative(Date.parse(lastSessionAt), now);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="sync-freshness"
        data-sync-state="sessions_stalled"
        title={`Last session: ${new Date(lastSessionAt).toLocaleString()} — last rollup: ${new Date(lastRollupAt).toLocaleString()}`}
        className="inline-flex items-center gap-2 rounded-md border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-xs font-medium text-amber-300 transition-colors hover:border-amber-400/60 hover:bg-amber-400/20"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
        <span className="hidden sm:inline">Sessions stalled — last </span>
        <span className="sm:hidden">Sessions </span>
        <span>{sessionRelative}</span>
        <ChevronDown
          className={clsx("h-3 w-3 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Session ingest is stalled"
          className="absolute right-0 top-full z-20 mt-1 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-white/10 bg-zinc-950 p-3 text-xs text-zinc-300 shadow-xl"
          data-testid="sync-freshness-popover"
        >
          <p className="mb-1 text-zinc-100">
            Daily totals are still landing, but new sessions stopped{" "}
            {sessionRelative}.
          </p>
          <p className="mb-2 text-zinc-400">
            The Sessions page will look empty even though Overview is up to
            date. From your local machine:
          </p>
          <ol className="mb-3 list-decimal space-y-1 pl-4">
            <li>
              <code className="rounded bg-black/40 px-1 text-zinc-200">
                budi cloud status
              </code>{" "}
              — confirm the daemon is healthy
            </li>
            <li>
              <code className="rounded bg-black/40 px-1 text-zinc-200">
                budi --version
              </code>{" "}
              — make sure you&rsquo;re on a recent build
            </li>
            <li>
              If both look fine, file an issue — sessions diverging from rollups
              usually means a daemon-side regression.
            </li>
          </ol>
          <a
            className="text-zinc-400 underline decoration-dotted underline-offset-2 hover:text-zinc-200"
            href="https://github.com/siropkin/budi-cloud/issues/84"
            target="_blank"
            rel="noreferrer"
          >
            Tracking issue #84
          </a>
        </div>
      )}
    </div>
  );
}

function SyncFreshnessLabel({
  state,
  effective,
  now,
}: {
  state: "linked_no_data" | "ok" | "refreshing";
  effective: string | null;
  now: number;
}) {
  if (state === "linked_no_data") {
    return (
      <>
        {/* Below `sm` the dot already conveys the state; shorten the copy. */}
        <span className="hidden sm:inline">
          Local Budi · waiting for first upload…
        </span>
        <span className="sm:hidden">Waiting…</span>
      </>
    );
  }
  if (state === "refreshing") {
    return (
      <>
        <span className="hidden sm:inline">Local Budi · new data, refreshing…</span>
        <span className="sm:hidden">Refreshing…</span>
      </>
    );
  }
  if (!effective) return <>Unknown</>;
  return (
    <>
      {/*
        Source prefix is redundant with the colored dot at mobile widths.
        Drop it below `sm` so the whole badge fits next to the hamburger +
        logout icon on a 390px viewport.
      */}
      <span className="hidden sm:inline">Local Budi · uploaded </span>
      <span>{formatRelative(Date.parse(effective), now)}</span>
    </>
  );
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * Polls `/api/freshness` while the tab is visible and triggers a server
 * re-render when the daemon has uploaded something newer than what the
 * page was SSR'd with. Returns `true` for the brief window between
 * "we noticed new data" and "the new SSR has flowed back" so the badge
 * can show a transient `refreshing…` state (#133).
 *
 * Visibility-aware so backgrounded tabs don't burn one request/min, and
 * `router.refresh()` is deferred to the next tick to avoid yanking chart
 * state mid-interaction (e.g. if a period button was just clicked).
 */
function useFreshnessAutoRefresh(renderedRollupAt: string | null): boolean {
  const router = useRouter();
  // The newest watermark the poller has *seen* on the server. The badge
  // is "refreshing" while this is strictly newer than the prop the page
  // was SSR'd with — once a fresh SSR flows back through `renderedRollupAt`,
  // the comparison naturally goes false (no effect needed to clear it).
  const [pendingRollupAt, setPendingRollupAt] = useState<string | null>(null);
  // Mirror the latest SSR'd watermark into a ref so the polling closure
  // doesn't need to re-subscribe each render.
  const renderedRef = useRef<string | null>(renderedRollupAt);
  useEffect(() => {
    renderedRef.current = renderedRollupAt;
  }, [renderedRollupAt]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function check() {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const res = await fetch("/api/freshness", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { lastRollupAt: string | null };
        const seen = renderedRef.current;
        if (
          data.lastRollupAt &&
          (!seen || Date.parse(data.lastRollupAt) > Date.parse(seen))
        ) {
          setPendingRollupAt(data.lastRollupAt);
          // Defer to the next tick so we don't preempt a just-fired
          // navigation (e.g. a period-selector click).
          setTimeout(() => {
            if (!cancelled) router.refresh();
          }, 0);
        }
      } catch {
        // Network blip — try again next tick.
      }
    }

    function start() {
      if (timer !== null) return;
      timer = setInterval(check, FRESHNESS_POLL_INTERVAL_MS);
    }
    function stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    }
    function onVisibility() {
      if (document.hidden) {
        stop();
      } else {
        // Catch up the moment the tab is foregrounded — don't make the user
        // wait up to a full minute for the next tick.
        check();
        start();
      }
    }

    if (typeof document !== "undefined" && !document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [router]);

  if (!pendingRollupAt) return false;
  if (!renderedRollupAt) return true;
  return Date.parse(pendingRollupAt) > Date.parse(renderedRollupAt);
}

export function formatRelative(
  whenMs: number,
  now: number = Date.now()
): string {
  const diff = Math.max(0, now - whenMs);
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const months = Math.floor(d / 30);
  if (months < 12) return `${months}mo ago`;
  const y = Math.floor(d / 365);
  return `${y}y ago`;
}
