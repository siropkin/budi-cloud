import { describe, it, expect } from "vitest";
import { buildPreservedSearch } from "@/components/sidebar";

function reader(record: Record<string, string>) {
  return (key: string) => record[key] ?? null;
}

describe("buildPreservedSearch", () => {
  it("returns an empty string when no preserved params are set", () => {
    expect(buildPreservedSearch(reader({}))).toBe("");
  });

  it("preserves the period switcher across navigations (#172)", () => {
    expect(buildPreservedSearch(reader({ days: "30" }))).toBe("?days=30");
    expect(buildPreservedSearch(reader({ days: "all" }))).toBe("?days=all");
  });

  it("preserves the manager teammate filter alongside the period", () => {
    expect(
      buildPreservedSearch(reader({ days: "30", user: "abc-123" }))
    ).toBe("?days=30&user=abc-123");
  });

  it("drops page-scoped params (cursor, sort, …)", () => {
    expect(
      buildPreservedSearch(
        reader({ days: "7", cursor: "eyJ0IjoiMTIzIn0", sort: "cost" })
      )
    ).toBe("?days=7");
  });

  it("ignores empty preserved values rather than emitting `?days=`", () => {
    expect(buildPreservedSearch(reader({ days: "", user: "" }))).toBe("");
  });
});
