import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, mock } from "bun:test";

const idle = { mutate: () => undefined, isPending: false };
mock.module("~/trpc/react", () => ({
  api: {
    useUtils: () => ({}),
    notification: {
      mine: {
        useQuery: () => ({
          isPending: false,
          error: null,
          data: { eventEmails: true, electionEmails: true },
        }),
      },
      save: { useMutation: () => idle },
    },
    member: {
      profile: {
        useQuery: () => ({
          isPending: false,
          error: null,
          data: { graduationYear: 2028 },
        }),
      },
      setProfile: { useMutation: () => idle },
    },
  },
}));

import { NotificationSettings } from "../sites/web/src/app/portal/(member)/settings/notification-settings";
import { ProfileSettings } from "../sites/web/src/app/portal/(member)/settings/profile-settings";

afterEach(cleanup);

describe("settings sections", () => {
  it("names each save button after its section", () => {
    render(
      <>
        <NotificationSettings />
        <ProfileSettings />
      </>,
    );
    expect(
      screen.getByRole("button", { name: "Save email settings" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save about you" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });
});
