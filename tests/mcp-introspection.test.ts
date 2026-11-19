import { describe, expect, it } from "bun:test";

import { listProcedures } from "../packages/mcp/src/procedures";
import { listRoutes } from "../packages/mcp/src/routes";
import { describeSchema } from "../packages/mcp/src/schema";

describe("mcp introspection", () => {
  it("parses tRPC procedures", () => {
    const all = listProcedures();
    const create = all.find((p) => p.path === "page.create");
    expect(create).toMatchObject({ access: "admin", kind: "mutation" });
    expect(create?.line).toBeGreaterThan(0);
    expect(
      all.some((p) => p.access === "protected" && p.kind === "query"),
    ).toBe(true);
  });

  it("describes the pages table with its slug column", async () => {
    const out = await describeSchema("page");
    expect(out).toContain("buzz_page");
    expect(out).toMatch(/\n {2}slug {2}varchar\(60\)/);
  });

  it("lists routes with route groups stripped", () => {
    const routes = listRoutes();
    expect(routes.find((r) => r.url === "/portal/admin/pages")?.tag).toBe(
      "portal admin",
    );
    expect(routes.find((r) => r.url === "/[slug]")?.tag).toBe("marketing");
    expect(routes.some((r) => r.url.includes("("))).toBe(false);
  });
});
