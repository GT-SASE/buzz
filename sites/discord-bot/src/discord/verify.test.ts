import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { inspect } from "node:util";
import {
  hasValidSignature,
  hasWellFormedSignatureHeaders,
  interactionToken,
  isFreshTimestamp,
  verifiedInteractionFrom,
  verifySignedRequest,
} from "./verify.ts";
import type { SignedPayload } from "./verify.ts";
import { fakeId } from "../../test/support/ids.ts";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyHex = publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("hex");

function signatureFor(timestamp: string, body: Uint8Array): string {
  return sign(
    null,
    Buffer.concat([Buffer.from(timestamp), body]),
    privateKey,
  ).toString("hex");
}

const ED25519_GROUP_ORDER =
  0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn;

const timestamp = "1700000000";
const body = Buffer.from('{"type":1}');

const valid = (signature: string, signedBody = body, signedAt = timestamp) =>
  hasValidSignature(
    { body: signedBody, signature, timestamp: signedAt },
    publicKeyHex,
  );

describe("hasValidSignature", () => {
  it("accepts a signature over the timestamp and the body, in either case", () => {
    const signature = signatureFor(timestamp, body);

    expect(valid(signature)).toBe(true);
    expect(valid(signature.toUpperCase())).toBe(true);
  });

  it("refuses a changed body or timestamp, or another key", () => {
    const signature = signatureFor(timestamp, body);
    const other = sign(
      null,
      Buffer.concat([Buffer.from(timestamp), body]),
      generateKeyPairSync("ed25519").privateKey,
    ).toString("hex");

    expect(valid(signature, Buffer.from('{"type": 1}'))).toBe(false);
    expect(valid(signature, body, "1700000001")).toBe(false);
    expect(valid(other)).toBe(false);
  });

  it("refuses a malleated signature with the group order added to S", () => {
    const signature = Buffer.from(signatureFor(timestamp, body), "hex");
    const r = signature.subarray(0, 32);
    const s = Buffer.from(signature.subarray(32)).reverse();

    // S is little-endian. Adding zero shows the re-encoding itself is sound.
    const withSRaisedBy = (amount: bigint): string => {
      const raised = BigInt(`0x${s.toString("hex")}`) + amount;
      const encoded = Buffer.from(raised.toString(16).padStart(64, "0"), "hex");
      return Buffer.concat([r, encoded.reverse()]).toString("hex");
    };

    expect(valid(withSRaisedBy(0n))).toBe(true);
    expect(valid(withSRaisedBy(ED25519_GROUP_ORDER))).toBe(false);
  });

  it("still verifies when bytes cross the timestamp and body boundary, so freshness must refuse it", () => {
    const signature = signatureFor(timestamp, body);
    const shifted = Buffer.concat([Buffer.from(timestamp.slice(-1)), body]);

    expect(valid(signature, shifted, timestamp.slice(0, -1))).toBe(true);
    expect(
      isFreshTimestamp(timestamp.slice(0, -1), Number(timestamp) * 1000),
    ).toBe(false);
  });

  // Buffer.from stops at the first character that is not hex, so without the shape
  // check this would decode to the real signature.
  it("refuses malformed headers, including a good signature followed by non-hex", () => {
    const trailing = `${signatureFor(timestamp, body)}zz`;

    expect(hasWellFormedSignatureHeaders("ab".repeat(64), timestamp)).toBe(
      true,
    );
    expect(hasWellFormedSignatureHeaders(trailing, timestamp)).toBe(false);
    expect(hasWellFormedSignatureHeaders("ab".repeat(64), "soon")).toBe(false);
    expect(
      hasWellFormedSignatureHeaders("ab".repeat(64), `${timestamp}{`),
    ).toBe(false);
    for (const signature of [trailing, "", "ab".repeat(63), "zz".repeat(64)]) {
      expect(valid(signature)).toBe(false);
    }
  });
});

describe("isFreshTimestamp", () => {
  const nowSeconds = 1_700_000_000;
  const nowMs = nowSeconds * 1000;

  it.each([
    [String(nowSeconds - 300), true],
    [String(nowSeconds - 301), false],
    [String(nowSeconds + 301), false],
    ["1700000000.5", false],
    ["-1700000000", false],
    [" 1700000000", false],
  ])("reads %j as %p, allowing 5 minutes either way", (value, expected) => {
    expect(isFreshTimestamp(value, nowMs)).toBe(expected);
  });
});

