/** How the schema's custom column types read Postgres's text. */

const TIMESTAMP_TEXT =
  /^([0-9]{4}-[0-9]{2}-[0-9]{2}) ([0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?)([+-][0-9]{2})(?::?([0-9]{2}))?$/;

/**
 * Postgres's own text for a timestamptz, `2030-01-10 12:00:00.123456+00`, in ISO form.
 * Kept as text and not a Date, so the microseconds survive: an edit sends `updated_at`
 * back as the version it read, and a Date would round it to milliseconds and never match.
 */
export function isoTimestamp(value: string): string {
  const match = TIMESTAMP_TEXT.exec(value);
  if (match === null) {
    return value;
  }
  const [, day, clock, hours, minutes = "00"] = match;
  return `${String(day)}T${String(clock)}${String(hours)}:${minutes}`;
}
