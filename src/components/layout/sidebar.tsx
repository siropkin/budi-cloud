"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";
import type { MouseEventHandler } from "react";
import {
  BarChart3,
  GitBranch,
  LayoutDashboard,
  Cpu,
  Laptop,
  Menu,
  Settings,
  Timer,
  Users,
  X,
} from "lucide-react";

// Filter params that scope every dashboard page (period switcher, manager
// teammate filter, surface chip from #187). The sidebar carries them across
// navigations so users don't have to re-pick `30d` / `All team` /
// `?surface=vscode` on each page (#172).
const PRESERVED_PARAMS = ["days", "user", "surface"] as const;

/**
 * Build the `?days=…&user=…` suffix to graft onto every sidebar link, dropping
 * any other params (cursors, sorts, …) that are scoped to a single page.
 * Exported for unit testing — production callers use {@link usePreservedSearch}.
 */
export function buildPreservedSearch(
  read: (key: string) => string | null
): string {
  const params = new URLSearchParams();
  for (const key of PRESERVED_PARAMS) {
    const value = read(key);
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

// `managerOnly: true` means the link is rendered only for `role === "manager"`.
// `/dashboard/team` is scoped to the viewer's own devices (ADR-0083 §6), so for
// a member it can only ever show themselves — Settings already lists the org
// roster, so members never need this entry (#64).
const NAV_ITEMS = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/team", label: "Team", icon: Users, managerOnly: true },
  { href: "/dashboard/devices", label: "Devices", icon: Laptop },
  { href: "/dashboard/models", label: "Models", icon: Cpu },
  { href: "/dashboard/repos", label: "Repos", icon: GitBranch },
  { href: "/dashboard/sessions", label: "Sessions", icon: Timer },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
] as const;

function visibleNavItems(role: string) {
  return NAV_ITEMS.filter(
    (item) => !("managerOnly" in item && item.managerOnly) || role === "manager"
  );
}

/**
 * Desktop rail. Hidden below `md` — the mobile drawer (below) takes over
 * there so the 224px rail doesn't eat >50% of a 390px viewport.
 */
export function Sidebar({ role }: { role: string }) {
  const search = usePreservedSearch();
  return (
    <nav className="hidden w-56 flex-col border-r border-white/10 bg-[#0a0a0a] px-3 py-4 md:flex">
      <BrandLink search={search} />
      <NavList items={visibleNavItems(role)} search={search} />
    </nav>
  );
}

/**
 * Hamburger button + slide-in drawer for narrow viewports. Rendered inline in
 * the dashboard header so it sits at the top-left where users expect it.
 */
export function MobileSidebar({ role }: { role: string }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const search = usePreservedSearch();

  // ESC closes the drawer, matching the Danger-zone confirm dialog behavior.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        aria-expanded={open}
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-zinc-300 transition-colors hover:bg-white/10 hover:text-white md:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
        >
          <button
            type="button"
            aria-label="Close navigation"
            onClick={close}
            className="absolute inset-0 bg-black/60"
          />
          <nav className="relative flex h-full w-64 max-w-[80vw] flex-col border-r border-white/10 bg-[#0a0a0a] px-3 py-4">
            <div className="mb-2 flex items-center justify-between pr-1">
              <BrandLink onNavigate={close} search={search} />
              <button
                type="button"
                onClick={close}
                aria-label="Close navigation"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/10 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {/* onNavigate fires before the router commits the new pathname, so
                the drawer closes as the destination page mounts. */}
            <NavList
              items={visibleNavItems(role)}
              onNavigate={close}
              search={search}
            />
          </nav>
        </div>
      )}
    </>
  );
}

function BrandLink({
  onNavigate,
  search,
}: {
  onNavigate?: MouseEventHandler;
  search: string;
}) {
  return (
    <Link
      href={`/dashboard${search}`}
      onClick={onNavigate}
      className="mb-6 flex items-center gap-2 px-3 text-lg font-bold text-white"
    >
      <BarChart3 className="h-5 w-5 text-blue-500" />
      Budi Cloud
    </Link>
  );
}

function NavList({
  items,
  onNavigate,
  search,
}: {
  items: ReadonlyArray<(typeof NAV_ITEMS)[number]>;
  onNavigate?: MouseEventHandler;
  search: string;
}) {
  const pathname = usePathname();
  return (
    <ul className="space-y-1">
      {items.map((item) => {
        const isActive =
          item.href === "/dashboard"
            ? pathname === "/dashboard"
            : pathname.startsWith(item.href);
        const Icon = item.icon;
        return (
          <li key={item.href}>
            <Link
              href={`${item.href}${search}`}
              onClick={onNavigate}
              className={clsx(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-white/10 text-white"
                  : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function usePreservedSearch(): string {
  const searchParams = useSearchParams();
  return useMemo(
    () => buildPreservedSearch((key) => searchParams.get(key)),
    [searchParams]
  );
}
