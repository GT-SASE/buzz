import { schoolYearStart } from "./periods";

/**
 * Chapter calendar, Atlanta time. A school year runs August through July and
 * holds two semesters: fall (Aug–Dec) and spring (Jan–Jul). Summer counts as
 * spring so there is never a gap with no current term.
 */

/** `2026-2027`. Rolls over on August 1st. */
export function schoolYear(now: Date) {
  const start = schoolYearStart(now).getUTCFullYear();
  return `${start}-${start + 1}`;
}

/** `fall-2026` or `spring-2027`. Rolls over on August 1st and January 1st. */
export function semester(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  return month >= 8 ? `fall-${year}` : `spring-${year}`;
}

/** The school year a semester id belongs to. */
export function schoolYearOfSemester(id: string) {
  const [term, yearText] = id.split("-");
  const year = Number(yearText);
  return term === "fall" ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}

/** `Fall 2026`. */
export function semesterLabel(id: string) {
  const [term, year] = id.split("-");
  return `${term === "fall" ? "Fall" : "Spring"} ${year}`;
}

export const schoolYearPattern = /^\d{4}-\d{4}$/;
export const semesterPattern = /^(fall|spring)-\d{4}$/;
