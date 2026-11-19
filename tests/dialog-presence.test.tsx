import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "bun:test";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Progress } from "~/components/ui/progress";

afterEach(cleanup);

describe("Dialog", () => {
  it("mounts content on open and unmounts it on close button and Escape", async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger>open</DialogTrigger>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Body</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByText("open"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("data-state")).toBe("open");

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByText("open"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("AlertDialog", () => {
  it("mounts content on open and unmounts it on cancel", async () => {
    const user = userEvent.setup();
    render(
      <AlertDialog>
        <AlertDialogTrigger>open</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle>Sure?</AlertDialogTitle>
          <AlertDialogDescription>Body</AlertDialogDescription>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
        </AlertDialogContent>
      </AlertDialog>,
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await user.click(screen.getByText("open"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    await user.click(screen.getByText("Cancel"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("Progress", () => {
  it("offsets the indicator by the remaining percentage", () => {
    render(<Progress value={30} />);
    const indicator = document.querySelector<HTMLElement>(
      "[data-slot=progress-indicator]",
    );
    expect(indicator?.style.transform).toBe("translateX(-70%)");
  });
});
