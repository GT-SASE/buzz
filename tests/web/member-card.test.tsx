import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "bun:test";

import { MemberCard } from "../../sites/web/src/app/portal/_components/member-card";

afterEach(cleanup);

describe("MemberCard", () => {
  it("labels tier progress as all-time next to the semester points", () => {
    render(
      <MemberCard
        name="Ada"
        memberSince="Fall 2025"
        totalPoints={10}
        totalEvents={2}
        tierPoints={40}
        term="Fall 2026"
      />,
    );
    expect(screen.getByText(/Event points, Fall 2026/)).toBeTruthy();
    expect(
      screen.getByText(/All-time 40 pts · \d+ more to reach/),
    ).toBeTruthy();
  });
});
