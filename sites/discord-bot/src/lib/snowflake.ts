const SNOWFLAKE = /^[1-9]\d{16,19}$/;

/** Checks the shape of a Discord ID. It says nothing about whether it exists. */
export function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && SNOWFLAKE.test(value);
}
