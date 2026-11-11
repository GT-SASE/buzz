/**
 * Tests the backup job's scripts with stand-ins for pg_dump, pg_restore, psql and age.
 * These prove the scripts' decisions, not that the real tools or a real database behave
 * as expected. docs/BACKUPS.md lists what still has to be run on staging.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const BACKUP_DIR = join(import.meta.dirname, "..", "backup");
const RUN_BACKUP = join(BACKUP_DIR, "run-backup.sh");
const FRESHNESS = join(BACKUP_DIR, "check-freshness.sh");
const SUMMARY = join(BACKUP_DIR, "copy-summary.awk");
const TEMPLATE = join(BACKUP_DIR, "backup.workflow.yml.example");

const RECIPIENT_1 = `age1${"q".repeat(58)}`;
const RECIPIENT_2 = `age1${"p".repeat(58)}`;
const CANARY_PASSWORD = "canary-password-not-printed";
const PLAINTEXT_ROW = "canary row text that stays in pipes";

function copyText(tables: Record<string, number>): string {
  const blocks = Object.entries(tables).map(([name, rows]) => {
    const lines = Array.from(
      { length: rows },
      (_, i) => `${String(i)}\t${PLAINTEXT_ROW}\n`,
    );
    return `COPY ${name} (id, body) FROM stdin;\n${lines.join("")}\\.\n\n`;
  });
  return `--\n-- PostgreSQL database dump\n--\n\n\\restrict abc\nSET client_encoding = 'UTF8';\n\n${blocks.join("")}SELECT pg_catalog.setval('public.x_id_seq', 1, false);\n\\unrestrict abc\n`;
}

const GOOD_TABLES = {
  "history.row_versions": 40,
  "public.events": 30,
  "public.guild_config": 1,
  "public.interaction_claims": 25,
};

function liveLines(tables: Record<string, number>): string {
  return Object.entries(tables)
    .map(([name, rows]) => `${name} ${String(rows)}\n`)
    .join("");
}

const ROLE_OK = "backup_ro f 0 0 0 0 4\n";
const MIGRATIONS = "20261104000001\n20261104000002\n";
const MAX_ARCHIVE_BYTES = 95 * 1024 * 1024;

interface Scenario {
  dumped?: Record<string, number>;
  liveBefore?: Record<string, number>;
  liveAfter?: Record<string, number>;
  role?: string;
  pgVersion?: string;
  pgDumpFails?: boolean;
  ageWritesPlain?: boolean;
  /** The size of the file age writes, if not its real output. */
  archiveBytes?: number;
  /** What each read of the applied migrations returns. "fail" makes the read fail. */
  migrations?: string;
  migrationsAfter?: string;
}

