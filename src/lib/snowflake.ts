const SNOWFLAKE = /^[1-9]\d{16,19}$/;

/** Checks the shape of a Discord ID. It says nothing about whether it exists. */
export function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && SNOWFLAKE.test(value);
}

const DISCORD_EPOCH_MS = 1420070400000;

/** When Discord made this ID, in milliseconds since the Unix epoch. */
export function snowflakeTime(id: string): number {
  return Number(BigInt(id) >> 22n) + DISCORD_EPOCH_MS;
}
