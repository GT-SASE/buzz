/** One field of a parsed JSON value, or undefined if the value is not an object. */
export function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined;
}
