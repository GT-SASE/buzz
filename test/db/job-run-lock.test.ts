import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgliteSql, recordingSql } from "../support/sql-client.ts";
import { createDbClient, type DbClient } from "../../src/db/client.ts";
import {
  beginJobRun,
  finishJobRun,
  getLatestJobRun,
  getLatestSucceededJobRun,
} from "../../src/db/job-runs.ts";
import { applyConfigChange } from "../../src/db/guild-config.ts";
import { listActiveManagedChannels } from "../../src/db/managed-channels.ts";
import { slotStart } from "../../src/reminders/plan.ts";
import { insertGuild } from "./fixtures.ts";
import {
  OTHER_ROLE,
  createMigratedDb,
  fakeId,
  present,
  queryAs,
} from "./harness.ts";

const STALE_SECONDS = 120;

describe("begin_job_run", () => {
  let database: PGlite;
  let db: DbClient;

  /** The start of the current slot. */
  const currentSlot = (): Date => new Date(slotStart(new Date()));

  const begin = () =>
    beginJobRun(db, {
      jobName: "reminders",
      staleAfterSeconds: STALE_SECONDS,
      slotStart: currentSlot(),
    });

  const beginOk = async () => {
    const result = await begin();
    if (!result.ok) {
      throw new Error(result.error.category);
    }
    return result.value;
  };

  beforeAll(async () => {
    database = await createMigratedDb();
    db = createDbClient(pgliteSql(database));
  });

  afterAll(() => database.close());

  beforeEach(async () => {
    await database.exec("DELETE FROM public.job_runs");
  });

  it("gives the first caller a run", async () => {
    const id = present(await beginOk());
    const latest = await getLatestJobRun(db, { jobName: "reminders" });
    expect(latest).toMatchObject({
      ok: true,
      value: { id, status: "running" },
    });
  });

  it("refuses a second start while a run is live", async () => {
    present(await beginOk());
    expect(await beginOk()).toBeNull();
  });

  it("gives exactly one of many simultaneous callers a run", async () => {
    const ids = await Promise.all(Array.from({ length: 8 }, beginOk));
    expect(ids.filter((id) => id !== null)).toHaveLength(1);
  });

  const insertRun = async (status: "succeeded" | "failed", startedAt: Date) => {
    await database.query(
      `INSERT INTO public.job_runs (job_name, status, started_at, heartbeat_at, finished_at)
       VALUES ('reminders', $1, $2, $2, $2)`,
      [status, startedAt],
    );
  };

  it("refuses a repeat after a run that succeeded", async () => {
    const id = present(await beginOk());
    await finishJobRun(db, { id, now: new Date(), results: {}, error: null });
    expect(await beginOk()).toBeNull();
  });

  it("makes the later cron a no-op after a good morning run", async () => {
    await insertRun("succeeded", currentSlot());
    expect(await beginOk()).toBeNull();
  });

  it("lets the later cron run after a failed morning run", async () => {
    await insertRun("failed", currentSlot());
    expect(await beginOk()).not.toBeNull();
  });

  it("does not count a success from before this slot began", async () => {
    await insertRun("succeeded", new Date(currentSlot().getTime() - 1000));
    expect(await beginOk()).not.toBeNull();
  });

  it("works the slot out in UTC whatever the session's zone", async () => {
    for (const zone of ["Pacific/Auckland", "Pacific/Honolulu"]) {
      await database.exec(`DELETE FROM public.job_runs`);
      await database.exec(`SET TIME ZONE '${zone}'`);
      try {
        await insertRun("succeeded", new Date(currentSlot().getTime() - 1000));
        expect(await beginOk()).not.toBeNull();
        await database.exec(`DELETE FROM public.job_runs`);
        await insertRun("succeeded", currentSlot());
        expect(await beginOk()).toBeNull();
      } finally {
        await database.exec(`SET TIME ZONE 'UTC'`);
      }
    }
  });

  it("allows a repeat straight after a run that failed", async () => {
    const id = present(await beginOk());
    await finishJobRun(db, {
      id,
      now: new Date(),
      results: {},
      error: { category: "discord_unauthorized", code: "401" },
    });
    expect(await beginOk()).not.toBeNull();
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

  it("gives way to the index if a running row appeared without the lock", async () => {
    await database.exec(
      `INSERT INTO public.job_runs (job_name) VALUES ('reminders')`,
    );
    expect(await beginOk()).toBeNull();
  });

  it("keeps one job's lock apart from another's", async () => {
    present(await beginOk());
    const other = await beginJobRun(db, {
      jobName: "health_check",
      staleAfterSeconds: STALE_SECONDS,
      slotStart: currentSlot(),
    });
    expect(other).toMatchObject({
      ok: true,
      value: expect.any(String) as string,
    });
  });

  it("is closed to a role with no grants", async () => {
    await expect(
      queryAs(
        database,
        OTHER_ROLE,
        `SELECT public.begin_job_run('reminders', 1, now())`,
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses a start with no slot", async () => {
    await expect(
      queryAs(
        database,
        "bot_app",
        `SELECT public.begin_job_run('reminders', 120, NULL)`,
      ),
    ).rejects.toMatchObject({ code: "22023" });
  });

  it("stores a run's failure as a category and code only", async () => {
    const id = present(await beginOk());
    expect(
      await finishJobRun(db, {
        id,
        now: new Date(),
        results: {},
        error: { category: "has text in it", code: null },
      }),
    ).toMatchObject({ ok: false, error: { category: "invalid_input" } });
    expect(
      await finishJobRun(db, {
        id,
        now: new Date(),
        results: {},
        error: { category: "discord_api", code: "not a code!" },
      }),
    ).toMatchObject({ ok: false, error: { category: "invalid_input" } });
    expect(
      await finishJobRun(db, {
        id,
        now: new Date(),
        results: {},
        error: { category: "discord_api", code: "200000" },
      }),
    ).toMatchObject({ ok: true, value: { error: "discord_api:200000" } });
  });

  describe("finish_job_run", () => {
    const finishedAt = async (id: string) => {
      const { rows } = await database.query<{ future: boolean }>(
        `SELECT finished_at > now() AS future FROM public.job_runs WHERE id = $1`,
        [id],
      );
      return present(rows[0]).future;
    };

    it("records a success and closes the slot", async () => {
      const id = present(await beginOk());
      expect(
        await finishJobRun(db, {
          id,
          now: new Date(),
          results: { sent: 2 },
          error: null,
        }),
      ).toMatchObject({
        ok: true,
        value: { id, status: "succeeded", results: { sent: 2 }, error: null },
      });
      expect(await beginOk()).toBeNull();
    });

    it("records a failure and leaves the slot open", async () => {
      const id = present(await beginOk());
      expect(
        await finishJobRun(db, {
          id,
          now: new Date(),
          results: {},
          error: { category: "unexpected", code: null },
        }),
      ).toMatchObject({
        ok: true,
        value: { id, status: "failed", error: "unexpected" },
      });
      expect(await beginOk()).not.toBeNull();
    });

    it("finds nothing to finish for an unknown or finished run", async () => {
      const notFound = { ok: false, error: { category: "not_found" } };
      const finish = (id: string) =>
        finishJobRun(db, { id, now: new Date(), results: {}, error: null });
      expect(await finish(crypto.randomUUID())).toMatchObject(notFound);
      const id = present(await beginOk());
      expect((await finish(id)).ok).toBe(true);
      expect(await finish(id)).toMatchObject(notFound);
    });

    it("never records a finish later than the database's clock", async () => {
      const id = present(await beginOk());
      const farAhead = new Date(Date.now() + 365 * 86_400_000);
      await finishJobRun(db, {
        id,
        now: farAhead,
        results: {},
        error: null,
      });
      expect(await finishedAt(id)).toBe(false);
    });

    it("takes the lock that begin_job_run takes, with a limited wait", async () => {
      // PGlite has one connection, so a lock cannot really be contended here. The
      // concurrency tests prove the wait, and this holds both functions to the same lock.
      const id = present(await beginOk());
      await database.exec("BEGIN");
      try {
        await queryAs(
          database,
          "bot_app",
          `SELECT public.finish_job_run($1, now(), '{}', NULL)`,
          [id],
        );
        const { rows } = await database.query<{ held: number }>(
          `SELECT count(*)::int AS held FROM pg_locks
           WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
             AND (classid::bigint << 32) | objid::bigint =
                 hashtextextended('job_runs:reminders', 0)`,
        );
        expect(rows).toEqual([{ held: 1 }]);
        const timeout = await database.query(`SHOW lock_timeout`);
        expect(timeout.rows).toEqual([{ lock_timeout: "3s" }]);
      } finally {
        await database.exec("ROLLBACK");
      }
    });

    it("is closed to a role with no grants", async () => {
      await expect(
        queryAs(
          database,
          OTHER_ROLE,
          `SELECT public.finish_job_run(gen_random_uuid(), now(), '{}', NULL)`,
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });

  describe("a time in the future", () => {
    const FUTURE = "2099-01-01T00:00:00Z";

    /** Writes a row as a restored database could hold it. */
    const insertForged = async (sql: string) => {
      await database.exec(sql);
    };

    it("does not close the slot when a success already holds one", async () => {
      await insertForged(
        `INSERT INTO public.job_runs (job_name, status, started_at, heartbeat_at, finished_at)
         VALUES ('reminders', 'succeeded', '${FUTURE}', '${FUTURE}', '${FUTURE}')`,
      );
      expect(await beginOk()).not.toBeNull();
    });

    it("is closed as abandoned when a running row already holds one", async () => {
      await insertForged(
        `INSERT INTO public.job_runs (job_name, started_at, heartbeat_at)
         VALUES ('reminders', '${FUTURE}', '${FUTURE}')`,
      );
      const next = present(await beginOk());
      const { rows } = await database.query<{ status: string; error: string }>(
        `SELECT status, error FROM public.job_runs WHERE id <> $1`,
        [next],
      );
      expect(rows).toEqual([{ status: "failed", error: "abandoned" }]);
    });
  });

  it("limits how long a start waits for the job's lock", async () => {
    await database.exec("BEGIN");
    try {
      await queryAs(
        database,
        "bot_app",
        `SELECT public.begin_job_run('reminders', 120, now())`,
      );
      const { rows } = await database.query(`SHOW lock_timeout`);
      expect(rows).toEqual([{ lock_timeout: "3s" }]);
    } finally {
      await database.exec("ROLLBACK");
    }
  });

  it("finds the latest succeeded run, not the latest run", async () => {
    expect(
      await getLatestSucceededJobRun(db, { jobName: "reminders" }),
    ).toEqual({ ok: true, value: null });
    const first = present(await beginOk());
    await finishJobRun(db, {
      id: first,
      now: new Date(),
      results: {},
      error: null,
    });
    await database.query(
      `UPDATE public.job_runs SET started_at = started_at - interval '25 hours'`,
    );
    const second = present(await beginOk());
    await finishJobRun(db, {
      id: second,
      now: new Date(),
      results: {},
      error: { category: "unexpected", code: null },
    });
    expect(
      await getLatestSucceededJobRun(db, { jobName: "reminders" }),
    ).toMatchObject({ ok: true, value: { id: first } });
  });
});

describe("listActiveManagedChannels", () => {
  let database: PGlite;
  let db: DbClient;

  beforeAll(async () => {
    database = await createMigratedDb();
    db = createDbClient(pgliteSql(database));
  });

  afterAll(() => database.close());

  it("lists active channels across guilds and leaves out the rest", async () => {
    const one = await insertGuild(database);
    const two = await insertGuild(database);
    const gone = await insertGuild(database);
    await queryAs(
      database,
      "bot_app",
      `SELECT public.mark_channel_unavailable($1, $2)`,
      [gone.guildId, gone.channelId],
    );
    const result = await listActiveManagedChannels(db);
    if (!result.ok) {
      throw new Error(result.error.category);
    }
    expect(result.value.truncated).toBe(false);
    const ids = result.value.rows.map((row) => row.channel_id);
    expect(ids).toEqual(expect.arrayContaining([one.channelId, two.channelId]));
    expect(ids).not.toContain(gone.channelId);
  });
});

describe("a time zone in a config change", () => {
  it.each(["Factory", "factory", "Not/AZone"])(
    "is refused before any query for %j",
    async (timezone) => {
      let requests = 0;
      const counting = createDbClient(
        recordingSql(() => {
          requests += 1;
          return new Error("no request expected");
        }).sql,
      );
      const result = await applyConfigChange(counting, {
        guildId: fakeId(),
        actorId: fakeId(),
        expectedVersion: 1,
        remindersEnabled: null,
        addChannelIds: [],
        removeChannelIds: [],
        timezone,
      });
      expect(result).toMatchObject({
        ok: false,
        error: { category: "invalid_input" },
      });
      expect(requests).toBe(0);
    },
  );
});
