import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { inspect } from "node:util";
import {
  hasValidSignature,
  hasWellFormedSignatureHeaders,
  interactionToken,
  isFreshTimestamp,
  isThreadChannelType,
  verifiedInteractionFrom,
  verifySignedRequest,
} from "./verify.ts";
import type { SignedPayload, VerifiedInteraction } from "./verify.ts";
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

describe("hasValidSignature", () => {
  it("accepts a signature over the timestamp and the body", () => {
    const signature = signatureFor(timestamp, body);
    expect(
      hasValidSignature({ body, signature, timestamp }, publicKeyHex),
    ).toBe(true);
  });

  it("checks bytes, so bytes that are not valid UTF-8 still verify", () => {
    const binary = Uint8Array.from([0x7b, 0xff, 0xfe, 0x7d]);
    const signature = signatureFor(timestamp, binary);
    expect(
      hasValidSignature({ body: binary, signature, timestamp }, publicKeyHex),
    ).toBe(true);
  });

  it("refuses a body that differs only in whitespace", () => {
    const signature = signatureFor(timestamp, body);
    expect(
      hasValidSignature(
        { body: Buffer.from('{"type": 1}'), signature, timestamp },
        publicKeyHex,
      ),
    ).toBe(false);
  });

  it("refuses a changed timestamp", () => {
    const signature = signatureFor(timestamp, body);
    expect(
      hasValidSignature(
        { body, signature, timestamp: "1700000001" },
        publicKeyHex,
      ),
    ).toBe(false);
  });

  it("refuses a signature from another key", () => {
    const other = generateKeyPairSync("ed25519");
    const signature = sign(
      null,
      Buffer.concat([Buffer.from(timestamp), body]),
      other.privateKey,
    ).toString("hex");
    expect(
      hasValidSignature({ body, signature, timestamp }, publicKeyHex),
    ).toBe(false);
  });

  it("accepts the same signature spelled in uppercase", () => {
    const signature = signatureFor(timestamp, body);
    expect(signature).toMatch(/[a-f]/);
    expect(
      hasValidSignature(
        { body, signature: signature.toUpperCase(), timestamp },
        publicKeyHex,
      ),
    ).toBe(true);
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

    expect(
      hasValidSignature(
        { body, signature: withSRaisedBy(0n), timestamp },
        publicKeyHex,
      ),
    ).toBe(true);
    expect(
      hasValidSignature(
        { body, signature: withSRaisedBy(ED25519_GROUP_ORDER), timestamp },
        publicKeyHex,
      ),
    ).toBe(false);
  });

  it("still verifies when bytes cross the timestamp and body boundary, so freshness must refuse it", () => {
    // The signed message is the two parts joined, so moving the boundary keeps
    // the signature valid. isFreshTimestamp is what catches a shorter timestamp.
    const signature = signatureFor(timestamp, body);
    const shifted = {
      timestamp: timestamp.slice(0, -1),
      body: Buffer.concat([Buffer.from(timestamp.slice(-1)), body]),
    };

    expect(hasValidSignature({ ...shifted, signature }, publicKeyHex)).toBe(
      true,
    );
    expect(isFreshTimestamp(shifted.timestamp, Number(timestamp) * 1000)).toBe(
      false,
    );
  });

  // Buffer.from stops at the first character that is not hex, so without the shape
  // check these decode to the real signature. Extra hex would not show that: it decodes
  // to a longer signature, and the signature check itself refuses it.
  it.each([
    ["letters that are not hex", "zz"],
    ["a newline", "\n"],
  ])("refuses a good signature followed by %s", (_label, suffix) => {
    const signature = `${signatureFor(timestamp, body)}${suffix}`;

    expect(hasWellFormedSignatureHeaders(signature, timestamp)).toBe(false);
    expect(
      hasValidSignature({ body, signature, timestamp }, publicKeyHex),
    ).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["too short", "ab".repeat(63)],
    ["too long", "ab".repeat(65)],
    ["not hex", "zz".repeat(64)],
  ])("refuses a signature that is %s", (_label, signature) => {
    expect(
      hasValidSignature({ body, signature, timestamp }, publicKeyHex),
    ).toBe(false);
  });
});

