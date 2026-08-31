import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const period = { current: "semester" as "30d" | "90d" | "semester" | "all" };

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("~/trpc/react", () => ({
  api: {
    chapter: {
      attendance: {
        useQuery: (input: { period: typeof period.current }) => {
          period.current = input.period;
          return {
            isPending: false,
            error: null,
            data: {
              period: input.period,
              since: new Date("2025-08-01T04:00:00.000Z"),
              until: new Date("2026-04-01T15:00:00.000Z"),
              events: 2,
              checkIns: 69,
              uniqueMembers: 40,
              averageAttendance: 34.5,
              series: [
                {
                  id: "event-12",
                  title: "March GBM",
                  startsAt: new Date("2026-03-12T22:30:00.000Z"),
                  checkIns: 41,
                },
                {
                  id: "event-8",
                  title: "Spring Kickoff",
                  startsAt: new Date("2026-01-16T23:00:00.000Z"),
                  checkIns: 28,
                },
              ],
            },
          };
        },
      },
    },
  },
}));

import { Attendance } from "../sites/web/src/app/portal/(member)/admin/attendance";

afterEach(() => {
  cleanup();
  period.current = "semester";
});

describe("Attendance", () => {
  it("lists each event with a link to its officer page", () => {
    render(<Attendance />);

    expect(
      screen.getByRole("heading", { name: "Attendance over time" }),
    ).toBeTruthy();
    expect(screen.getByText("69")).toBeTruthy();
    expect(screen.getByText("Members who came")).toBeTruthy();

    const kickoff = screen.getByRole("link", { name: /Spring Kickoff/i });
    expect(kickoff.getAttribute("href")).toBe("/portal/admin/events/event-8");
  });

  it("asks for a different window when an officer picks a period", async () => {
    const user = userEvent.setup();
    render(<Attendance />);

    expect(
      screen
        .getByRole("radio", { name: "School year" })
        .getAttribute("aria-checked"),
    ).toBe("true");

    await user.click(screen.getByRole("radio", { name: "Last 30 days" }));
    expect(period.current).toBe("30d");
  });
});
