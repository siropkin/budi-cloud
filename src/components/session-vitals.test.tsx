import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionVitals } from "@/components/session-vitals";

// We render to static HTML rather than pulling in React Testing Library —
// the goal here is to lock down the green/yellow/red Tailwind class map in
// `STATE_STYLES`, so a stringly diff over the markup is enough.
function row(label: string, html: string): string {
  const block = html
    .split("<li")
    .slice(1)
    .map((b) => "<li" + b)
    .find((b) => b.includes(label));
  if (!block) throw new Error(`row for "${label}" not found in markup`);
  return block;
}

describe("SessionVitals", () => {
  it("renders every row with emerald classes when all vitals are green", () => {
    const html = renderToStaticMarkup(
      <SessionVitals
        contextDrag={{ state: "green", metric: 18.2 }}
        cacheEfficiency={{ state: "green", metric: 90 }}
        thrashing={{ state: "green", metric: 0.42 }}
        costAcceleration={{ state: "green", metric: 250 }}
        overall="green"
      />
    );

    // 4 row badges + 1 overall badge = 5 emerald hits, no amber, no red.
    expect(html.match(/emerald-500\/15/g)?.length).toBe(5);
    expect(html).not.toMatch(/amber-500\/15/);
    expect(html).not.toMatch(/red-500\/15/);
    // Each badge carries its accessible state text ("green") in the body.
    expect(html.match(/>green</g)?.length).toBe(5);
  });

  it("picks the right state class per row when vitals are mixed", () => {
    const html = renderToStaticMarkup(
      <SessionVitals
        contextDrag={{ state: "green", metric: 5 }}
        cacheEfficiency={{ state: "yellow", metric: 60 }}
        thrashing={{ state: "red", metric: 1.5 }}
        costAcceleration={{ state: "green", metric: 250 }}
        overall="yellow"
      />
    );

    expect(row("Prompt Growth", html)).toMatch(/emerald-500\/15/);
    expect(row("Cache Reuse", html)).toMatch(/amber-500\/15/);
    expect(row("Cache Reuse", html)).toMatch(/>yellow</);
    expect(row("Retry Loops", html)).toMatch(/red-500\/15/);
    expect(row("Retry Loops", html)).toMatch(/>red</);
    expect(row("Cost Acceleration", html)).toMatch(/emerald-500\/15/);

    // Overall badge sits outside any <li>; it should also be amber here.
    const beforeFirstLi = html.split("<li")[0];
    expect(beforeFirstLi).toMatch(/amber-500\/15/);
  });

  it("renders the upgrade-daemon notice when every vital is null", () => {
    const html = renderToStaticMarkup(
      <SessionVitals
        contextDrag={{ state: null, metric: null }}
        cacheEfficiency={{ state: null, metric: null }}
        thrashing={{ state: null, metric: null }}
        costAcceleration={{ state: null, metric: null }}
        overall={null}
      />
    );

    expect(html).toContain(
      "Vitals not yet available — upgrade local daemon to ≥ 8.3.15."
    );
    // No badges, no row scaffolding.
    expect(html).not.toMatch(/emerald-500\/15/);
    expect(html).not.toMatch(/amber-500\/15/);
    expect(html).not.toMatch(/red-500\/15/);
    expect(html).not.toContain("<li");
    expect(html).not.toContain("Prompt Growth");
  });

  it("formats each metric with its expected suffix", () => {
    const html = renderToStaticMarkup(
      <SessionVitals
        contextDrag={{ state: "green", metric: 18.2 }}
        cacheEfficiency={{ state: "green", metric: 90 }}
        thrashing={{ state: "green", metric: 0.42 }}
        costAcceleration={{ state: "green", metric: 250 }}
        overall="green"
      />
    );

    expect(row("Prompt Growth", html)).toContain("18.2%/hr");
    expect(row("Cache Reuse", html)).toContain("90%");
    expect(row("Retry Loops", html)).toContain("0.42");
    expect(row("Cost Acceleration", html)).toContain("$2.50/turn");
  });

  it("falls back to an em-dash when a single metric is null", () => {
    const html = renderToStaticMarkup(
      <SessionVitals
        contextDrag={{ state: "green", metric: null }}
        cacheEfficiency={{ state: "green", metric: 90 }}
        thrashing={{ state: "green", metric: 0.42 }}
        costAcceleration={{ state: "green", metric: 250 }}
        overall="green"
      />
    );

    expect(row("Prompt Growth", html)).toContain("—");
    expect(row("Prompt Growth", html)).toMatch(/emerald-500\/15/);
  });
});
