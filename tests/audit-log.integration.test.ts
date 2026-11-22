import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

/**
 * What the audit page and the points ledger promise, on a real Postgres:
 * every audited mutation leaves exactly its row, the row is written in the
 * change's own transaction (it rolls back with it, and a failed change leaves
 * none), and the ledger always agrees with the totals the screens read.
 */
let session: unknown = null;
mock.module("../packages/auth/src/index.ts", () => ({
  auth: () => Promise.resolve(session),
  handlers: {},
  signIn: () => Promise.resolve(undefined),
  signOut: () => Promise.resolve(undefined),
}));

const {
  auditLog,
  committeeApplications,
  db,
  eventCheckIns,
  events,
  kinGroups,
  kinMemberships,
  mentorshipEnrollments,
  pointsLedger,
  resumes,
  users,
} = await import("../packages/db/src/index");
const { createCaller } = await import("../packages/api/src/root");
const { schoolYear, semester } = await import("../packages/api/src/terms");
const { and, asc, eq, inArray, isNull, sum } =
  await import("../packages/db/node_modules/drizzle-orm/index.js");
const resumeRoute =
  await import("../sites/web/src/app/api/portal/admin/members/[id]/resume/route");

const SLOW = 60_000;
const EVENT_SOURCES = ["check_in", "manual_check_in", "check_in_removed"];

type Role = "MEMBER" | "ADMIN" | "SUPER_ADMIN";
type TestUser = { id: string; email: string; role: Role };

function callerFor(user: TestUser, database: typeof db = db) {
  return createCaller({
    db: database,
    session: {
      user: { id: user.id, role: user.role, email: user.email, name: user.id },
      expires: new Date(Date.now() + 86_400_000).toISOString(),
    },
    headers: new Headers(),
  });
}

/**
 * A database handle whose transactions refuse one table, so the change under
 * test has already run when its own audit or ledger row fails to write.
 */