describe("hasWellFormedSignatureHeaders", () => {
  const signature = "ab".repeat(64);

  it.each([
    ["lowercase", signature],
    ["uppercase", "AB".repeat(64)],
    ["mixed case", "aB".repeat(64)],
  ])("accepts %s hex and unix seconds", (_label, goodSignature) => {
    expect(hasWellFormedSignatureHeaders(goodSignature, timestamp)).toBe(true);
  });

  it.each([
    ["a short signature", "ab".repeat(63), timestamp],
    ["a non-numeric timestamp", signature, "soon"],
    ["an empty timestamp", signature, ""],
    ["a timestamp with a space", signature, `${timestamp} `],
    ["a timestamp with a brace from the body", signature, `${timestamp}{`],
  ])("refuses %s", (_label, badSignature, badTimestamp) => {
    expect(hasWellFormedSignatureHeaders(badSignature, badTimestamp)).toBe(
      false,
    );
  });
});

describe("isFreshTimestamp", () => {
  const nowSeconds = 1_700_000_000;
  const nowMs = nowSeconds * 1000;

  it.each([
    ["now", nowSeconds, true],
    ["exactly 5 minutes old", nowSeconds - 300, true],
    ["just over 5 minutes old", nowSeconds - 301, false],
    ["exactly 5 minutes ahead", nowSeconds + 300, true],
    ["just over 5 minutes ahead", nowSeconds + 301, false],
  ])("handles a timestamp that is %s", (_label, seconds, expected) => {
    expect(isFreshTimestamp(String(seconds), nowMs)).toBe(expected);
  });

  it.each(["", "abc", "1700000000.5", "-1700000000", "1e9", " 1700000000"])(
    "refuses the malformed timestamp %j",
    (value) => {
      expect(isFreshTimestamp(value, nowMs)).toBe(false);
    },
  );
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

  it("refuses a bad signature", () => {
    const signature = signatureFor(timestamp, Buffer.from("{}"));

    expect(
      verifySignedRequest({ body, signature, timestamp }, publicKeyHex, nowMs),
    ).toBeUndefined();
  });

  it("refuses a stale timestamp even with a good signature", () => {
    const signature = signatureFor(timestamp, body);

    expect(
      verifySignedRequest(
        { body, signature, timestamp },
        publicKeyHex,
        nowMs + 301_000,
      ),
    ).toBeUndefined();
  });

  it("marks signed bytes that are not JSON with no payload", () => {
    const notJson = Buffer.from("not json");
    const signature = signatureFor(timestamp, notJson);

    const signed = verifySignedRequest(
      { body: notJson, signature, timestamp },
      publicKeyHex,
      nowMs,
    );

    expect(signed).toBeDefined();
    expect(signed?.payload).toBeUndefined();
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

  const field = (payload: unknown) => (payload as { token?: unknown }).token;

  function built(payload: unknown): VerifiedInteraction {
    const interaction = build(payload);
    if (interaction === undefined) {
      throw new Error("the test interaction did not build");
    }
    return interaction;
  }

  it("takes its fields from the signed payload", () => {
    const interaction = build(PAYLOAD);

    expect(interaction?.id).toBe(fakeId(1));
    expect(interaction?.guildId).toBe(fakeId(2));
    expect(interaction?.channelId).toBe(fakeId(3));
    expect(interaction?.channelType).toBe(0);
    expect(interaction?.parentId).toBeUndefined();
    expect(interaction && interactionToken(interaction)).toBe(TOKEN);
  });

  it.each([10, 11, 12])("keeps the parent of thread type %i", (type) => {
    const interaction = build({
      ...PAYLOAD,
      channel: { id: fakeId(3), type, parent_id: fakeId(4) },
    });

    expect(interaction?.parentId).toBe(fakeId(4));
  });

  it.each([0, 2, 5, 13, 15, 16])(
    "ignores parent_id on channel type %i, where it is a category",
    (type) => {
      const interaction = build({
        ...PAYLOAD,
        channel: { id: fakeId(3), type, parent_id: fakeId(4) },
      });

      expect(interaction).toBeDefined();
      expect(interaction?.parentId).toBeUndefined();
    },
  );

  it.each([undefined, null])("accepts a thread whose parent_id is %j", (id) => {
    const interaction = build({
      ...PAYLOAD,
      channel: { id: fakeId(3), type: 11, parent_id: id },
    });

    expect(interaction).toBeDefined();
    expect(interaction?.parentId).toBeUndefined();
  });

  it.each([
    ["no payload", undefined],
    ["a payload that is not an object", "text"],
    ["no id", { ...PAYLOAD, id: undefined }],
    ["a malformed id", { ...PAYLOAD, id: "../1" }],
    ["no guild, as in a direct message", { ...PAYLOAD, guild_id: undefined }],
    ["a malformed guild", { ...PAYLOAD, guild_id: "../1" }],
    ["no channel", { ...PAYLOAD, channel: undefined }],
    ["a malformed channel id", { ...PAYLOAD, channel: { id: "1", type: 0 } }],
    ["no channel type", { ...PAYLOAD, channel: { id: fakeId(3) } }],
    [
      "a channel type that is not a number",
      { ...PAYLOAD, channel: { id: fakeId(3), type: "0" } },
    ],
    [
      "a malformed thread parent",
      { ...PAYLOAD, channel: { id: fakeId(3), type: 11, parent_id: "1" } },
    ],
    ["no token", { ...PAYLOAD, token: undefined }],
    ["an empty token", { ...PAYLOAD, token: "" }],
    ["a token of one dot", { ...PAYLOAD, token: "." }],
    ["a token of two dots", { ...PAYLOAD, token: ".." }],
  ])("refuses %s", (_label, payload) => {
    expect(build(payload)).toBeUndefined();
  });

  it("keeps the token out of a serialized signed payload", () => {
    const signed = signedPayload(PAYLOAD);
    const text = `${JSON.stringify(signed)}${inspect(signed, { depth: null, showHidden: true })}`;

    expect(text).not.toContain(TOKEN);
    expect(field(signed.payload)).toBe(TOKEN);
  });

  it("keeps the token out of inspection and JSON", () => {
    const text = `${JSON.stringify(build(PAYLOAD))}${inspect(build(PAYLOAD), { depth: null, showHidden: true })}`;

    expect(text).not.toContain(TOKEN);
  });

  it("is frozen", () => {
    const interaction = built(PAYLOAD);

    expect(Object.isFrozen(interaction)).toBe(true);
    expect(() => {
      (interaction as { channelId: string }).channelId = fakeId(9);
    }).toThrow(TypeError);
  });

  it("refuses a payload that did not pass a signature", () => {
    const forged = { payload: PAYLOAD };
    const copied = Object.create(
      Object.getPrototypeOf(signedPayload(PAYLOAD)) as object,
    ) as object;

    // @ts-expect-error A plain object must not be accepted as signed.
    expect(verifiedInteractionFrom(forged)).toBeUndefined();
    expect(verifiedInteractionFrom(copied as SignedPayload)).toBeUndefined();
  });

  it("gives no token for a plain object", () => {
    const forged = { ...PAYLOAD, channelId: fakeId(3), token: () => TOKEN };

    // @ts-expect-error A plain object must not be accepted as an interaction.
    expect(interactionToken(forged)).toBeUndefined();
  });

  it("cannot be forged through a constructor or a subclass", () => {
    const fields = {
      id: fakeId(1),
      token: TOKEN,
      guildId: fakeId(2),
      channelId: fakeId(9),
      channelType: 0,
      parentId: undefined,
    };
    const Interaction = built(PAYLOAD).constructor as new (
      ...args: unknown[]
    ) => VerifiedInteraction;
    const Signed = signedPayload(PAYLOAD).constructor as new (
      ...args: unknown[]
    ) => SignedPayload;
    class ForgedInteraction extends Interaction {}
    class ForgedSigned extends Signed {}

    expect(() => new Interaction(fields)).toThrow(TypeError);
    expect(() => new Interaction(Symbol("verify"), fields)).toThrow(TypeError);
    expect(() => new ForgedInteraction(fields)).toThrow(TypeError);
    expect(() => new Signed(PAYLOAD)).toThrow(TypeError);
    expect(() => new Signed(Symbol("verify"), PAYLOAD)).toThrow(TypeError);
    expect(() => new ForgedSigned(PAYLOAD)).toThrow(TypeError);
  });
});

describe("isThreadChannelType", () => {
  it.each([10, 11, 12])("is true for %i", (type) => {
    expect(isThreadChannelType(type)).toBe(true);
  });

  it.each([0, 2, 4, 5, 9, 13, 15, 16, "11", undefined])(
    "is false for %j",
    (type) => {
      expect(isThreadChannelType(type)).toBe(false);
    },
  );
});
