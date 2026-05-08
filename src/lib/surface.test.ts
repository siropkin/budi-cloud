import { describe, expect, it } from "vitest";
import {
  formatSurface,
  isAllUnknownSurface,
  parseSurfaceParam,
} from "./surface";

describe("parseSurfaceParam", () => {
  it("returns [] for null / undefined / empty", () => {
    expect(parseSurfaceParam(null)).toEqual([]);
    expect(parseSurfaceParam(undefined)).toEqual([]);
    expect(parseSurfaceParam("")).toEqual([]);
  });

  it("splits CSV and trims whitespace", () => {
    expect(parseSurfaceParam("vscode,cursor")).toEqual(["vscode", "cursor"]);
    expect(parseSurfaceParam(" vscode , cursor ")).toEqual([
      "vscode",
      "cursor",
    ]);
    expect(parseSurfaceParam("vscode,,cursor")).toEqual(["vscode", "cursor"]);
  });
});

describe("formatSurface", () => {
  it("maps known ids to friendly labels", () => {
    expect(formatSurface("vscode")).toBe("VS Code");
    expect(formatSurface("cursor")).toBe("Cursor");
    expect(formatSurface("jetbrains")).toBe("JetBrains");
    expect(formatSurface("terminal")).toBe("Terminal");
    expect(formatSurface("unknown")).toBe("Unknown");
  });

  it("title-cases unrecognised surfaces so a future id still renders", () => {
    expect(formatSurface("zed")).toBe("Zed");
  });

  it("falls back to 'Unknown' for null / undefined / empty", () => {
    expect(formatSurface(null)).toBe("Unknown");
    expect(formatSurface(undefined)).toBe("Unknown");
    expect(formatSurface("")).toBe("Unknown");
  });
});

describe("isAllUnknownSurface (#210)", () => {
  it("returns false for an empty list — that's 'no data', not 'all unknown'", () => {
    expect(isAllUnknownSurface([])).toBe(false);
  });

  it("returns true when every row is the schema-default 'unknown'", () => {
    expect(isAllUnknownSurface([{ surface: "unknown" }])).toBe(true);
    expect(
      isAllUnknownSurface([{ surface: "unknown" }, { surface: "unknown" }])
    ).toBe(true);
  });

  it("treats null / undefined surface as unknown — defense in depth on the row shape", () => {
    expect(isAllUnknownSurface([{ surface: null }])).toBe(true);
    expect(isAllUnknownSurface([{ surface: undefined }])).toBe(true);
  });

  it("returns false for any mix of named + unknown — keep the unknown bar visible alongside named surfaces", () => {
    expect(
      isAllUnknownSurface([{ surface: "unknown" }, { surface: "vscode" }])
    ).toBe(false);
    expect(
      isAllUnknownSurface([{ surface: "vscode" }, { surface: "unknown" }])
    ).toBe(false);
  });

  it("returns false when every row is named (no unknown at all)", () => {
    expect(
      isAllUnknownSurface([{ surface: "vscode" }, { surface: "cursor" }])
    ).toBe(false);
  });
});
