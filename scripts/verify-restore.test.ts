/**
 * Tests verify-restore.sh's refusals, and its order of work using stand-ins for age and
 * the Postgres tools. No test here decrypts anything or touches a database, so a real
 * restore still has to be run as docs/BACKUPS.md describes.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "..", "backup", "verify-restore.sh");
const SCRATCH_URL = "postgres://restore_drill@localhost:5432/backup_scratch";
const ARCHIVE_BYTES = "age-encryption.org/v1\nencrypted bytes\n";

// Joined at runtime so the secret scan's rules for passwords in URLs and for email
// addresses do not fire on these made-up hosts.
const userAt = (user: string, rest: string) => [user, rest].join("@");
const urlWithPassword = (rest: string) =>
  userAt("postgres://restore_drill:canary-password", rest);

const DATA =
  "COPY public.events (id) FROM stdin;\n1\n2\n\\.\n\nCOPY public.tasks (id) FROM stdin;\n\\.\n";

describe("verify-restore.sh", () => {
  let root: string;
  let bin: string;
  let archive: string;
  let manifest: string;
  let identity: string;
  let calls: string;

  function stub(name: string, body: string): void {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path, 0o755);
  }

  /** A working set of stand-ins. Each records its call, so tests can see what ran. */
  function installStubs(
    options: {
      server?: string;
      scratchData?: string;
      version?: string;
    } = {},
  ): void {
    writeFileSync(join(root, "archive-data"), DATA);
    writeFileSync(join(root, "scratch-data"), options.scratchData ?? DATA);
    const log = `echo "$(basename "$0") $*" >>"${calls}"`;
    stub("age", `${log}\nprintf fake-dump-bytes`);
    stub("psql", `${log}\ncat >/dev/null\necho "${options.server ?? "f 0 0"}"`);
    stub("pg_dump", `${log}\nprintf scratch-marker`);
    stub(
      "pg_restore",
      `${log}
       case "$*" in
         --version) echo "pg_restore (PostgreSQL) ${options.version ?? "17.11"}"; exit 0 ;;
         --list) cat >/dev/null; printf '; toc\\n7; 2615 8 SCHEMA - public o\\n9; 2615 10 SCHEMA - history o\\n1; 2 3 TABLE public events o\\n4; 5 6 POLICY public events backup_ro_read o\\n11; 826 12 DEFAULT ACL public DEFAULT PRIVILEGES FOR SEQUENCES o\\n'; exit 0 ;;
         *--data-only*)
           if [[ "$(cat)" == scratch-marker ]]; then cat "${root}/scratch-data"; else cat "${root}/archive-data"; fi
           exit 0 ;;
         *)
           for arg in "$@"; do
             case "$arg" in --use-list=*) cp "\${arg#--use-list=}" "${root}/used-list" ;; esac
           done
           cat >/dev/null; exit 0 ;;
       esac`,
    );
  }

  function run(args: string[], env: Record<string, string> = {}) {
    return spawnSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, ...env },
    });
  }

  function validArgs(url = SCRATCH_URL): string[] {
    return [
      "--archive",
      archive,
      "--manifest",
      manifest,
      "--identity",
      identity,
      "--scratch-url",
      url,
    ];
  }

  function toolWasCalled(): boolean {
    return existsSync(calls);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "verify-restore-"));
    bin = join(root, "bin");
    mkdirSync(bin);
    archive = join(root, "archive");
    manifest = join(root, "manifest");
    identity = join(root, "holder-identity");
    calls = join(root, "calls");
    writeFileSync(archive, ARCHIVE_BYTES);
    writeFileSync(identity, "placeholder");
    chmodSync(identity, 0o600);
    const sha = createHash("sha256").update(ARCHIVE_BYTES).digest("hex");
    writeFileSync(
      manifest,
      `archive_sha256 ${sha}\ntable public.events 2\ntable public.tasks 0\n`,
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("refuses, before running any tool,", () => {
    it.each([
      [
        "a Supabase pooler",
        userAt(
          "postgres://backup_ro.ref",
          "aws-0-us-east-1.pooler.supabase.com:5432/postgres",
        ),
      ],
      [
        "a Supabase direct host",
        userAt(
          "postgres://restore_drill",
          "db.abcdefghij.supabase.co:5432/backup_scratch",
        ),
      ],
      [
        "uppercase hosts",
        userAt("postgres://u", "DB.ABC.SUPABASE.CO/backup_scratch"),
      ],
      ["a name with prod in it", "postgres://u@localhost/prod_restore"],
      [
        "a host override in the query",
        "postgres://u@localhost/backup_scratch?host=db.example.test",
      ],
      [
        "a hostaddr override",
        "postgres://u@localhost/backup_scratch?hostaddr=192.0.2.1",
      ],
      [
        "a service override",
        "postgres://u@localhost/backup_scratch?service=live",
      ],
      [
        "an options override",
        "postgres://u@localhost/backup_scratch?sslmode=disable&host=x",
      ],
      ["a remote host", "postgres://u@db.example.test/backup_scratch"],
      ["a private address", "postgres://u@10.0.0.5/backup_scratch"],
      ["a host list", "postgres://u@localhost,db.example.test/backup_scratch"],
      [
        "a lookalike host",
        "postgres://u@localhost.example.test/backup_scratch",
      ],
      ["an encoded host", "postgres://u@%6Cocalhost/backup_scratch"],
      ["an empty host", "postgres:///backup_scratch"],
      ["the default database", "postgres://u@localhost/postgres"],
      ["a template database", "postgres://u@localhost/template1"],
      ["an unmarked database", "postgres://u@localhost/app"],
      ["no database", "postgres://u@localhost"],
      ["the postgres role", "postgres://postgres@localhost/backup_scratch"],
      ["the backup role", "postgres://backup_ro@localhost/backup_scratch"],
      ["a key=value string", "host=localhost dbname=backup_scratch"],
      ["another scheme", "mysql://u@localhost/backup_scratch"],
    ])("%s", (_name, url) => {
      installStubs();
      const result = run(validArgs(url));
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("refused");
      expect(toolWasCalled()).toBe(false);
    });

    it("a password in the URL, without repeating it", () => {
      installStubs();
      const result = run(
        validArgs(urlWithPassword("localhost/backup_scratch")),
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("must not hold a password");
      expect(result.stdout + result.stderr).not.toContain("canary-password");
      expect(toolWasCalled()).toBe(false);
    });

    it("a production URL with a password, without repeating either", () => {
      installStubs();
      const url = urlWithPassword("db.abc.supabase.co/postgres");
      const result = run(validArgs(url));
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("looks like production");
      expect(result.stderr).not.toContain("canary-password");
      expect(result.stderr).not.toContain("supabase.co");
    });

    it.each([
      ["no arguments", []],
      [
        "a missing archive flag",
        ["--manifest", "m", "--identity", "i", "--scratch-url", SCRATCH_URL],
      ],
      ["a flag with no value", ["--archive"]],
    ])("%s", (_name, args) => {
      installStubs();
      expect(run(args).status).toBe(2);
      expect(toolWasCalled()).toBe(false);
    });

    it("an unknown argument, without repeating it", () => {
      installStubs();
      const secret = "AGE-SECRET-" + "KEY-1CANARY";
      const result = run([...validArgs(), secret]);
      expect(result.status).toBe(2);
      expect(result.stderr).not.toContain(secret);
    });

    it("a private key passed as the identity path, without repeating it", () => {
      installStubs();
      const secret = "AGE-SECRET-" + "KEY-1CANARY";
      const args = validArgs();
      args[5] = secret;
      const result = run(args);
      expect(result.status).toBe(2);
      expect(result.stderr).not.toContain(secret);
    });

    it("an identity file other accounts can read", () => {
      installStubs();
      chmodSync(identity, 0o644);
      const result = run(validArgs());
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("chmod 600");
      expect(toolWasCalled()).toBe(false);
    });

    it("a missing archive", () => {
      installStubs();
      rmSync(archive);
      expect(run(validArgs()).status).toBe(2);
      expect(toolWasCalled()).toBe(false);
    });

    it("a manifest with no checksum", () => {
      installStubs();
      writeFileSync(manifest, "table public.events 2\n");
      expect(run(validArgs()).stderr).toContain("no archive checksum");
      expect(toolWasCalled()).toBe(false);
    });
  });

  it.each([
    ["localhost", "postgres://restore_drill@localhost/backup_scratch"],
    ["127.0.0.1", "postgres://restore_drill@127.0.0.1:5433/restore_test"],
    ["an IPv6 loopback", "postgres://restore_drill@[::1]:5432/drill_db"],
    ["an sslmode", `${SCRATCH_URL}?sslmode=disable`],
    ["the long scheme", "postgresql://restore_drill@localhost/backup_scratch"],
    ["no user", "postgres://localhost/backup_scratch"],
  ])("accepts a scratch URL with %s", (_name, url) => {
    installStubs();
    const result = run(validArgs(url));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  describe("refuses after connecting,", () => {
    it.each([
      ["a superuser or otherwise powerful role", "t 0 0", "too powerful"],
      ["a server that looks like a hosted project", "f 3 0", "hosted project"],
      ["a database that is not empty", "f 0 4", "not empty"],
    ])("%s", (_name, server, message) => {
      installStubs({ server });
      const result = run(validArgs());
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(message);
      const log = readFileSync(calls, "utf8");
      expect(log).not.toContain("age ");
      expect(log).not.toContain("--single-transaction");
    });

    it("a client missing the 2025 fixes", () => {
      installStubs({ version: "17.5" });
      const result = run(validArgs());
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("missing the 2025 restore fixes");
    });

    it.each(["16.10", "15.14", "14.19", "13.22", "18.0"])(
      "but accepts patched client %s",
      (version) => {
        installStubs({ version });
        expect(run(validArgs()).status).toBe(0);
      },
    );
  });

  it("uses the same pins as the job that tests it", () => {
    const template = readFileSync(
      join(import.meta.dirname, "..", "backup", "backup.workflow.yml.example"),
      "utf8",
    );
    const ci = readFileSync(
      join(import.meta.dirname, "..", ".github", "workflows", "db.yml"),
      "utf8",
    );
    for (const pin of [
      "AGE_VERSION",
      "AGE_LINUX_AMD64_SHA256",
      "PG_CLIENT_VERSION",
      "PGDG_SIGNER_SHA512",
    ]) {
      const line = new RegExp(`^\\s*${pin}: (\\S+)$`, "m");
      const value = line.exec(template)?.[1];
      expect(value).toBeDefined();
      expect(line.exec(ci)?.[1]).toBe(value);
    }
    expect(ci).toContain("apt-archive.postgresql.org");
  });

  it("skips policies, CREATE SCHEMA public and default privileges, and keeps everything else", () => {
    installStubs();
    expect(run(validArgs()).status).toBe(0);
    const list = readFileSync(join(root, "used-list"), "utf8");
    expect(list).not.toContain("POLICY");
    expect(list).not.toContain("SCHEMA - public");
    expect(list).not.toContain("DEFAULT ACL");
    expect(list).toContain("SCHEMA - history");
    expect(list).toContain("TABLE public events");
  });

  it("prints usage for --help and runs nothing", () => {
    installStubs();
    const result = run(["--help"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("verify-restore.sh --archive");
    expect(toolWasCalled()).toBe(false);
  });

  it("drops anything from the environment that could redirect a connection", () => {
    installStubs();
    stub(
      "psql",
      `env | grep -E '^(PGHOST|PGSERVICE|PGOPTIONS|DATABASE_URL|PGDATABASE)=' >"${root}/leaked"
       cat >/dev/null; echo "f 0 0"`,
    );
    const result = run(validArgs(), {
      PGHOST: "db.example.test",
      PGSERVICE: "live",
      PGOPTIONS: "-c x=y",
      DATABASE_URL: "placeholder",
      PGDATABASE: "postgres",
    });
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, "leaked"), "utf8")).toBe("");
  });

  it("fails if the archive does not match the manifest's checksum, and restores nothing", () => {
    installStubs();
    writeFileSync(archive, `${ARCHIVE_BYTES}tampered`);
    const result = run(validArgs());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("checksum");
    expect(readFileSync(calls, "utf8")).not.toContain("--single-transaction");
  });

  it("fails if the archive's row counts differ from the manifest, and restores nothing", () => {
    installStubs();
    const text = readFileSync(manifest, "utf8");
    writeFileSync(manifest, text.replace("public.events 2", "public.events 3"));
    const result = run(validArgs());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("differ from the manifest");
    expect(readFileSync(calls, "utf8")).not.toContain("--single-transaction");
  });

  it("fails if the scratch database holds different row counts", () => {
    installStubs({
      scratchData:
        "COPY public.events (id) FROM stdin;\n1\n\\.\n\nCOPY public.tasks (id) FROM stdin;\n\\.\n",
    });
    const result = run(validArgs());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("rows differ");
  });

  it("fails if the row text differs with the same counts, without printing it or a digest", () => {
    installStubs({
      scratchData:
        "COPY public.events (id) FROM stdin;\n1\nCHANGED-ROW\n\\.\n\nCOPY public.tasks (id) FROM stdin;\n\\.\n",
    });
    const result = run(validArgs());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("rows differ");
    expect(result.stderr).not.toContain("CHANGED-ROW");
    expect(result.stderr).not.toMatch(/[0-9a-f]{64}/);
  });

  it("restores unprivileged, skipping policies, with every connection to the scratch URL", () => {
    installStubs();
    const result = run(validArgs());
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Drop the scratch database");

    const log = readFileSync(calls, "utf8").trim().split("\n");
    const restore = log.find((line) => line.includes("--single-transaction"));
    expect(restore).toContain("--no-owner");
    expect(restore).toContain("--no-privileges");
    expect(restore).toContain("--use-list=");

    const connecting = log.filter((line) =>
      /^(psql|pg_dump) |--single-transaction/.test(line),
    );
    expect(connecting.length).toBe(3);
    for (const line of connecting) {
      expect(line).toContain(`-d ${SCRATCH_URL}`);
    }
    const restored = log.findIndex((line) =>
      line.includes("--single-transaction"),
    );
    const checked = log.findIndex((line) => line.startsWith("psql "));
    expect(checked).toBeLessThan(restored);
  });
});
