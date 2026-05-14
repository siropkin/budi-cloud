import { signOut } from "@/app/actions/auth";
import { LogOut } from "lucide-react";

export function UserMenu({
  displayName,
  email,
}: {
  displayName: string | null;
  email: string | null;
}) {
  return (
    <div className="flex items-center gap-2 sm:gap-3">
      {/*
        Below `sm` the header needs every pixel for the sync badge + logout.
        `sm` to `md` shows just the display name. `md+` also surfaces the
        email for quick context. The email is hidden below `md` because it's
        the longest element and overflow is the main mobile pain point.
      */}
      <div className="hidden text-right sm:block">
        <p className="text-sm font-medium text-zinc-200">
          {displayName || "User"}
        </p>
        {email && (
          <p className="hidden text-xs text-zinc-500 md:block">{email}</p>
        )}
      </div>
      <form action={signOut}>
        <button
          type="submit"
          className="rounded-lg p-2 text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
          title="Sign out"
          aria-label="Sign out"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
}
