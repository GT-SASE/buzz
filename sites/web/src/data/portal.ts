/**
 * Member portal constants.
 *
 * Tiers are DERIVED from a member's point total at render time — there is no
 * tier column and no migration to run when the board wants to retune them.
 * Editing the thresholds below is the whole change.
 *
 * TODO: confirm the tier names and thresholds with the board before they get
 * printed on anything.
 */
export const tiers = [
  { name: "Member", min: 0 },
  { name: "Active", min: 25 },
  { name: "Core", min: 75 },
  { name: "Distinguished", min: 150 },
] as const;

export type Tier = (typeof tiers)[number]["name"];

/** The highest tier a total clears, plus how far the next one is. */
export function tierFor(points: number) {
  type Band = (typeof tiers)[number];
  let current: Band = tiers[0];
  let next: Band | undefined;

  for (const tier of tiers) {
    if (points >= tier.min) {
      current = tier;
    } else {
      next ??= tier;
    }
  }

  return {
    name: current.name,
    next: next?.name,
    pointsToNext: next ? next.min - points : null,
    /** 0-1 through the current band; 1 once the top tier is reached. */
    progress: next
      ? Math.min(1, (points - current.min) / (next.min - current.min))
      : 1,
  };
}

/** Where members go to see the calendar the portal does not duplicate. */
export const portalNav = [
  { href: "/portal", label: "Dashboard" },
  { href: "/portal/check-in", label: "Check in" },
  { href: "/portal/events", label: "My events" },
] as const;

export const adminNav = [{ href: "/portal/admin", label: "Events" }] as const;
