import { describe, expect, it, vi } from "vitest";

vi.mock("../packages/auth/src/index.ts", () => ({
  auth: () => Promise.resolve(null),
  handlers: {},
  signIn: () => Promise.resolve(undefined),
  signOut: () => Promise.resolve(undefined),
}));

vi.stubEnv("NODE_ENV", "production");
const { createCaller } = await import("../packages/api/src/root");
const { resetRateLimits } = await import("../packages/api/src/rate-limit");
vi.unstubAllEnvs();

type Ctx = Parameters<typeof createCaller>[0];

function memberCtx(db: unknown): Ctx {
  return {
    db,
    session: {
      user: { id: "member-1", role: "MEMBER", email: "member@gatech.edu" },
      expires: "2099-01-01T00:00:00.000Z",
    },
    headers: new Headers(),
  } as unknown as Ctx;
}

async function rejection(
  promise: Promise<unknown>,
): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error("expected the procedure to reject, but it resolved");
}

describe("resume.mine", () => {
  it("returns metadata without file bytes", async () => {
    resetRateLimits();
    const db = {
      query: {
        resumes: {
          findFirst: () =>
            Promise.resolve({
              fileName: "resume.pdf",
              mimeType: "application/pdf",
              byteSize: 1200,
              uploadedAt: new Date("2026-09-06T12:00:00.000Z"),
            }),
        },
      },
    };

    const result = await createCaller(memberCtx(db)).resume.mine();
    expect(result).toMatchObject({
      fileName: "resume.pdf",
      byteSize: 1200,
    });
    expect(result).not.toHaveProperty("fileBytes");
  });
});

describe("resume.remove", () => {
  it("deletes the caller's row", async () => {
    resetRateLimits();
    const deleted: unknown[] = [];
    const db = {
      delete: () => ({
        where: () => ({
          returning: () => {
            deleted.push("ok");
            return Promise.resolve([
              {
                fileName: "resume.pdf",
                mimeType: "application/pdf",
                byteSize: 1200,
                uploadedAt: new Date("2026-09-06T12:00:00.000Z"),
              },
            ]);
          },
        }),
      }),
    };

    await createCaller(memberCtx(db)).resume.remove();
    expect(deleted).toHaveLength(1);
  });

  it("answers an empty delete with NOT_FOUND", async () => {
    resetRateLimits();
    const db = {
      delete: () => ({
        where: () => ({
          returning: () => Promise.resolve([]),
        }),
      }),
    };

    const error = await rejection(createCaller(memberCtx(db)).resume.remove());
    expect(error.code).toBe("NOT_FOUND");
  });
});
