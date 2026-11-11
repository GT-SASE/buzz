/**
 * The last catch in each function records only an error's type, because anything else
 * could quote an interaction token or row text into the platform's logs. Each test throws
 * a canary through a real endpoint and looks everywhere it could come back out.
 */

import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as cron from "../api/cron/reminders.ts";
import { POST } from "../api/interactions.ts";
import { APP_ID, commandPayload, GUILD_ID } from "./support/interactions.ts";

const CANARY = "canary-quoted-row-text";
const INTERACTION_TOKEN = "canary-interaction-token";
const CRON_SECRET = "c".repeat(40);

const failure: { thrown: unknown } = vi.hoisted(() => ({
  thrown: undefined,
}));

vi.mock("../src/handlers/dependencies.ts", () => ({
  liveDependencies: () => {
    throw failure.thrown;
  },
}));

vi.mock("../src/db/client.ts", async (original) => ({
  ...(await original<typeof import("../src/db/client.ts")>()),
  getDb: () => {
    throw failure.thrown;
  },
}));

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

const CONSOLE_METHODS = [
  "debug",
  "error",
  "info",
  "log",
  "trace",
  "warn",
] as const;

function watchConsole() {
  const spies = CONSOLE_METHODS.map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
  return () =>
    spies.flatMap((spy) => spy.mock.calls.flat() as unknown[]).map(String);
}

function signedCommand(): Request {
  const body = Buffer.from(
    JSON.stringify(commandPayload("ping", { token: INTERACTION_TOKEN })),
  );
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request("https://bot.example.test/api/interactions", {
    method: "POST",
    headers: {
      "x-signature-ed25519": sign(
        null,
        Buffer.concat([Buffer.from(timestamp), body]),
        privateKey,
      ).toString("hex"),
      "x-signature-timestamp": timestamp,
    },
    body,
  });
}

function authorizedCron(): Promise<Response> {
  return cron.GET(
    new Request("https://bot.example.test/api/cron/reminders", {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }),
  );
}

beforeEach(() => {
  vi.stubEnv(
    "DISCORD_PUBLIC_KEY",
    publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("hex"),
  );
  vi.stubEnv("DISCORD_APP_ID", APP_ID);
  vi.stubEnv("ALLOWED_GUILD_IDS", GUILD_ID);
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe.each([
  [
    "an error with a message",
    new TypeError(`${CANARY} ${INTERACTION_TOKEN}`),
    "TypeError",
  ],
  ["a thrown string", `${CANARY} ${INTERACTION_TOKEN}`, "unknown error"],
])("%s", (_label, thrown, type) => {
  beforeEach(() => {
    failure.thrown = thrown;
  });

  it("logs only its type from the interactions endpoint", async () => {
    const logged = watchConsole();

    const response = await POST(signedCommand());

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("internal error");
    expect(logged()).toEqual([`Interaction failed: ${type}`]);
  });

  it("logs only its type from the daily jobs, and the cron answer is fixed", async () => {
    const logged = watchConsole();

    const response = await authorizedCron();

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("internal error");
    expect(logged()).toEqual([`Daily jobs failed: ${type}`]);
  });
});
