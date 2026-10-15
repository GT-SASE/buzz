import { describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({
  current: null as {
    user: { role: "ADMIN" | "SUPER_ADMIN" | "MEMBER" };
  } | null,
}));

vi.mock("../packages/auth/src/index.ts", () => ({
  auth: async () => session.current,
  handlers: {},
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

const { GET } = await import("~/app/portal/start/route");
const { signInPath } = await import("~/app/portal/_lib/paths");

async function landing() {
  const request = new Request("https://sase.test/portal/start");
  const response = await GET(request as Parameters<typeof GET>[0]);
  const location = new URL(response.headers.get("location")!);
  return location.pathname + location.search;
}

describe("/portal/start", () => {
  it("sends a visitor to sign in, coming back here after", async () => {
    session.current = null;
    expect(await landing()).toBe(signInPath("/portal/start"));
  });

  it("sends a member to their card", async () => {
    session.current = { user: { role: "MEMBER" } };
    expect(await landing()).toBe("/portal");
  });

  it("sends an officer to the officer view", async () => {
    session.current = { user: { role: "ADMIN" } };
    expect(await landing()).toBe("/portal/admin");
  });

  it("sends a super admin to the officer view too", async () => {
    session.current = { user: { role: "SUPER_ADMIN" } };
    expect(await landing()).toBe("/portal/admin");
  });
});
