import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "bun:test";

import { useControlledState } from "~/components/ui/dialog";

afterEach(cleanup);

function Controlled() {
  const [open, setOpen] = useState(false);
  const [state, set] = useControlledState({ value: open, onChange: setOpen });
  return (
    <button type="button" onClick={() => set(!state)}>
      {state ? "open" : "closed"}
    </button>
  );
}

function Uncontrolled({ onChange }: { onChange: (value: boolean) => void }) {
  const [state, set] = useControlledState({ defaultValue: false, onChange });
  return (
    <button type="button" onClick={() => set(!state)}>
      {state ? "open" : "closed"}
    </button>
  );
}

function Pinned() {
  const [state, set] = useControlledState({ value: false });
  return (
    <button type="button" onClick={() => set(true)}>
      {state ? "open" : "closed"}
    </button>
  );
}

describe("useControlledState", () => {
  it("follows the owner's value", async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    await user.click(screen.getByRole("button"));
    expect(screen.getByRole("button").textContent).toBe("open");
  });

  it("holds its own value when uncontrolled and reports changes", async () => {
    const user = userEvent.setup();
    const seen: boolean[] = [];
    render(<Uncontrolled onChange={(value) => seen.push(value)} />);
    await user.click(screen.getByRole("button"));
    expect(screen.getByRole("button").textContent).toBe("open");
    expect(seen).toEqual([true]);
  });

  it("stays on the owner's value when the owner ignores the change", async () => {
    const user = userEvent.setup();
    render(<Pinned />);
    await user.click(screen.getByRole("button"));
    expect(screen.getByRole("button").textContent).toBe("closed");
  });
});
