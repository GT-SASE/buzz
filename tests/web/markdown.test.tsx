import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "bun:test";

import { Markdown } from "~/components/site/markdown";

describe("Markdown", () => {
  it("renders headings, lists, and tables", () => {
    render(
      <Markdown>{`# Top\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |`}</Markdown>,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Top" })).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("marks external links noopener and leaves internal ones alone", () => {
    render(<Markdown>{`[out](https://example.com) [in](/join)`}</Markdown>);
    expect(screen.getByRole("link", { name: "out" }).getAttribute("rel")).toBe(
      "noopener noreferrer",
    );
    expect(screen.getByRole("link", { name: "in" }).getAttribute("rel")).toBe(
      null,
    );
  });

  it("does not render raw HTML or javascript: links", () => {
    const { container } = render(
      <Markdown>{`<script>alert(1)</script><b>raw</b>\n\n[x](javascript:alert(1))`}</Markdown>,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("x").getAttribute("href") ?? "").not.toMatch(
      /^javascript:/i,
    );
  });
});
