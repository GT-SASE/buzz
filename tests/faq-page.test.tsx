import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, mock } from "bun:test";

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

import FaqPage, { metadata } from "../sites/web/src/app/(marketing)/faq/page";
import { faqs } from "../sites/web/src/data/faq";

afterEach(cleanup);

describe("/faq", () => {
  it("renders every question as a native disclosure, no script needed", () => {
    const { container } = render(<FaqPage />);

    const rows = [...container.querySelectorAll("details")];
    expect(rows).toHaveLength(faqs.length);
    for (const row of rows) {
      expect(row.querySelector("summary h3")).toBeTruthy();
      expect(row.hasAttribute("open")).toBe(false);
      expect(row.getAttribute("name")).toBe("faq");
    }
    expect(container.querySelectorAll("h1")).toHaveLength(1);
  });

  it("emits FAQPage JSON-LD that matches the visible questions and answers", () => {
    const { container } = render(<FaqPage />);

    const graphs = [
      ...container.querySelectorAll('script[type="application/ld+json"]'),
    ].map((script) => JSON.parse(script.textContent ?? "{}"));
    const faqPage = graphs.find((graph) => graph["@type"] === "FAQPage");

    expect(faqPage.mainEntity).toHaveLength(faqs.length);
    const shown = [...container.querySelectorAll("details")].map((row) => ({
      name: row.querySelector("summary h3")?.textContent,
      text: row.lastElementChild?.textContent,
    }));
    expect(
      faqPage.mainEntity.map(
        (item: { name: string; acceptedAnswer: { text: string } }) => ({
          name: item.name,
          text: item.acceptedAnswer.text,
        }),
      ),
    ).toEqual(shown);
    expect(graphs.some((graph) => graph["@type"] === "BreadcrumbList")).toBe(
      true,
    );
  });

  it("has its own canonical URL", () => {
    expect(metadata.alternates?.canonical).toBe(
      "https://buzzsase.vercel.app/faq",
    );
  });
});
