import { describe, it, expect } from "vitest";
import {
  buildAuthCallbackUrl,
  isInvitePath,
  isSafeNextPath,
} from "./auth-redirect";

describe("isSafeNextPath", () => {
  it("accepts an invite path", () => {
    expect(isSafeNextPath("/invite/abc123")).toBe(true);
  });

  it("accepts a dashboard path", () => {
    expect(isSafeNextPath("/dashboard")).toBe(true);
    expect(isSafeNextPath("/dashboard/team")).toBe(true);
  });

  it("rejects null/empty/undefined", () => {
    expect(isSafeNextPath(null)).toBe(false);
    expect(isSafeNextPath("")).toBe(false);
    expect(isSafeNextPath(undefined)).toBe(false);
  });

  it("rejects absolute URLs (open-redirect guard)", () => {
    expect(isSafeNextPath("https://evil.example/invite/x")).toBe(false);
    expect(isSafeNextPath("http://evil.example")).toBe(false);
  });

  it("rejects protocol-relative URLs (open-redirect guard)", () => {
    expect(isSafeNextPath("//evil.example/invite/x")).toBe(false);
  });

  it("rejects paths outside the whitelist", () => {
    expect(isSafeNextPath("/login")).toBe(false);
    expect(isSafeNextPath("/setup")).toBe(false);
    expect(isSafeNextPath("/")).toBe(false);
  });
});

describe("isInvitePath", () => {
  it("returns true for /invite/<token>", () => {
    expect(isInvitePath("/invite/abc123")).toBe(true);
  });

  it("returns false for everything else", () => {
    expect(isInvitePath("/dashboard")).toBe(false);
    expect(isInvitePath(null)).toBe(false);
    expect(isInvitePath(undefined)).toBe(false);
    expect(isInvitePath("/invitex")).toBe(false);
  });
});

describe("buildAuthCallbackUrl", () => {
  const origin = "https://app.example";

  it("returns the bare callback when there is no next", () => {
    expect(buildAuthCallbackUrl(origin, null)).toBe(
      "https://app.example/auth/callback"
    );
    expect(buildAuthCallbackUrl(origin, undefined)).toBe(
      "https://app.example/auth/callback"
    );
  });

  it("forwards a safe invite path through ?next=", () => {
    expect(buildAuthCallbackUrl(origin, "/invite/tok_abc")).toBe(
      "https://app.example/auth/callback?next=%2Finvite%2Ftok_abc"
    );
  });

  it("drops unsafe next values rather than forwarding them", () => {
    // Open-redirect attempts must not be reflected back as ?next=.
    expect(buildAuthCallbackUrl(origin, "https://evil.example")).toBe(
      "https://app.example/auth/callback"
    );
    expect(buildAuthCallbackUrl(origin, "//evil.example")).toBe(
      "https://app.example/auth/callback"
    );
  });
});
