import { describe, expect, it, vi } from "vitest";

import { authConfig } from "../packages/auth/src/config";

// next-auth reaches for `next/server`, which only resolves inside Next. The
// paths point into @buzz/auth because the repo root does not depend on it.
vi.mock("../packages/auth/node_modules/next-auth/index.js", () => ({}));
vi.mock("../packages/auth/node_modules/next-auth/providers/google.js", () => ({
  default: () => ({}),
}));

describe("session callback", () => {
  it("keeps the session token out of what the browser can read", () => {
    const expires = new Date("2026-11-24T00:00:00Z");
    const session = authConfig.callbacks.session({
      session: {
        sessionToken: "secret-token",
        userId: "user-1",
        expires,
        user: { id: "user-1", name: "Ada", email: "ada@example.com" },
      },
      user: {
        id: "user-1",
        name: "Ada",
        email: "ada@example.com",
        emailVerified: null,
        role: "ADMIN",
      },
    } as never);

    expect(session).toEqual({
      expires,
      user: {
        id: "user-1",
        name: "Ada",
        email: "ada@example.com",
        role: "ADMIN",
      },
    });
    expect(JSON.stringify(session)).not.toContain("secret-token");
  });
});
