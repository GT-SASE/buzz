import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { AUDIT_ACTIONS } from "../../packages/db/src/schema";

type Query = { input: Record<string, unknown>; data: unknown };

/** What each list was last asked for, and what it answers. */
const asked: { log: Query[]; ledger: Query[] } = { log: [], ledger: [] };

const NOW = new Date("2026-11-20T15:30:00.000Z");

const logAnswer = {
  total: 2,
  rows: [
    {
      id: "a1",
      at: NOW,
      action: "member.set_role",
      actorId: "boss",
      actorName: "Bea Boss",
      actorEmail: "bea@gatech.edu",
      targetType: "member",
      targetId: "m1",
      targetLabel: "ada@gatech.edu",
      targetName: "Ada Lovelace",
      targetEmail: "ada@gatech.edu",
      before: { role: "MEMBER" },
      after: { role: "ADMIN" },
    },
    {
      id: "a2",
      at: NOW,
      action: "export.roster",
      actorId: "off",
      actorName: null,
      actorEmail: "off@gatech.edu",
      targetType: "roster",
      targetId: null,
      targetLabel: null,
      targetName: null,
      targetEmail: null,
      before: null,
      after: { rows: 40, truncated: false, search: "" },
    },
  ],
};

const ledgerAnswer = {
  total: 2,
  net: 6,
  rows: [
    {
      id: "l1",
      at: NOW,
      delta: 10,
      reason: "Checked in: GBM 3",
      source: "check_in",
      eventId: "e1",
      userId: "m1",
      name: "Ada Lovelace",
      email: "ada@gatech.edu",
      actorName: null,
      actorEmail: null,
    },
    {
      id: "l2",
      at: NOW,
      delta: -4,
      reason: "Check-in removed: Workshop",
      source: "check_in_removed",
      eventId: "e2",
      userId: "m2",
      name: null,
      email: "bo@gatech.edu",
      actorName: "Bea Boss",
      actorEmail: "bea@gatech.edu",
    },
  ],
};

const use =
  (list: Query[], data: unknown) => (input: Record<string, unknown>) => {
    list.push({ input, data });
    return {
      isPending: false,
      isPlaceholderData: false,
      error: null,
      data,
    };
  };

mock.module("~/trpc/react", () => ({
  api: {
    audit: {
      log: {
        useQuery: (input: Record<string, unknown>) =>
          use(asked.log, logAnswer)(input),
      },
      ledger: {
        useQuery: (input: Record<string, unknown>) =>
          use(asked.ledger, ledgerAnswer)(input),
      },
      actors: {
        useQuery: () => ({
          data: [
            { id: "boss", name: "Bea Boss", email: "bea@gatech.edu" },
            { id: "off", name: null, email: "off@gatech.edu" },
          ],
        }),
      },
    },
  },
}));

// portal-ui reaches the sign-out server action, which needs next-auth and a
// Next runtime; the empty state is all this view takes from it.
mock.module("~/app/portal/_components/portal-ui", () => ({
  EmptyState: ({ title }: { title: string }) => <p>{title}</p>,
}));

// Dynamic, after the mocks: a static import would load the real modules first.
const { AuditView } =
  await import("../../sites/web/src/app/portal/(member)/admin/audit/audit-view");

afterEach(() => {
  cleanup();
  asked.log = [];
  asked.ledger = [];
});

const lastInput = (list: Query[]) => list[list.length - 1]!.input;

describe("AuditView audit log", () => {
  it("lists what each officer did, to whom, and what changed", () => {
    render(<AuditView />);

    // Both layouts are in the DOM; CSS decides which one is seen.
    expect(screen.getAllByText("Changed a role").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Ada Lovelace").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Member to Officer").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Whole roster").length).toBeGreaterThan(0);
    expect(screen.getAllByText("40 rows").length).toBeGreaterThan(0);
    expect(screen.getByText("Showing 1-2 of 2")).toBeTruthy();
  });

  it("starts on the first page with no filter", () => {
    render(<AuditView />);

    expect(lastInput(asked.log)).toMatchObject({
      actorId: undefined,
      action: undefined,
      from: undefined,
      to: undefined,
      limit: 25,
      offset: 0,
    });
  });

  it("filters by officer, action and day, in Atlanta time", () => {
    render(<AuditView />);

    fireEvent.change(screen.getByLabelText("Officer"), {
      target: { value: "boss" },
    });
    fireEvent.change(screen.getByLabelText("Action"), {
      target: { value: "member.set_role" },
    });
    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "2026-11-20" },
    });
    fireEvent.change(screen.getByLabelText("To"), {
      target: { value: "2026-11-20" },
    });

    const input = lastInput(asked.log);
    expect(input).toMatchObject({
      actorId: "boss",
      action: "member.set_role",
      offset: 0,
    });
    expect((input.from as Date).toISOString()).toBe("2026-11-20T05:00:00.000Z");
    expect((input.to as Date).toISOString()).toBe("2026-11-21T05:00:00.000Z");
  });

  it("offers every officer in the log and every action", () => {
    render(<AuditView />);

    const officers = screen.getByLabelText("Officer") as HTMLSelectElement;
    expect([...officers.options].map((option) => option.textContent)).toEqual([
      "Everyone",
      "Bea Boss",
      "off@gatech.edu",
    ]);
    const actions = screen.getByLabelText("Action") as HTMLSelectElement;
    // "Any action" plus every audited action, so a new one cannot slip by unlabeled.
    expect(actions.options.length).toBe(1 + AUDIT_ACTIONS.length);
  });
});

describe("AuditView points ledger", () => {
  it("lists signed points with the reason and where they came from", () => {
    render(<AuditView />);
    fireEvent.click(screen.getByRole("button", { name: "Points ledger" }));

    expect(screen.getAllByText("+10").length).toBeGreaterThan(0);
    expect(screen.getAllByText("-4").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Checked in: GBM 3").length).toBeGreaterThan(0);
    expect(screen.getAllByText("bo@gatech.edu").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("Check-in removed, by Bea Boss").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/Net \+6 points across all of them/)).toBeTruthy();
  });

  it("filters by member and source", async () => {
    render(<AuditView />);
    fireEvent.click(screen.getByRole("button", { name: "Points ledger" }));

    fireEvent.change(screen.getByLabelText("Source"), {
      target: { value: "kin_award" },
    });
    expect(lastInput(asked.ledger)).toMatchObject({
      source: "kin_award",
      offset: 0,
    });

    fireEvent.change(screen.getByLabelText("Member"), {
      target: { value: "  ada " },
    });
    // The search waits for a pause in typing, then sends it trimmed.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(lastInput(asked.ledger)).toMatchObject({
      search: "ada",
      source: "kin_award",
      offset: 0,
    });
  });
});
