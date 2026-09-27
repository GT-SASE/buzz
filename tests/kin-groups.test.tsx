import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const group = (over: Record<string, unknown>) => ({
  id: "g1",
  year: "2026-2027",
  name: "Honeycomb",
  description: "Thursday boba.",
  capacity: 6,
  isOpen: true,
  memberCount: 2,
  points: 15,
  mentors: ["Mina Mentor"],
  ...over,
});

const state = {
  groups: [] as ReturnType<typeof group>[],
  myGroup: null as unknown,
  joined: [] as string[],
};

const idle = { isPending: false, mutate: () => undefined };

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      mentorship: {
        mine: { invalidate: vi.fn() },
        groups: { invalidate: vi.fn() },
        myGroup: { invalidate: vi.fn() },
      },
    }),
    mentorship: {
      groups: {
        useQuery: () => ({ isPending: false, error: null, data: state.groups }),
      },
      myGroup: {
        useQuery: () => ({
          isPending: false,
          error: null,
          data: state.myGroup,
        }),
      },
      joinGroup: {
        useMutation: () => ({
          isPending: false,
          mutate: ({ groupId }: { groupId: string }) =>
            state.joined.push(groupId),
        }),
      },
      leaveGroup: { useMutation: () => idle },
    },
  },
}));

import { KinGroups } from "../sites/web/src/app/portal/(member)/mentorship/kin-groups";

afterEach(() => {
  cleanup();
  state.groups = [];
  state.myGroup = null;
  state.joined = [];
});

describe("KinGroups", () => {
  it("offers Join only on open groups with room", () => {
    state.groups = [
      group({}),
      group({ id: "g2", name: "Full House", capacity: 2 }),
      group({ id: "g3", name: "Roots", isOpen: false }),
    ];
    render(<KinGroups signedUp term="Fall 2026" />);

    fireEvent.click(screen.getByRole("button", { name: "Join Honeycomb" }));
    expect(state.joined).toEqual(["g1"]);
    expect(screen.queryByRole("button", { name: /Join Full House/ })).toBe(
      null,
    );
    expect(screen.queryByRole("button", { name: /Join Roots/ })).toBe(null);
    expect(screen.getByText("Full")).toBeTruthy();
    expect(screen.getByText("Invite-only")).toBeTruthy();
    expect(screen.getByText("Fall 2026")).toBeTruthy();
  });

  it("hides Join until the member has signed up", () => {
    state.groups = [group({})];
    render(<KinGroups signedUp={false} term="Fall 2026" />);
    expect(screen.queryByRole("button", { name: /Join/ })).toBe(null);
    expect(screen.getByText(/Sign up above first/)).toBeTruthy();
  });

  it("shows the member's own group with contact emails", () => {
    state.groups = [group({})];
    state.myGroup = {
      id: "g1",
      name: "Honeycomb",
      description: null,
      members: [
        {
          userId: "u1",
          role: "mentor",
          points: 15,
          name: "Mina Mentor",
          email: "mina@example.com",
        },
      ],
    };
    render(<KinGroups signedUp term="Fall 2026" />);
    expect(
      screen
        .getByRole("link", { name: "mina@example.com" })
        .getAttribute("href"),
    ).toBe("mailto:mina@example.com");
    expect(
      screen.getByRole("button", { name: "Leave this group" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Join/ })).toBe(null);
  });
});
