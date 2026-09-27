import { schoolYearStart } from "./periods";

/** `2026-2027`. Rolls over on August 1st, Atlanta time. */
export function kinYear(now: Date) {
  const start = schoolYearStart(now).getUTCFullYear();
  return `${start}-${start + 1}`;
}

export const kinYearSchema = /^\d{4}-\d{4}$/;
