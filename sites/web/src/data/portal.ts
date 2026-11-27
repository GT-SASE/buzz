/**
 * Member portal constants.
 *
 * Tiers are DERIVED from a member's point total at render time — there is no
 * tier column and no migration to run when the board wants to retune them.
 * Editing the thresholds below is the whole change.
 */
export const tiers = [
  { name: "Scout", min: 0 },
  { name: "Member", min: 15 },
  { name: "Regular", min: 30 },
  { name: "Active", min: 50 },
  { name: "Core", min: 80 },
  { name: "Veteran", min: 120 },
  { name: "Champion", min: 170 },
  { name: "Distinguished", min: 230 },
] as const;

/** Same floors the roster cards render. Sent to `member.metrics` so the server bands on this list, not a second copy. */
export const tierFloors = tiers.map((tier) => tier.min);

/** The highest tier a total clears, plus how far the next one is. */
function bandFor<T extends { name: string; min: number }>(
  list: readonly T[],
  points: number,
) {
  let current = list[0]!;
  let next: T | undefined;

  for (const tier of list) {
    if (points >= tier.min) {
      current = tier;
    } else {
      next ??= tier;
    }
  }

  // Clamped at BOTH ends, and the zero-width band guarded. A total below the
  // lowest floor makes `current` and `next` the same band, so the divisor is
  // zero and the ratio comes back -Infinity — which the card then renders as
  // `width: -Infinity%`, an invalid declaration the browser silently drops.
  // Only a hand-edited negative row reaches this, but the field's contract
  // says 0-1 and it should hold whatever it is handed.
  const band = next ? next.min - current.min : 0;
  const progress =
    next && band > 0 ? (points - current.min) / band : next ? 0 : 1;

  return {
    name: current.name,
    /** 1-based place in the table, for "Rank 3 · Regular" on the card. */
    level: list.indexOf(current) + 1,
    next: next?.name,
    pointsToNext: next ? next.min - points : null,
    /** 0-1 through the current band; 1 once the top tier is reached. */
    progress: Number.isFinite(progress)
      ? Math.max(0, Math.min(1, progress))
      : 0,
  };
}

export const tierFor = (points: number) => bandFor(tiers, points);

export const portalNav = [
  { href: "/portal", label: "My card" },
  { href: "/portal/check-in", label: "Check in" },
  { href: "/portal/events", label: "Events" },
  { href: "/portal/mentorship", label: "SASE KIN" },
  { href: "/portal/resume", label: "Resume" },
  { href: "/portal/elections", label: "Elections" },
  { href: "/portal/settings", label: "Settings" },
] as const;

export const adminNav = [
  { href: "/portal/admin", label: "Events" },
  { href: "/portal/admin/members", label: "Members" },
  { href: "/portal/admin/mentorship", label: "SASE KIN" },
  { href: "/portal/admin/committees", label: "Committees" },
  { href: "/portal/admin/elections", label: "Elections" },
  { href: "/portal/admin/announcement", label: "Banner" },
  { href: "/portal/admin/pages", label: "Pages" },
  { href: "/portal/admin/audit", label: "Audit" },
] as const;

/** Mentorship points only. Event attendance has its own card and tiers. */
export const mentorshipTiers = [
  { name: "Signed up", min: 0 },
  { name: "Meeting", min: 10 },
  { name: "Kin", min: 30 },
] as const;

export const mentorshipTierFor = (points: number) =>
  bandFor(mentorshipTiers, points);
