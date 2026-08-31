import { describe, expect, it } from "vitest";

import { pooledConnectionString } from "../packages/db/src/pooled-url";

describe("pooledConnectionString", () => {
  it("inserts -pooler on a Neon direct hostname", () => {
    expect(
      pooledConnectionString(
        "postgresql://u:p@ep-cool-rain-123456.us-east-2.aws.neon.tech/neondb?sslmode=require",
      ),
    ).toBe(
      "postgresql://u:p@ep-cool-rain-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require",
    );
  });

  it("leaves an already-pooled Neon host alone", () => {
    const url =
      "postgresql://u:p@ep-cool-rain-123456-pooler.us-east-2.aws.neon.tech/neondb";
    expect(pooledConnectionString(url)).toBe(url);
  });

  it("does not rewrite local Postgres", () => {
    const url = "postgresql://postgres:password@localhost:5432/buzz";
    expect(pooledConnectionString(url)).toBe(url);
  });
});
