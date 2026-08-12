import { TRPCError } from "@trpc/server";

/**
 * The one shape a missing row is allowed to take.
 *
 * Nine copies of the same literal had drifted apart in wording once already,
 * and the message is member-facing — an officer reads it off a phone at the
 * door. Thrown rather than returned so a call site cannot forget the `throw`.
 */
export function notFound(subject: string): never {
  throw new TRPCError({ code: "NOT_FOUND", message: `${subject} not found.` });
}
