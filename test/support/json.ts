/**
 * Zod schemas for JSON a test reads from outside its own code: a file in the
 * repository, or a request body the code under test sent. Each throws with a short
 * reason on the wrong shape, so a test fails where it read the data and not
 * somewhere later.
 */

import { z } from "zod";

const JsonObject = z.record(z.string(), z.unknown());

function parseJson<T>(schema: z.ZodType<T>, text: unknown, what: string): T {
  if (typeof text !== "string") {
    throw new Error(`${what} is not text`);
  }
  const parsed = schema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(
      `${what} has the wrong shape: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

/** Parses text that must hold a JSON object. */
export function jsonObject(
  text: unknown,
  what: string,
): Record<string, unknown> {
  return parseJson(JsonObject, text, what);
}

const Strings = z.array(z.string());

/** The parts of a Discord message body the tests look at. */
const MessageBodySchema = z
  .object({
    content: z.string(),
    flags: z.number().optional(),
    allowed_mentions: z.object({
      users: Strings,
      roles: Strings.default([]),
      parse: Strings,
    }),
    components: z
      .array(
        z.object({ components: z.array(z.object({ custom_id: z.string() })) }),
      )
      .default([]),
  })
  .transform((body) => ({
    content: body.content,
    /** Undefined where the body sets no flags. */
    flags: body.flags,
    users: body.allowed_mentions.users,
    roles: body.allowed_mentions.roles,
    parse: body.allowed_mentions.parse,
    /** The custom IDs of every button, row by row. */
    buttons: body.components.flatMap((row) =>
      row.components.map((button) => button.custom_id),
    ),
  }));

export type MessageBody = z.output<typeof MessageBodySchema>;

export function messageBody(text: unknown): MessageBody {
  return parseJson(MessageBodySchema, text, "the message body");
}

/** The parts of vercel.json the tests check. */
const VercelConfigSchema = z.object({
  crons: z.array(z.object({ path: z.string(), schedule: z.string() })),
  functions: z.record(z.string(), z.object({ maxDuration: z.number() })),
});

export type VercelConfig = z.output<typeof VercelConfigSchema>;

export function vercelConfig(text: string): VercelConfig {
  return parseJson(VercelConfigSchema, text, "vercel.json");
}