function refusingInserts(table: unknown): typeof db {
  const guard = (tx: object) =>
    new Proxy(tx, {
      get(target, property, receiver) {
        if (property === "insert") {
          return (into: unknown) => {
            if (into === table) throw new Error("insert refused for the test");
            return (target as typeof db).insert(into as never);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "transaction") {
        return (run: (tx: object) => Promise<unknown>) =>
          target.transaction((tx) => run(guard(tx)));
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

describe.skipIf(!process.env.DATABASE_URL)(
  "audit log and points ledger",
  () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const userIds: string[] = [];
    const eventIds: string[] = [];
    const groupIds: string[] = [];
    const applicationCycle = "fall-2026";
    let seq = 0;

    let officer: TestUser;
    let boss: TestUser;

    async function makeUser(label: string, role: Role) {
      const id = `aud-${label}-${suffix}`;
      const email = `${id}@vitest.local`;
      await db.insert(users).values({ id, email, role, name: `Name ${label}` });
      userIds.push(id);
      return { id, email, role } satisfies TestUser;
    }

    async function makeEvent(label: string, pointsValue = 10) {
      seq += 1;
      const [row] = await db
        .insert(events)
        .values({
          title: `aud ${label} ${suffix}`,
          // Now, so the code path's check-in window is open too.
          startsAt: new Date(),
          pointsValue,
          checkInCode:
            `${suffix.slice(0, 6)}${String(seq).padStart(2, "0")}`.toUpperCase(),
          createdById: officer.id,
        })
        .returning({ id: events.id, checkInCode: events.checkInCode });
      eventIds.push(row!.id);
      return row!;
    }

    const auditBy = (actorId: string, action: string) =>
      db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.actorId, actorId),
            eq(auditLog.action, action as never),
          ),
        )
        .orderBy(asc(auditLog.at));

    const ledgerFor = (userId: string) =>
      db
        .select()
        .from(pointsLedger)
        .where(eq(pointsLedger.userId, userId))
        .orderBy(asc(pointsLedger.at), asc(pointsLedger.id));

    async function checkInsOf(userId: string, eventId: string) {
      return db
        .select({ id: eventCheckIns.id })
        .from(eventCheckIns)
        .where(
          and(
            eq(eventCheckIns.userId, userId),
            eq(eventCheckIns.eventId, eventId),
          ),
        );
    }

    /** Attendance points that still count, from the ledger. */
    async function ledgerLivePoints(userId: string) {
      const [row] = await db
        .select({ total: sum(pointsLedger.delta) })
        .from(pointsLedger)
        .innerJoin(events, eq(events.id, pointsLedger.eventId))
        .where(
          and(
            eq(pointsLedger.userId, userId),
            isNull(events.archivedAt),
            inArray(pointsLedger.source, EVENT_SOURCES as never),
          ),
        );
      return Number(row?.total ?? 0);
    }

    /** What the officer's member card shows, which is what the ledger must match. */
    async function shownPoints(userId: string) {
      return (await callerFor(officer).member.byId({ id: userId })).totalPoints;
    }

    beforeAll(async () => {
      officer = await makeUser("officer", "ADMIN");
      boss = await makeUser("boss", "SUPER_ADMIN");
    }, SLOW);

    afterAll(async () => {
      session = null;
      // Events before users: an event keeps the officer who made it alive.
      if (eventIds.length > 0) {
        await db.delete(events).where(inArray(events.id, eventIds));
      }
      if (groupIds.length > 0) {
        await db.delete(kinGroups).where(inArray(kinGroups.id, groupIds));
      }
      if (userIds.length > 0) {
        await db.delete(auditLog).where(inArray(auditLog.actorId, userIds));
        await db.delete(users).where(inArray(users.id, userIds));
      }
    }, SLOW);

    describe("role changes", () => {
      it(
        "log the role replaced and the role set, and an unchanged role logs nothing",
        async () => {
          const target = await makeUser("promoted", "MEMBER");

          await callerFor(boss).member.setRole({
            userId: target.id,
            role: "ADMIN",
          });
          await callerFor(boss).member.setRole({
            userId: target.id,
            role: "ADMIN",
          });

          const rows = await auditBy(boss.id, "member.set_role");
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            targetType: "member",
            targetId: target.id,
            targetLabel: target.email,
            before: { role: "MEMBER" },
            after: { role: "ADMIN" },
          });
        },
        SLOW,
      );

      it(
        "roll back with their log row: a change whose row cannot be written does not happen",
        async () => {
          const target = await makeUser("kept", "MEMBER");

          await expect(
            callerFor(boss, refusingInserts(auditLog)).member.setRole({
              userId: target.id,
              role: "ADMIN",
            }),
          ).rejects.toThrow();

          const [row] = await db
            .select({ role: users.role })
            .from(users)
            .where(eq(users.id, target.id));
          expect(row?.role).toBe("MEMBER");
        },
        SLOW,
      );
    });

    describe("application decisions", () => {
      it(
        "log the status replaced, the status set, and whose application it was",
        async () => {
          const applicant = await makeUser("applicant", "MEMBER");
          const [application] = await db
            .insert(committeeApplications)
            .values({
              userId: applicant.id,
              cycle: applicationCycle,
              wantsEvents: true,
              discordHandle: "applicant",
            })
            .returning({ id: committeeApplications.id });

          await callerFor(officer).committee.setStatus({
            id: application!.id,
            status: "accepted",
          });
          await callerFor(officer).committee.setStatus({
            id: application!.id,
            status: "accepted",
          });

          const rows = await auditBy(officer.id, "committee.set_status");
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            targetType: "application",
            targetId: application!.id,
            targetLabel: applicant.email,
            before: { status: "submitted", cycle: applicationCycle },
            after: { status: "accepted", cycle: applicationCycle },
          });
        },
        SLOW,
      );
    });

    describe("check-ins", () => {
      it(
        "a manual check-in writes the attendance row, its ledger row and its log row together",
        async () => {
          const member = await makeUser("manual", "MEMBER");
          const event = await makeEvent("manual", 7);

          await callerFor(officer).event.manualCheckIn({
            eventId: event.id,
            email: member.email,
          });

          expect(await checkInsOf(member.id, event.id)).toHaveLength(1);
          const ledger = await ledgerFor(member.id);
          expect(ledger).toHaveLength(1);
          expect(ledger[0]).toMatchObject({
            delta: 7,
            source: "manual_check_in",
            eventId: event.id,
            actedByUserId: officer.id,
          });
          const rows = (
            await auditBy(officer.id, "event.manual_check_in")
          ).filter((row) => row.targetId === member.id);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            targetType: "member",
            targetLabel: member.email,
            after: { eventId: event.id, points: 7 },
          });
        },
        SLOW,
      );

      it(
        "a duplicate manual check-in is refused and leaves no second row of any kind",
        async () => {
          const member = await makeUser("twice", "MEMBER");
          const event = await makeEvent("twice");
          const caller = callerFor(officer);
          await caller.event.manualCheckIn({
            eventId: event.id,
            email: member.email,
          });

          await expect(
            caller.event.manualCheckIn({
              eventId: event.id,
              email: member.email,
            }),
          ).rejects.toMatchObject({ code: "CONFLICT" });

          expect(await ledgerFor(member.id)).toHaveLength(1);
          const rows = (
            await auditBy(officer.id, "event.manual_check_in")
          ).filter((row) => row.targetId === member.id);
          expect(rows).toHaveLength(1);
        },
        SLOW,
      );

      it(
        "a manual check-in whose ledger or log row cannot be written does not happen",
        async () => {
          const event = await makeEvent("rollback");

          for (const table of [pointsLedger, auditLog]) {
            const member = await makeUser(
              table === auditLog ? "rb-audit" : "rb-ledger",
              "MEMBER",
            );
            await expect(
              callerFor(officer, refusingInserts(table)).event.manualCheckIn({
                eventId: event.id,
                email: member.email,
              }),
            ).rejects.toThrow();

            expect(await checkInsOf(member.id, event.id)).toHaveLength(0);
            expect(await ledgerFor(member.id)).toHaveLength(0);
          }
        },
        SLOW,
      );

      it(
        "removing a check-in takes the points back in the ledger and logs what was removed",
        async () => {
          const member = await makeUser("removed", "MEMBER");
          const event = await makeEvent("removed", 9);
          const caller = callerFor(officer);
          await caller.event.manualCheckIn({
            eventId: event.id,
            email: member.email,
          });

          await caller.event.removeCheckIn({
            eventId: event.id,
            userId: member.id,
          });
          // Nothing left to remove: no ledger row, no log row.
          await caller.event.removeCheckIn({
            eventId: event.id,
            userId: member.id,
          });

          expect(await checkInsOf(member.id, event.id)).toHaveLength(0);
          const ledger = await ledgerFor(member.id);
          expect(ledger.map((row) => [row.source, row.delta])).toEqual([
            ["manual_check_in", 9],
            ["check_in_removed", -9],
          ]);
          expect(await ledgerLivePoints(member.id)).toBe(0);

          const rows = await auditBy(officer.id, "event.remove_check_in");
          expect(rows.filter((row) => row.targetId === member.id)).toHaveLength(
            1,
          );
          expect(rows.find((row) => row.targetId === member.id)).toMatchObject({
            targetLabel: member.email,
            before: { eventId: event.id, method: "manual", points: 9 },
            after: null,
          });
        },
        SLOW,
      );

      it(
        "a member's own scan writes its ledger row with the attendance row",
        async () => {
          const member = await makeUser("scanner", "MEMBER");
          const event = await makeEvent("scan", 4);

          const result = await callerFor(member).event.checkIn({
            code: event.checkInCode,
          });

          expect(result.pointsEarned).toBe(4);
          const ledger = await ledgerFor(member.id);
          expect(ledger).toHaveLength(1);
          expect(ledger[0]).toMatchObject({
            delta: 4,
            source: "check_in",
            eventId: event.id,
            actedByUserId: null,
          });
        },
        SLOW,
      );

      it(
        "a scan whose ledger row cannot be written does not check the member in",
        async () => {
          const member = await makeUser("scanner-rb", "MEMBER");
          const event = await makeEvent("scan-rb");

          await expect(
            callerFor(member, refusingInserts(pointsLedger)).event.checkIn({
              code: event.checkInCode,
            }),
          ).rejects.toThrow();

          expect(await checkInsOf(member.id, event.id)).toHaveLength(0);
        },
        SLOW,
      );
    });

    describe("the ledger and the totals the screens read", () => {
      it(
        "agree through scans, officer check-ins, removals, archiving and restoring",
        async () => {
          const member = await makeUser("totals", "MEMBER");
          const other = await makeUser("totals-other", "MEMBER");
          const caller = callerFor(officer);

          const scanned = await makeEvent("totals-scan", 10);
          const stamped = await makeEvent("totals-stamp", 5);
          const dropped = await makeEvent("totals-drop", 3);
          const free = await makeEvent("totals-free", 0);

          await callerFor(member).event.checkIn({ code: scanned.checkInCode });
          await callerFor(other).event.checkIn({ code: scanned.checkInCode });
          await caller.event.manualCheckIn({
            eventId: stamped.id,
            email: member.email,
          });
          await caller.event.manualCheckIn({
            eventId: dropped.id,
            email: member.email,
          });
          await caller.event.manualCheckIn({
            eventId: free.id,
            email: member.email,
          });

          const agree = async () => {
            for (const user of [member, other]) {
              expect(await ledgerLivePoints(user.id)).toBe(
                await shownPoints(user.id),
              );
            }
          };

          await agree();
          expect(await shownPoints(member.id)).toBe(18);

          await caller.event.removeCheckIn({
            eventId: dropped.id,
            userId: member.id,
          });
          await agree();
          expect(await shownPoints(member.id)).toBe(15);

          // Archiving is a read-time rule for both, and it is reversible for both.
          await caller.event.setArchived({ id: scanned.id, archived: true });
          await agree();
          expect(await shownPoints(member.id)).toBe(5);
          expect(await shownPoints(other.id)).toBe(0);

          await caller.event.setArchived({ id: scanned.id, archived: false });
          await agree();
          expect(await shownPoints(member.id)).toBe(15);
          expect(await shownPoints(other.id)).toBe(10);

          // One ledger row per check-in, even a zero-point one.
          const ledger = await ledgerFor(member.id);
          expect(ledger.filter((row) => row.eventId === free.id)).toHaveLength(
            1,
          );
        },
        SLOW,
      );
    });

    describe("SASE KIN points", () => {
      const year = schoolYear(new Date());
      const term = semester(new Date());

      async function enroll(user: TestUser, points = 0) {
        await db.insert(mentorshipEnrollments).values({
          userId: user.id,
          year,
          role: "mentee",
          status: "enrolled",
          points,
        });
      }

      const enrollmentPoints = async (userId: string) => {
        const [row] = await db
          .select({ points: mentorshipEnrollments.points })
          .from(mentorshipEnrollments)
          .where(
            and(
              eq(mentorshipEnrollments.userId, userId),
              eq(mentorshipEnrollments.year, year),
            ),
          );
        return row?.points ?? 0;
      };

      const ledgerKinPoints = async (userId: string) => {
        const [row] = await db
          .select({ total: sum(pointsLedger.delta) })
          .from(pointsLedger)
          .where(
            and(
              eq(pointsLedger.userId, userId),
              inArray(pointsLedger.source, [
                "kin_award",
                "kin_group_award",
                "opening_balance",
              ]),
            ),
          );
        return Number(row?.total ?? 0);
      };

      it(
        "awarding one member logs the total before and after, and the ledger matches the enrollment",
        async () => {
          const member = await makeUser("kin-one", "MEMBER");
          await enroll(member);

          await callerFor(officer).mentorship.awardPoints({
            userId: member.id,
            points: 5,
          });
          await callerFor(officer).mentorship.awardPoints({
            userId: member.id,
            points: 2,
          });

          const rows = (
            await auditBy(officer.id, "mentorship.award_points")
          ).filter((row) => row.targetId === member.id);
          expect(rows.map((row) => [row.before, row.after])).toEqual([
            [{ points: 0 }, { points: 5 }],
            [{ points: 5 }, { points: 7 }],
          ]);
          expect(await enrollmentPoints(member.id)).toBe(7);
          expect(await ledgerKinPoints(member.id)).toBe(7);
          expect((await ledgerFor(member.id)).map((row) => row.source)).toEqual(
            ["kin_award", "kin_award"],
          );
        },
        SLOW,
      );

      it(
        "awarding a group gives each member a ledger row and logs one entry for the group",
        async () => {
          const first = await makeUser("kin-g1", "MEMBER");
          const second = await makeUser("kin-g2", "MEMBER");
          await enroll(first, 4);
          await enroll(second);
          const [group] = await db
            .insert(kinGroups)
            .values({ year, semester: term, name: `Hive ${suffix}` })
            .returning({ id: kinGroups.id });
          groupIds.push(group!.id);
          await db.insert(kinMemberships).values([
            { userId: first.id, semester: term, groupId: group!.id },
            { userId: second.id, semester: term, groupId: group!.id },
          ]);

          await callerFor(officer).mentorship.awardGroupPoints({
            groupId: group!.id,
            points: 3,
          });

          expect(await enrollmentPoints(first.id)).toBe(7);
          expect(await enrollmentPoints(second.id)).toBe(3);
          // The first member's 4 predate the ledger, so only the award is in it.
          expect(await ledgerKinPoints(first.id)).toBe(3);
          expect(await ledgerKinPoints(second.id)).toBe(3);
          const rows = (
            await auditBy(officer.id, "mentorship.award_group_points")
          ).filter((row) => row.targetId === group!.id);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            targetType: "kin_group",
            targetLabel: `Hive ${suffix}`,
            after: { points: 3, members: 2 },
          });
        },
        SLOW,
      );

      it(
        "an award that fails to log is not applied",
        async () => {
          const member = await makeUser("kin-rb", "MEMBER");
          await enroll(member);

          await expect(
            callerFor(
              officer,
              refusingInserts(auditLog),
            ).mentorship.awardPoints({
              userId: member.id,
              points: 5,
            }),
          ).rejects.toThrow();

          expect(await enrollmentPoints(member.id)).toBe(0);
          expect(await ledgerFor(member.id)).toHaveLength(0);
        },
        SLOW,
      );
    });

    describe("exports and downloads", () => {
      it(
        "the roster export logs its search and how many rows it held",
        async () => {
          const member = await makeUser("exported", "MEMBER");

          const result = await callerFor(officer).member.exportRoster({
            search: member.id,
          });

          expect(result.members).toHaveLength(1);
          const rows = await auditBy(officer.id, "export.roster");
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            targetType: "roster",
            targetId: null,
            after: { rows: 1, truncated: false, search: member.id },
          });
        },
        SLOW,
      );

      it(
        "the attendance export logs the event and the row count",
        async () => {
          const member = await makeUser("attended", "MEMBER");
          const event = await makeEvent("export");
          await callerFor(officer).event.manualCheckIn({
            eventId: event.id,
            email: member.email,
          });

          await callerFor(officer).event.exportAttendance({ id: event.id });

          const rows = await auditBy(officer.id, "export.attendance");
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            targetType: "event",
            targetId: event.id,
            after: { rows: 1, truncated: false },
          });
        },
        SLOW,
      );

      it(
        "the committee export logs the cycle and the row count",
        async () => {
          await callerFor(officer).committee.exportCycle({
            cycle: applicationCycle,
          });

          const rows = await auditBy(officer.id, "export.committee");
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            targetType: "cycle",
            targetId: applicationCycle,
          });
        },
        SLOW,
      );

      describe("resume downloads", () => {
        const asSession = (user: TestUser | null) => {
          session = user
            ? {
                user: { id: user.id, role: user.role, email: user.email },
                expires: new Date(Date.now() + 86_400_000).toISOString(),
              }
            : null;
        };

        const download = (ownerId: string) =>
          resumeRoute.GET(new Request("http://localhost/resume") as never, {
            params: Promise.resolve({ id: ownerId }),
          });

        it(
          "an officer's download is logged with the file, and the file still arrives",
          async () => {
            const owner = await makeUser("resume-owner", "MEMBER");
            const reader = await makeUser("resume-reader", "ADMIN");
            const bytes = Buffer.from("%PDF-1.4 test");
            await db.insert(resumes).values({
              userId: owner.id,
              fileName: "ada.pdf",
              mimeType: "application/pdf",
              byteSize: bytes.byteLength,
              fileBytes: bytes.toString("base64"),
            });

            asSession(reader);
            const response = await download(owner.id);

            expect(response.status).toBe(200);
            expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
            const rows = await auditBy(reader.id, "resume.download");
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
              targetType: "member",
              targetId: owner.id,
              targetLabel: owner.email,
              after: { fileName: "ada.pdf", bytes: bytes.byteLength },
            });
          },
          SLOW,
        );

        it(
          "a refused or missing download logs nothing",
          async () => {
            const owner = await makeUser("resume-none", "MEMBER");
            const outsider = await makeUser("resume-outsider", "MEMBER");

            asSession(outsider);
            expect((await download(owner.id)).status).toBe(403);

            asSession(null);
            expect((await download(owner.id)).status).toBe(401);

            asSession(officer);
            expect((await download(owner.id)).status).toBe(404);

            for (const actor of [outsider, officer]) {
              expect(await auditBy(actor.id, "resume.download")).toHaveLength(
                0,
              );
            }
          },
          SLOW,
        );
      });
    });

    describe("the officer lists", () => {
      it(
        "page the log newest first and filter by officer, action and date",
        async () => {
          const caller = callerFor(officer);
          const all = await caller.audit.log({ actorId: boss.id });
          expect(all.total).toBeGreaterThan(0);
          expect(all.rows.every((row) => row.actorId === boss.id)).toBe(true);

          const byAction = await caller.audit.log({
            actorId: officer.id,
            action: "export.roster",
          });
          expect(
            byAction.rows.every((row) => row.action === "export.roster"),
          ).toBe(true);
          expect(byAction.total).toBe(1);

          const future = await caller.audit.log({
            actorId: officer.id,
            from: new Date(Date.now() + 86_400_000),
          });
          expect(future.total).toBe(0);

          const past = await caller.audit.log({
            actorId: officer.id,
            to: new Date(Date.now() - 365 * 86_400_000),
          });
          expect(past.total).toBe(0);

          const times = (
            await caller.audit.log({ actorId: officer.id })
          ).rows.map((row) => row.at.getTime());
          expect(times).toEqual([...times].sort((a, b) => b - a));

          const actors = await caller.audit.actors();
          expect(actors.map((actor) => actor.id)).toContain(officer.id);
        },
        SLOW,
      );

      it(
        "page the ledger and filter by member and source, with the net of every match",
        async () => {
          const caller = callerFor(officer);

          const forMember = await caller.audit.ledger({
            search: `aud-removed-${suffix}`,
          });
          expect(forMember.rows.map((row) => row.delta).sort()).toEqual([
            -9, 9,
          ]);
          expect(forMember.net).toBe(0);
          expect(forMember.total).toBe(2);

          const removals = await caller.audit.ledger({
            search: `aud-removed-${suffix}`,
            source: "check_in_removed",
          });
          expect(removals.rows).toHaveLength(1);
          expect(removals.net).toBe(-9);

          const paged = await caller.audit.ledger({
            search: `aud-removed-${suffix}`,
            limit: 1,
            offset: 1,
          });
          expect(paged.rows).toHaveLength(1);
          expect(paged.total).toBe(2);

          // A search for "%" is those characters, not a match for everyone.
          const wildcard = await caller.audit.ledger({ search: "%" });
          expect(wildcard.total).toBe(0);
        },
        SLOW,
      );

      it(
        "are for officers",
        async () => {
          const member = await makeUser("nosy", "MEMBER");
          const caller = callerFor(member);
          await expect(caller.audit.log({})).rejects.toMatchObject({
            code: "FORBIDDEN",
          });
          await expect(caller.audit.ledger({})).rejects.toMatchObject({
            code: "FORBIDDEN",
          });
          await expect(caller.audit.actors()).rejects.toMatchObject({
            code: "FORBIDDEN",
          });
        },
        SLOW,
      );
    });
  },
);
