import type { PGlite } from "@electric-sql/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { pgliteSql } from "../support/sql-client.ts";
import { createDbClient, type DbClient } from "../../src/db/client.ts";
import {
  beginJobRun,
  finishJobRun,
  getLatestJobRun,
} from "../../src/db/job-runs.ts";
import { slotStart } from "../../src/reminders/plan.ts";
import {
  INSUFFICIENT_PRIVILEGE,
  OTHER_ROLE,
  createMigratedDb,
  errorCodeOf,
  present,
  queryAs,
} from "./harness.ts";

describe("begin_job_run", () => {
  let database: PGlite;
  let db: DbClient;

  /** The start of the current slot. */
  const currentSlot = (): Date => new Date(slotStart(new Date()));

  const beginOk = async () => {
    const result = await beginJobRun(db, {
      jobName: "reminders",
      staleAfterSeconds: 120,
      slotStart: currentSlot(),
    });
    if (!result.ok) {
      throw new Error(result.error.category);
    }
    return result.value;
  };

  const insertRun = async (status: "succeeded" | "failed", startedAt: Date) => {
    await database.query(
      `INSERT INTO public.job_runs (job_name, status, started_at, heartbeat_at, finished_at)
       VALUES ('reminders', $1, $2, $2, $2)`,
      [status, startedAt],
    );
  };

  beforeAll(async () => {
    database = await createMigratedDb();
    db = createDbClient(pgliteSql(database));
  });

  afterAll(() => database.close());

  beforeEach(async () => {
    await database.exec("DELETE FROM public.job_runs");
  });

  it("gives the first caller a run and refuses a second while it is live", async () => {
    const id = present(await beginOk());
    expect(await getLatestJobRun(db, { jobName: "reminders" })).toMatchObject({
      ok: true,
      value: { id, status: "running" },
    });
    expect(await beginOk()).toBeNull();
  });

  it("gives exactly one of many simultaneous callers a run", async () => {
    const ids = await Promise.all(Array.from({ length: 8 }, beginOk));
    expect(ids.filter((id) => id !== null)).toHaveLength(1);
  });

  it.each([
    [
      "makes the later cron a no-op after a good morning run",
      "succeeded",
      0,
      false,
    ],
    ["lets the later cron run after a failed morning run", "failed", 0, true],
    [
      "does not count a success from before this slot",
      "succeeded",
      -1000,
      true,
    ],
    ["does not count a success stamped in the future", "succeeded", 1e12, true],
  ] as const)("%s", async (_name, status, offsetMs, runs) => {
    await insertRun(status, new Date(currentSlot().getTime() + offsetMs));
    expect((await beginOk()) !== null).toBe(runs);
  });

  it("works the slot out in UTC whatever the session's zone", async () => {
    await database.exec(`SET TIME ZONE 'Pacific/Auckland'`);
    try {
      await insertRun("succeeded", new Date(currentSlot().getTime() - 1000));
      expect(await beginOk()).not.toBeNull();
      await database.exec(`DELETE FROM public.job_runs`);
      await insertRun("succeeded", currentSlot());
      expect(await beginOk()).toBeNull();
    } finally {
      await database.exec(`SET TIME ZONE 'UTC'`);
    }
  });

  it("closes a run the platform killed and starts a new one", async () => {
    const dead = present(await beginOk());
    await database.query(
      `UPDATE public.job_runs SET heartbeat_at = now() - interval '3 minutes'`,
    );
    const next = present(await beginOk());
    expect(next).not.toBe(dead);
    const { rows } = await database.query<{ status: string; error: string }>(
      `SELECT status, error FROM public.job_runs WHERE id = $1`,
      [dead],
    );
    expect(rows).toEqual([{ status: "failed", error: "abandoned" }]);
  });

  it.each([
    `SELECT public.begin_job_run('reminders', 1, now())`,
    `SELECT public.finish_job_run(gen_random_uuid(), now(), '{}', NULL)`,
  ])("is closed to a role with no grants: %s", async (sql) => {
    expect(await errorCodeOf(queryAs(database, OTHER_ROLE, sql))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  describe("finish_job_run", () => {
    it.each([
      ["a success, closing the slot", null, "succeeded", null, false],
      [
        "a failure, leaving the slot open",
        { category: "unexpected", code: null },
        "failed",
        "unexpected",
        true,
      ],
    ] as const)("records %s", async (_name, error, status, stored, reopens) => {
      const id = present(await beginOk());
      expect(
        await finishJobRun(db, {
          id,
          now: new Date(),
          results: { sent: 2 },
          error,
        }),
      ).toMatchObject({
        ok: true,
        value: { id, status, results: { sent: 2 }, error: stored },
      });
      expect((await beginOk()) !== null).toBe(reopens);
    });

    it("stores a run's failure as a category and code only", async () => {
      const id = present(await beginOk());
      const finish = (category: string, code: string) =>
        finishJobRun(db, {
          id,
          now: new Date(),
          results: {},
          error: { category, code },
        });
      expect(await finish("has text in it", "1")).toMatchObject({
        ok: false,
        error: { category: "invalid_input" },
      });
      expect(await finish("discord_api", "200000")).toMatchObject({
        ok: true,
        value: { error: "discord_api:200000" },
      });
    });
  });
});