describe("verifySignedRequest", () => {
  const nowMs = Number(timestamp) * 1000;

  it("returns the payload when the signature passes and it is fresh", () => {
    const signature = signatureFor(timestamp, body);

    const signed = verifySignedRequest(
      { body, signature, timestamp },
      publicKeyHex,
      nowMs,
    );

    expect(signed?.payload).toEqual({ type: 1 });
  });

  it("refuses a bad signature, and a stale timestamp with a good one", () => {
    const bad = signatureFor(timestamp, Buffer.from("{}"));
    const good = signatureFor(timestamp, body);

    expect(
      verifySignedRequest(
        { body, signature: bad, timestamp },
        publicKeyHex,
        nowMs,
      ),
    ).toBeUndefined();
    expect(
      verifySignedRequest(
        { body, signature: good, timestamp },
        publicKeyHex,
        nowMs + 301_000,
      ),
    ).toBeUndefined();
  });
});

describe("verifiedInteractionFrom", () => {
  const nowMs = Number(timestamp) * 1000;
  const TOKEN = "unit-test-interaction-token";
  const PAYLOAD = {
    id: fakeId(1),
    token: TOKEN,
    guild_id: fakeId(2),
    channel: { id: fakeId(3), type: 0 },
  };

  function signedPayload(payload: unknown): SignedPayload {
    const bytes = Buffer.from(
      payload === undefined ? "null" : JSON.stringify(payload),
    );
    const signed = verifySignedRequest(
      { body: bytes, signature: signatureFor(timestamp, bytes), timestamp },
      publicKeyHex,
      nowMs,
    );
    if (signed === undefined) {
      throw new Error("the test payload did not verify");
    }
    return signed;
  }

  const build = (payload: unknown) =>
    verifiedInteractionFrom(signedPayload(payload));

  it("takes its fields from the signed payload, with a thread's parent", () => {
    const interaction = build(PAYLOAD);
    const thread = build({
      ...PAYLOAD,
      channel: { id: fakeId(3), type: 11, parent_id: fakeId(4) },
    });
    const text = build({
      ...PAYLOAD,
      channel: { id: fakeId(3), type: 0, parent_id: fakeId(4) },
    });

    expect(interaction).toMatchObject({
      id: fakeId(1),
      guildId: fakeId(2),
      channelId: fakeId(3),
      channelType: 0,
    });
    expect(interaction && interactionToken(interaction)).toBe(TOKEN);
    expect(Object.isFrozen(interaction)).toBe(true);
    expect(thread?.parentId).toBe(fakeId(4));
    expect(text?.parentId).toBeUndefined();
  });

  it.each([
    ["no payload", undefined],
    ["a malformed id", { ...PAYLOAD, id: "../1" }],
    ["no guild, as in a direct message", { ...PAYLOAD, guild_id: undefined }],
    ["a malformed channel id", { ...PAYLOAD, channel: { id: "1", type: 0 } }],
    [
      "a malformed thread parent",
      { ...PAYLOAD, channel: { id: fakeId(3), type: 11, parent_id: "1" } },
    ],
    ["a token of one dot", { ...PAYLOAD, token: "." }],
  ])("refuses %s", (_label, payload) => {
    expect(build(payload)).toBeUndefined();
  });

  it("keeps the token out of inspection and JSON", () => {
    const text = [signedPayload(PAYLOAD), build(PAYLOAD)]
      .map(
        (value) =>
          `${JSON.stringify(value)}${inspect(value, { depth: null, showHidden: true })}`,
      )
      .join("");

    expect(text).not.toContain(TOKEN);
  });

  it("refuses a payload or interaction that did not pass a signature", () => {
    const forged = { payload: PAYLOAD };
    const Signed = signedPayload(PAYLOAD).constructor as new (
      ...args: unknown[]
    ) => SignedPayload;

    // @ts-expect-error A plain object must not be accepted as signed.
    expect(verifiedInteractionFrom(forged)).toBeUndefined();
    expect(
      interactionToken({ ...PAYLOAD, token: () => TOKEN } as never),
    ).toBeUndefined();
    expect(() => new Signed(Symbol("verify"), PAYLOAD)).toThrow(TypeError);
  });
});
