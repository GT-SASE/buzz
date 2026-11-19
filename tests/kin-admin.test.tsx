import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, mock } from "bun:test";

mock.module("~/trpc/react", () => ({
  api: {
    mentorship: {
      semesters: { useQuery: () => ({ data: ["2026-fall", "2026-spring"] }) },
    },
  },
}));
mock.module(
  "../sites/web/src/app/portal/(member)/admin/mentorship/kin-group-manager",
  () => ({
    KinGroupManager: ({ semester }: { semester: string }) => (
      <p>manager {semester}</p>
    ),
  }),
);
mock.module(
  "../sites/web/src/app/portal/(member)/admin/mentorship/mentorship-roster",
  () => ({
    MentorshipRoster: ({ semester }: { semester: string }) => (
      <p>roster {semester}</p>
    ),
  }),
);

import { KinAdmin } from "../sites/web/src/app/portal/(member)/admin/mentorship/kin-admin";

afterEach(cleanup);

describe("KinAdmin", () => {
  it("follows the current semester prop until a semester is picked", () => {
    const { rerender } = render(<KinAdmin currentSemester="2026-fall" />);
    expect(screen.getByText("manager 2026-fall")).toBeTruthy();
    expect(screen.queryByText(/read only/)).toBeNull();

    rerender(<KinAdmin currentSemester="2026-spring" />);
    expect(screen.getByText("manager 2026-spring")).toBeTruthy();
    expect(screen.getByText("roster 2026-spring")).toBeTruthy();
  });
});
