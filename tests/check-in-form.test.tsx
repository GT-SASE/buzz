import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  vi,
} from "bun:test";

import { push } from "./mocks/next-navigation";

const mutation: {
  isPending: boolean;
  data: unknown;
  error: { message: string; data?: { code: string } } | undefined;
  onError:
    | ((
        error: { message: string; data?: { code: string } },
        variables: { code: string },
      ) => void)
    | undefined;
} = {
  isPending: false,
  data: undefined,
  error: undefined,
  onError: undefined,
};

const mutate = vi.fn();
const toastError = vi.fn();
const cameraFail = { current: false };
const peek = { data: undefined as unknown };

mock.module("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

mock.module("next/link", () => ({
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

mock.module("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      event: {
        home: { invalidate: vi.fn() },
        myStats: { invalidate: vi.fn() },
        myEvents: { invalidate: vi.fn() },
        upcoming: { invalidate: vi.fn() },
      },
      member: { leaderboard: { invalidate: vi.fn() } },
    }),
    event: {
      peek: { useQuery: () => ({ data: peek.data }) },
      checkIn: {
        useMutation: (opts: {
          onError?: (
            error: { message: string; data?: { code: string } },
            variables: { code: string },
          ) => void;
        }) => {
          mutation.onError = opts.onError;
          return {
            mutate: (input: { code: string }) => mutate(input),
            isPending: mutation.isPending,
            data: mutation.data,
            error: mutation.error,
            reset: vi.fn(),
          };
        },
      },
    },
  },
}));

const { useEffect } = await import("react");
const actualScanner =
  (await import("~/app/portal/(member)/check-in/scanner")) as Record<
    string,
    unknown
  >;
mock.module("~/app/portal/(member)/check-in/scanner", () => {
  return {
    ...actualScanner,
    Scanner: ({
      onUnavailable,
    }: {
      onUnavailable: (reason: string) => void;
    }) => {
      useEffect(() => {
        if (cameraFail.current) onUnavailable("This device has no camera.");
      }, [onUnavailable]);
      return cameraFail.current ? null : <div data-testid="scanner" />;
    },
  };
});

import { CheckInForm } from "~/app/portal/(member)/check-in/check-in-form";
import { checkInPath, signInPath } from "~/app/portal/_lib/paths";

describe("CheckInForm", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    push.mockReset();
    peek.data = undefined;
    mutate.mockReset();
    toastError.mockReset();
    mutation.isPending = false;
    mutation.data = undefined;
    mutation.error = undefined;
    mutation.onError = undefined;
    cameraFail.current = false;
  });

  it("when the camera cannot start, tells the member to scan with their phone or ask an officer", async () => {
    cameraFail.current = true;
    render(<CheckInForm initialCode="" />);

    expect(await screen.findByText("The scanner cannot start")).toBeTruthy();
    expect(screen.getByText("This device has no camera.")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("shows the scanner when the camera is available, with no typed-code field", () => {
    render(<CheckInForm initialCode="" />);

    expect(screen.getByTestId("scanner")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("asks for a tap before checking in a code that arrived in the URL", async () => {
    const user = userEvent.setup();
    render(<CheckInForm initialCode="ABCD2345" />);

    expect(screen.getByText("Check in to this event?")).toBeTruthy();
    expect(mutate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Check in" }));
    expect(mutate).toHaveBeenCalledWith({ code: "ABCD2345" });
  });

  it("names the event on the confirm screen, and says when it is closed", async () => {
    peek.data = {
      title: "Fall GBM",
      startsAt: new Date("2026-10-14T18:00:00Z"),
      location: "Klaus 1443",
      pointsValue: 15,
      checkInOpen: true,
    };
    const { unmount } = render(<CheckInForm initialCode="ABCD2345" />);
    expect(screen.getByText("Check in to Fall GBM?")).toBeTruthy();
    expect(screen.getByText("+15 pts")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check in" })).toBeTruthy();
    unmount();

    peek.data = { ...(peek.data as object), checkInOpen: false };
    render(<CheckInForm initialCode="ABCD2345" />);
    expect(screen.getByText("Check-in for this event is closed.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check in" })).toBeNull();
  });

  it("reads a scanned #code= and clears it from the address bar once used", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/portal/check-in#code=ABCD2345");
    render(<CheckInForm initialCode="" />);

    expect(screen.getByText("Check in to this event?")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Check in" }));
    expect(mutate).toHaveBeenCalledWith({ code: "ABCD2345" });
    expect(window.location.hash).toBe("");
  });

  it("sends an expired session back to sign-in", async () => {
    const user = userEvent.setup();
    render(<CheckInForm initialCode="ABCD2345" />);

    await user.click(screen.getByRole("button", { name: "Check in" }));
    mutation.onError?.(
      { message: "Unauthorized", data: { code: "UNAUTHORIZED" } },
      { code: "ABCD2345" },
    );

    expect(push).toHaveBeenCalledWith(signInPath(checkInPath("ABCD2345")));
    expect(toastError).not.toHaveBeenCalled();
  });
});
