import { describe, it, expect } from "vitest";
import { formatPeriodCaption } from "@/lib/periods";

describe("formatPeriodCaption", () => {
  it("falls back to the default window when the param is missing", () => {
    expect(formatPeriodCaption(undefined)).toBe("Showing last 7 days");
  });

  it("uses singular copy for a one-day window", () => {
    expect(formatPeriodCaption("1")).toBe("Showing last 1 day");
  });

  it("matches the numeric value for preset windows", () => {
    expect(formatPeriodCaption("7")).toBe("Showing last 7 days");
    expect(formatPeriodCaption("30")).toBe("Showing last 30 days");
  });

  it("labels the lifetime preset explicitly", () => {
    expect(formatPeriodCaption("all")).toBe("Showing all time");
  });

  it("falls back to the default when the param is unparseable", () => {
    expect(formatPeriodCaption("garbage")).toBe("Showing last 7 days");
    expect(formatPeriodCaption("-5")).toBe("Showing last 7 days");
    expect(formatPeriodCaption("0")).toBe("Showing last 7 days");
  });
});
