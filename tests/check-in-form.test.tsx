import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { push } from "./mocks/next-navigation";

const { mutate, toastError, mutation, cameraFail } = vi.hoisted(() => {
  const mutation: {
    isPending: boolean;
    data: unknown;
    error: { message: string; data?: { code: string } } | undefined;
    onError:
      | ((error: { message: string; data?: { code: string } }) => void)
      | undefined;
  } = {
    isPending: false,
    data: undefined,
    error: undefined,
    onError: undefined,
  };

  return {
    mutate: vi.fn(),
    toastError: vi.fn(),
    mutation,
    cameraFail: { current: false },
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

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
    useUtils: () => ({
      event: {
        myStats: { invalidate: vi.fn() },
        myEvents: { invalidate: vi.fn() },
        upcoming: { invalidate: vi.fn() },
      },
      member: { leaderboard: { invalidate: vi.fn() } },
    }),
    event: {
      checkIn: {
        useMutation: (opts: {
          onError?: (error: {
            message: string;
            data?: { code: string };
          }) => void;
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

vi.mock("~/app/portal/(member)/check-in/scanner", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const { useEffect } = await import("react");
  return {
    ...actual,
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

describe("CheckInForm", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    push.mockReset();
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

  it("sends an expired session back to sign-in", async () => {
    const user = userEvent.setup();
    render(<CheckInForm initialCode="ABCD2345" />);

    await user.click(screen.getByRole("button", { name: "Check in" }));
    mutation.onError?.({
      message: "Unauthorized",
      data: { code: "UNAUTHORIZED" },
    });

    expect(push).toHaveBeenCalledWith("/portal/signin?from=/portal/check-in");
    expect(toastError).not.toHaveBeenCalled();
  });
});
