import { describe, expect, it } from "vitest";
import { isDeclaredLengthWithin, readBodyWithin } from "./read-body.ts";

function streamed(chunks: Uint8Array[]) {
  let pulls = 0;
  let cancelled = false;
  const request = new Request("https://bot.example.test/", {
    method: "POST",
    duplex: "half",
    body: new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = chunks[pulls];
          pulls += 1;
          if (chunk === undefined) {
            controller.close();
          } else {
            controller.enqueue(chunk);
          }
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
  });
  return {
    request,
    pulls: () => pulls,
    cancelled: () => cancelled,
  };
}

describe("isDeclaredLengthWithin", () => {
  it.each([
    [null, true],
    ["0", true],
    ["10", true],
    ["11", false],
    ["-1", false],
    ["1e1", false],
    ["10, 10", false],
    ["", false],
    ["9".repeat(30), false],
  ])("treats %j against a limit of 10 as %j", (contentLength, expected) => {
    expect(isDeclaredLengthWithin(contentLength, 10)).toBe(expected);
  });
});

describe("readBodyWithin", () => {
  it("returns a body with no stream as empty", async () => {
    const request = new Request("https://bot.example.test/", {
      method: "POST",
    });
    expect(await readBodyWithin(request, 10)).toEqual(new Uint8Array());
  });

  it("joins chunks and keeps the exact bytes", async () => {
    const { request } = streamed([
      Uint8Array.of(0xff, 0x00),
      Uint8Array.of(0x7b),
    ]);
    const body = await readBodyWithin(request, 10);
    expect(Buffer.from(body ?? [])).toEqual(Buffer.of(0xff, 0x00, 0x7b));
  });

  it("accepts a body of exactly the limit", async () => {
    const { request } = streamed([new Uint8Array(10)]);
    expect((await readBodyWithin(request, 10))?.byteLength).toBe(10);
  });

  it("stops at the chunk that passes the limit and cancels the rest", async () => {
    const chunks = Array.from({ length: 100 }, () => new Uint8Array(4));
    const { request, pulls, cancelled } = streamed(chunks);

    expect(await readBodyWithin(request, 10)).toBeUndefined();
    expect(pulls()).toBe(3);
    expect(cancelled()).toBe(true);
  });
});