describe("the backup job", () => {
  let root: string;
  let bin: string;
  let cwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "backup-job-"));
    bin = join(root, "bin");
    cwd = join(root, "repo");
    mkdirSync(bin);
    mkdirSync(cwd);
    writeFileSync(join(root, "ca"), "placeholder");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function stub(name: string, body: string): void {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env bash\nset -u\n${body}\n`);
    chmodSync(path, 0o755);
  }

  function installStubs(scenario: Scenario): void {
    writeFileSync(
      join(root, "copy.txt"),
      copyText(scenario.dumped ?? GOOD_TABLES),
    );
    writeFileSync(
      join(root, "before.txt"),
      liveLines(scenario.liveBefore ?? scenario.dumped ?? GOOD_TABLES),
    );
    writeFileSync(
      join(root, "after.txt"),
      liveLines(scenario.liveAfter ?? scenario.dumped ?? GOOD_TABLES),
    );
    writeFileSync(join(root, "role.txt"), scenario.role ?? ROLE_OK);
    const migrations = scenario.migrations ?? MIGRATIONS;
    writeFileSync(join(root, "migrations-before.txt"), migrations);
    writeFileSync(
      join(root, "migrations-after.txt"),
      scenario.migrationsAfter ?? migrations,
    );

    stub(
      "pg_dump",
      `if [[ "$1" == "--version" ]]; then
         echo "pg_dump (PostgreSQL) ${scenario.pgVersion ?? "17.11"}"
         exit 0
       fi
       echo "$*" >"${root}/pg_dump-args"
       ${scenario.pgDumpFails === true ? 'echo "pg_dump: error: boom" >&2; exit 1' : ""}
       printf 'PGDMP-fake-archive-${PLAINTEXT_ROW}'`,
    );
    stub("pg_restore", `cat >/dev/null; cat "${root}/copy.txt"`);
    // Counts its live-count calls, so that the first reads before.txt and the second after.txt.
    stub(
      "psql",
      `sql="$(cat)"
       if [[ "$sql" == *gexec* ]]; then
         if [[ -f "${root}/counted" ]]; then cat "${root}/after.txt"
         else touch "${root}/counted"; cat "${root}/before.txt"; fi
       elif [[ "$sql" == *schema_migrations* ]]; then
         file="${root}/migrations-before.txt"
         if [[ -f "${root}/counted" ]]; then file="${root}/migrations-after.txt"; fi
         if [[ "$(cat "$file")" == fail ]]; then
           echo 'ERROR:  permission denied for schema supabase_migrations' >&2; exit 3
         fi
         cat "$file"
       else
         cat "${root}/role.txt"
       fi`,
    );
    stub(
      "age",
      `echo "$*" >"${root}/age-args"
       out=""
       while (($# > 0)); do
         if [[ "$1" == "-o" ]]; then out="$2"; shift; fi
         shift
       done
       ${scenario.ageWritesPlain === true ? 'cat >"$out"' : `{ echo "age-encryption.org/v1"; cat | tr 'a-z' 'n-za-m'; } >"$out"`}
       ${scenario.archiveBytes === undefined ? "" : `dd if=/dev/null of="$out" bs=1 seek=${String(scenario.archiveBytes)} 2>/dev/null`}`,
    );
  }

  function runBackup(env: Record<string, string> = {}) {
    return spawnSync("bash", [RUN_BACKUP], {
      cwd,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        PGHOST: "pooler.example.test",
        PGUSER: "backup_ro.placeholder",
        PGPASSWORD: CANARY_PASSWORD,
        PGDATABASE: "postgres",
        PGSSLMODE: "verify-full",
        PGSSLROOTCERT: join(root, "ca"),
        AGE_RECIPIENT_1: RECIPIENT_1,
        AGE_RECIPIENT_2: RECIPIENT_2,
        ...env,
      },
    });
  }

  function backupFiles(): string[] {
    const dir = join(cwd, "backups");
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { recursive: true, encoding: "utf8" });
  }

  function writePrevious(tables: Record<string, number>): void {
    mkdirSync(join(cwd, "backups"), { recursive: true });
    const lines = Object.entries(tables)
      .map(([name, rows]) => `table ${name} ${String(rows)}\n`)
      .join("");
    writeFileSync(
      join(cwd, "backups", "latest.manifest.txt"),
      `created_at old\n${lines}`,
    );
  }

  it("writes an encrypted file and a manifest for a healthy run", () => {
    installStubs({});
    const result = runBackup();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const manifest = readFileSync(
      join(cwd, "backups", "latest.manifest.txt"),
      "utf8",
    );
    expect(manifest).toContain("table public.events 30\n");
    expect(manifest).toContain("table history.row_versions 40\n");
    expect(manifest).toMatch(/^archive_sha256 [0-9a-f]{64}$/m);
    expect(manifest).toContain(`recipient ${RECIPIENT_1}\n`);
    expect(backupFiles().filter((f) => f.endsWith(".data.age"))).toHaveLength(
      1,
    );
  });

  it("records the applied migrations in the manifest", () => {
    installStubs({});
    expect(runBackup().status).toBe(0);
    const manifest = readFileSync(
      join(cwd, "backups", "latest.manifest.txt"),
      "utf8",
    );
    expect(manifest.match(/^migration .*$/gm)).toEqual([
      "migration 20261104000001",
      "migration 20261104000002",
    ]);
  });

  it("passes the flags the role and the design depend on, and both recipients", () => {
    installStubs({});
    runBackup();
    const dumpArgs = readFileSync(join(root, "pg_dump-args"), "utf8");
    expect(dumpArgs).toContain("--enable-row-security");
    expect(dumpArgs).toContain("--schema=public");
    expect(dumpArgs).toContain("--schema=history");
    expect(dumpArgs).toContain("--format=custom");
    expect(dumpArgs).not.toMatch(/postgres(ql)?:/);
    const ageArgs = readFileSync(join(root, "age-args"), "utf8");
    expect(ageArgs).toContain(`-r ${RECIPIENT_1} -r ${RECIPIENT_2}`);
  });

  describe("with an optional third recipient, for a handoff", () => {
    const RECIPIENT_3 = `age1${"z".repeat(58)}`;

    it("passes it to age and lists it in the manifest", () => {
      installStubs({});
      const result = runBackup({ AGE_RECIPIENT_3: RECIPIENT_3 });
      expect(result.status).toBe(0);
      expect(readFileSync(join(root, "age-args"), "utf8")).toContain(
        `-r ${RECIPIENT_1} -r ${RECIPIENT_2} -r ${RECIPIENT_3}`,
      );
      expect(
        readFileSync(join(cwd, "backups", "latest.manifest.txt"), "utf8"),
      ).toContain(`recipient ${RECIPIENT_3}\n`);
    });

    it("leaves it out when empty", () => {
      installStubs({});
      expect(runBackup({ AGE_RECIPIENT_3: "" }).status).toBe(0);
      const manifest = readFileSync(
        join(cwd, "backups", "latest.manifest.txt"),
        "utf8",
      );
      expect(manifest.match(/^recipient /gm)).toHaveLength(2);
    });

    it.each([
      ["something that is not a key", "REPLACE_WITH_KEY"],
      ["a repeat of the first", RECIPIENT_1],
      ["a repeat of the second", RECIPIENT_2],
    ])("refuses %s", (_name, value) => {
      installStubs({});
      const result = runBackup({ AGE_RECIPIENT_3: value });
      expect(result.status).toBe(1);
      expect(existsSync(join(root, "pg_dump-args"))).toBe(false);
    });
  });

  it("keeps the recovery's role statements the same as the migration's", () => {
    const words = (text: string) => text.replace(/\s+/g, " ");
    const script = words(
      readFileSync(join(BACKUP_DIR, "create-backup-role.psql"), "utf8"),
    );
    const migration = words(
      readFileSync(
        join(
          import.meta.dirname,
          "..",
          "supabase",
          "migrations",
          "20261104000009_backup_role.sql",
        ),
        "utf8",
      ),
    );
    for (const pattern of [
      /CREATE ROLE backup_ro [^;]+;/,
      /ALTER ROLE backup_ro SET [^;]+;/,
    ]) {
      const statement = pattern.exec(script)?.[0];
      expect(statement).toBeDefined();
      expect(migration).toContain(statement);
    }
  });

  it("prints neither the password nor row text", () => {
    installStubs({});
    const result = runBackup();
    const output = result.stdout + result.stderr;
    expect(output).not.toContain(CANARY_PASSWORD);
    expect(output).not.toContain(PLAINTEXT_ROW);
  });

  it("leaves no plaintext where the commit would pick it up", () => {
    installStubs({});
    runBackup();
    for (const file of backupFiles()) {
      const path = join(cwd, "backups", file);
      if (!file.endsWith(".age") && !file.endsWith(".txt")) continue;
      expect(readFileSync(path, "utf8")).not.toContain(PLAINTEXT_ROW);
    }
  });

  it.each<[string, Scenario, RegExp]>([
    [
      "a table with fewer rows than the live count",
      {
        dumped: GOOD_TABLES,
        liveBefore: { ...GOOD_TABLES, "public.events": 31 },
        liveAfter: { ...GOOD_TABLES, "public.events": 31 },
      },
      /public\.events holds 30 rows in the dump, but the live count was 31 to 31/,
    ],
    [
      "a table with more rows than the live count",
      {
        dumped: { ...GOOD_TABLES, "public.events": 99 },
        liveBefore: GOOD_TABLES,
        liveAfter: GOOD_TABLES,
      },
      /row counts do not match/,
    ],
    [
      "an empty dump",
      {
        dumped: { "public.events": 0, "public.guild_config": 0 },
      },
      /holds no rows/,
    ],
    [
      "a dump with no guild configuration",
      {
        dumped: { "public.events": 3, "public.guild_config": 0 },
      },
      /no guild_config rows/,
    ],
    [
      "a table missing from the dump",
      {
        dumped: { "public.events": 30, "public.guild_config": 1 },
        liveBefore: GOOD_TABLES,
        liveAfter: GOOD_TABLES,
      },
      /tables differ/,
    ],
    [
      "a failing pg_dump",
      { pgDumpFails: true },
      /dump or its encryption failed/,
    ],
    [
      "an output that is not encrypted",
      { ageWritesPlain: true },
      /not an age file/,
    ],
    [
      "an encrypted file over the size limit",
      { archiveBytes: MAX_ARCHIVE_BYTES + 1 },
      /the encrypted file is 99614721 bytes, over the limit/,
    ],
    [
      "applied migrations it cannot read",
      { migrations: "fail" },
      /could not read the applied migrations/,
    ],
    [
      "no applied migrations",
      { migrations: "" },
      /records no applied migrations/,
    ],
    [
      "a migration version that is not a number",
      { migrations: "20261104000001\ntable public.events 1\n" },
      /unexpected output from the applied migrations/,
    ],
    [
      "a migration applied during the dump",
      { migrationsAfter: `${MIGRATIONS}20261104000003\n` },
      /a migration was applied during the dump/,
    ],
    ["a client older than 17.6", { pgVersion: "17.5" }, /too old/],
    ["the wrong role", { role: "postgres f 0 0 0 0 4\n" }, /wrong role/],
    [
      "a role with an elevated attribute",
      { role: "backup_ro t 0 0 0 0 4\n" },
      /elevated attribute/,
    ],
    [
      "a role that belongs to another role",
      { role: "backup_ro f 1 0 0 0 4\n" },
      /member of another role/,
    ],
    [
      "a role that can change a table",
      { role: "backup_ro f 0 2 0 0 4\n" },
      /can change 2 tables/,
    ],
    [
      "a role missing a table's grant",
      { role: "backup_ro f 0 0 1 0 4\n" },
      /cannot read 1 tables/,
    ],
    [
      "a role that row level security would hide rows from",
      { role: "backup_ro f 0 0 0 3 4\n" },
      /hides 3 tables/,
    ],
  ])("fails on %s, and writes no backup", (_name, scenario, message) => {
    installStubs(scenario);
    const result = runBackup();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(message);
    expect(result.stderr).not.toContain(CANARY_PASSWORD);
    expect(backupFiles()).toEqual([]);
  });

  it("accepts an encrypted file exactly at the size limit", () => {
    installStubs({ archiveBytes: MAX_ARCHIVE_BYTES });
    const result = runBackup();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("does not fail a large dump when the row counter stops reading early", () => {
    installStubs({});
    stub(
      "pg_dump",
      `if [[ "$1" == "--version" ]]; then echo "pg_dump (PostgreSQL) 17.11"; exit 0; fi
       head -c 1000000 /dev/zero`,
    );
    stub("pg_restore", `head -c 1 >/dev/null; cat "${root}/copy.txt"`);
    const result = runBackup();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("accepts rows written during the dump", () => {
    installStubs({
      dumped: { ...GOOD_TABLES, "public.events": 31 },
      liveBefore: GOOD_TABLES,
      liveAfter: { ...GOOD_TABLES, "public.events": 32 },
    });
    expect(runBackup().status).toBe(0);
  });

  it.each<[string, Record<string, string>]>([
    ["a missing password", { PGPASSWORD: "" }],
    ["a weaker TLS mode", { PGSSLMODE: "require" }],
    ["the placeholder recipient", { AGE_RECIPIENT_1: "REPLACE_WITH_KEY" }],
    ["the same recipient twice", { AGE_RECIPIENT_2: RECIPIENT_1 }],
    ["a CA file that is not there", { PGSSLROOTCERT: "/nonexistent/ca" }],
  ])("refuses %s before connecting", (_name, env) => {
    installStubs({});
    const result = runBackup(env);
    expect(result.status).toBe(1);
    expect(existsSync(join(root, "pg_dump-args"))).toBe(false);
    expect(backupFiles()).toEqual([]);
  });

  it("does not quote a private key given as a recipient", () => {
    installStubs({});
    const key = "AGE-SECRET-" + "KEY-1CANARY";
    const result = runBackup({ AGE_RECIPIENT_1: key });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain(key);
  });

  it("refuses to run with shell tracing on", () => {
    installStubs({});
    const result = spawnSync("bash", ["-x", RUN_BACKUP], {
      cwd,
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("shell tracing");
  });

  describe("against the previous backup", () => {
    it("fails on a large drop and keeps the old manifest", () => {
      installStubs({});
      writePrevious({ ...GOOD_TABLES, "public.events": 100 });
      const result = runBackup();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("public.events fell from 100 rows to 30");
      expect(
        readFileSync(join(cwd, "backups", "latest.manifest.txt"), "utf8"),
      ).toContain("created_at old");
    });

    it("passes a drop within the limit", () => {
      installStubs({});
      writePrevious({ ...GOOD_TABLES, "public.events": 37 });
      expect(runBackup().status).toBe(0);
    });

    it("applies the percentage from 5 rows", () => {
      installStubs({ dumped: { ...GOOD_TABLES, "public.events": 3 } });
      writePrevious({ ...GOOD_TABLES, "public.events": 5 });
      const result = runBackup();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("fell from 5 rows to 3");
    });

    it("below 5 rows, fails only on a fall to zero", () => {
      installStubs({ dumped: { ...GOOD_TABLES, "public.events": 1 } });
      writePrevious({ ...GOOD_TABLES, "public.events": 4 });
      expect(runBackup().status).toBe(0);
    });

    it("passes an overwrite that keeps the row count, the limit the guide states", () => {
      installStubs({});
      writePrevious(GOOD_TABLES);
      expect(runBackup().status).toBe(0);
    });

    it("fails when a small table empties", () => {
      installStubs({
        dumped: { ...GOOD_TABLES, "public.events": 0 },
      });
      writePrevious({ ...GOOD_TABLES, "public.events": 2 });
      const result = runBackup();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("fell from 2 rows to none");
    });

    it("fails when a table disappears", () => {
      installStubs({});
      writePrevious({ ...GOOD_TABLES, "public.tasks": 5 });
      const result = runBackup();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("public.tasks was in the last backup");
    });

    it("ignores falls in the table whose rows expire", () => {
      installStubs({});
      writePrevious({ ...GOOD_TABLES, "public.interaction_claims": 5000 });
      expect(runBackup().status).toBe(0);
    });

    it("accepts a drop on a manual run with a reason, and records it", () => {
      installStubs({});
      writePrevious({ ...GOOD_TABLES, "public.events": 100 });
      const result = runBackup({
        GITHUB_EVENT_NAME: "workflow_dispatch",
        ACCEPT_DROP_REASON: "retention job ran",
      });
      expect(result.status).toBe(0);
      expect(
        readFileSync(join(cwd, "backups", "latest.manifest.txt"), "utf8"),
      ).toContain("accepted_drop retention job ran\n");
    });

    it("never accepts a drop on a scheduled run", () => {
      installStubs({});
      writePrevious({ ...GOOD_TABLES, "public.events": 100 });
      const result = runBackup({
        GITHUB_EVENT_NAME: "schedule",
        ACCEPT_DROP_REASON: "retention job ran",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("only on a manual run");
    });

    it("refuses a reason that could inject into the log", () => {
      installStubs({});
      const result = runBackup({
        GITHUB_EVENT_NAME: "workflow_dispatch",
        ACCEPT_DROP_REASON: "x\n::error::forged",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("plain characters");
    });
  });

  describe("row summary", () => {
    function summarise(text: string) {
      return spawnSync("awk", ["-f", SUMMARY], {
        input: text,
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
      });
    }

    it("counts rows per table, including empty ones, around psql directives", () => {
      const result = summarise(copyText({ "public.a": 2, "history.b": 0 }));
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("public.a 2\nhistory.b 0\n");
    });

    it("cannot be fooled by row text that looks like a header or an escaped terminator", () => {
      const text =
        "COPY public.a (id) FROM stdin;\n" +
        "COPY public.forged (id) FROM stdin;\n" +
        "\\\\.\n" +
        "\\.\n";
      expect(summarise(text).stdout).toBe("public.a 2\n");
    });

    it("keeps quoted table names intact", () => {
      const text = 'COPY public."Odd" (id) FROM stdin;\n1\n\\.\n';
      expect(summarise(text).stdout).toBe('public."Odd" 1\n');
    });

    it("fails on data cut off before its terminator", () => {
      const result = summarise("COPY public.a (id) FROM stdin;\n1\n");
      expect(result.status).toBe(1);
    });
  });

  describe("reminder freshness", () => {
    function runFreshness(output: string, env: Record<string, string> = {}) {
      stub("psql", `cat >/dev/null; echo "${output}"`);
      return spawnSync("bash", [FRESHNESS], {
        encoding: "utf8",
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          PGSSLMODE: "verify-full",
          ...env,
        },
      });
    }

    it.each(["3600", "108000"])("passes %s seconds after a success", (age) => {
      expect(runFreshness(age).status).toBe(0);
    });

    it.each([
      ["no successful run", "", "never succeeded"],
      ["a success past 30 hours", "108001", "last succeeded 30 hours ago"],
      ["unexpected output", "x", "unexpected output"],
      ["a success dated in the future", "-30678345015", "dated in the future"],
      ["a success one second ahead", "-1", "dated in the future"],
    ])("fails on %s", (_name, output, message) => {
      const result = runFreshness(output);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
    });

    it("refuses a weaker TLS mode", () => {
      const result = runFreshness("1", { PGSSLMODE: "require" });
      expect(result.status).toBe(1);
    });

    it("reads the latest successful reminders row's start time", () => {
      const script = readFileSync(FRESHNESS, "utf8");
      expect(script).toContain("now() - started_at");
      expect(script).toContain(
        "WHERE job_name = 'reminders' AND status = 'succeeded'",
      );
      expect(script).toContain("ORDER BY started_at DESC");
    });

    it("reads no column that may hold error text", () => {
      const script = readFileSync(FRESHNESS, "utf8");
      expect(script).not.toMatch(/SELECT[^;]*\berror\b/i);
      expect(script).not.toMatch(/SELECT[^;]*\bresults\b/i);
    });
  });

  describe("workflow template", () => {
    const template = readFileSync(TEMPLATE, "utf8");
    const code = template
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");

    it("runs daily and by hand, with write access only where it commits", () => {
      expect(code).toMatch(/schedule:\n\s+- cron: "\d+ \d+ \* \* \*"/);
      expect(code).toContain("workflow_dispatch:");
      expect(code).toMatch(/^permissions:\n {2}contents: read$/m);
      expect(code).toMatch(/permissions:\n\s+contents: write/);
    });

    it("pins every action to a full commit", () => {
      const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1] ?? "");
      expect(uses.length).toBeGreaterThan(0);
      for (const action of uses) {
        expect(action).toMatch(/@[0-9a-f]{40}$/);
      }
    });

    it("keeps the checkout's token out of .git/config", () => {
      expect(code).toContain("persist-credentials: false");
    });

    it("avoids everything that could put plaintext or secrets in a log or artifact", () => {
      expect(code).not.toMatch(/set -[a-z]*x|xtrace/);
      expect(code).not.toMatch(/upload-artifact|actions\/cache|cache:/);
      expect(code).not.toMatch(/postgres(ql)?:\/\//);
      expect(code).not.toMatch(/pull_request|workflow_run/);
      expect(code).not.toContain("AGE-SECRET-KEY");
      expect(code).not.toContain("DATABASE_URL");
    });

    it("requires verified TLS on every database step", () => {
      expect(code.match(/PGSSLMODE: verify-full/g)).toHaveLength(2);
      expect(code.match(/PGPASSWORD:/g)).toHaveLength(2);
      expect(code).not.toMatch(/sslmode=(?!verify-full)/);
    });

    it("gives the commit step the token and no database secret", () => {
      const start = code.indexOf("- name: Commit the encrypted backup");
      const end = code.indexOf("- name: Check that reminders");
      const step = code.slice(start, end);
      expect(step).toContain("github.token");
      expect(step).not.toContain("secrets.");
    });

    it("pins a patched client and checks both downloads against pinned hashes", () => {
      const version = /PG_CLIENT_VERSION: 17\.(\d+)-/.exec(code);
      expect(Number(version?.[1])).toBeGreaterThanOrEqual(6);
      expect(code).toMatch(/AGE_LINUX_AMD64_SHA256: [0-9a-f]{64}/);
      expect(code).toMatch(/PGDG_SIGNER_SHA512: [0-9a-f]{128}/);
      expect(code.match(/sha(256|512)sum --check --strict/g)).toHaveLength(2);
    });

    it("ships with placeholders, so it cannot run until real keys are set", () => {
      expect(code).toMatch(/AGE_RECIPIENT_1: REPLACE_WITH/);
      expect(code).toMatch(/AGE_RECIPIENT_2: REPLACE_WITH/);
      expect(code).toMatch(/AGE_RECIPIENT_3: ""/);
    });

    it("can still install a pinned client once it moves to the archive", () => {
      expect(code).toContain(
        "apt.postgresql.org/pub/repos/apt noble-pgdg main",
      );
      expect(code).toContain(
        "apt-archive.postgresql.org/pub/repos/apt noble-pgdg-archive main",
      );
    });

    it("reports reminder staleness after committing, even if the backup failed", () => {
      expect(code.indexOf("Commit the encrypted backup")).toBeLessThan(
        code.indexOf("Check that reminders"),
      );
      expect(code).toMatch(
        /Check that reminders are still running\n\s+if: \$\{\{ always\(\)/,
      );
    });
  });
});
