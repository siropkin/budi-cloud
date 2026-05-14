import { fmtNum } from "@/lib/format";

/**
 * Per-session input-vs-output token bar (#215). Renders inside the Activity
 * card on `/dashboard/sessions/<id>` so a viewer answers "was this session
 * read-heavy or generation-heavy?" without doing the math themselves.
 *
 * Output-only sessions (input = 0, output > 0) — the May-2026+ VS Code
 * Copilot Chat shape per ADR-0092 §2.3 v3 — collapse to a single full-width
 * Output segment annotated with the same `(output-only)` label the Tokens
 * field already uses, so the breakdown and the tabular row agree.
 *
 * Empty sessions (both 0) return null rather than rendering a 0-width bar
 * that reads as a broken element. Cache tokens are intentionally absent —
 * the column lives on `daily_rollups` but not on `session_summaries`
 * (see #215 "Out of scope").
 */
export function SessionTokenComposition({
  inputTokens,
  outputTokens,
}: {
  inputTokens: number;
  outputTokens: number;
}) {
  const total = inputTokens + outputTokens;
  if (total <= 0) return null;

  const isOutputOnly = inputTokens === 0 && outputTokens > 0;
  const inputPct = (inputTokens / total) * 100;
  const outputPct = (outputTokens / total) * 100;

  const inputTooltip = `Input: ${fmtNum(inputTokens)} (${pctLabel(inputPct)})`;
  const outputTooltip = `Output: ${fmtNum(outputTokens)} (${pctLabel(
    outputPct
  )})${isOutputOnly ? " (output-only)" : ""}`;

  return (
    <div className="mt-1" data-testid="session-token-composition">
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-sm bg-white/[0.03]"
        role="img"
        aria-label={
          isOutputOnly
            ? `Output ${fmtNum(outputTokens)} tokens (output-only)`
            : `Input ${fmtNum(inputTokens)} tokens, output ${fmtNum(
                outputTokens
              )} tokens`
        }
      >
        {inputTokens > 0 ? (
          <div
            className="h-full bg-zinc-300"
            style={{ width: `${inputPct}%` }}
            title={inputTooltip}
            aria-label={inputTooltip}
            data-segment="input"
          />
        ) : null}
        {outputTokens > 0 ? (
          <div
            className="h-full bg-emerald-400"
            style={{ width: `${outputPct}%` }}
            title={outputTooltip}
            aria-label={outputTooltip}
            data-segment="output"
          />
        ) : null}
      </div>
      <div
        className="mt-1 flex justify-between text-[10px] text-zinc-500"
        aria-hidden="true"
      >
        <span>
          <span
            className="mr-1 inline-block h-1.5 w-1.5 rounded-sm bg-zinc-300 align-middle"
            aria-hidden="true"
          />
          Input {fmtNum(inputTokens)}
        </span>
        <span>
          Output {fmtNum(outputTokens)}
          {isOutputOnly ? " (output-only)" : ""}
          <span
            className="ml-1 inline-block h-1.5 w-1.5 rounded-sm bg-emerald-400 align-middle"
            aria-hidden="true"
          />
        </span>
      </div>
    </div>
  );
}

function pctLabel(pct: number): string {
  if (!Number.isFinite(pct) || pct <= 0) return "0%";
  if (pct >= 99.5) return "100%";
  if (pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}
