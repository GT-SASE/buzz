/** Small helpers shared by handlers that render names from Discord. */

import { safe, SafeTextError, truncateUserText } from "../discord/safe-text.ts";
import type { SafeText } from "../discord/safe-text.ts";

/**
 * A role or channel name, which anyone who can edit it controls. A name with nothing
 * visible left once cleaned is shown as a placeholder instead of failing the reply.
 */
export function escapedName(raw: string, maxLength: number): SafeText {
  try {
    return truncateUserText(raw, maxLength);
  } catch (error) {
    if (error instanceof SafeTextError) {
      return safe`(no visible name)`;
    }
    throw error;
  }
}

export function commaList(items: readonly SafeText[]): SafeText | undefined {
  return items.reduce<SafeText | undefined>(
    (list, item) => (list === undefined ? item : safe`${list}, ${item}`),
    undefined,
  );
}

export function lines(items: readonly SafeText[]): SafeText | undefined {
  return items.reduce<SafeText | undefined>(
    (list, item) => (list === undefined ? item : safe`${list}\n${item}`),
    undefined,
  );
}
