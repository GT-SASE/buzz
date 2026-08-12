/**
 * Member portal constants.
 *
 * Tiers are DERIVED from a member's point total at render time — there is no
 * tier column and no migration to run when the board wants to retune them.
 * Editing the thresholds below is the whole change.
 */
export const tiers = [
  { name: "Member", min: 0 },
  { name: "Active", min: 25 },
  { name: "Core", min: 75 },
  { name: "Distinguished", min: 150 },
] as const;

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
    next: next?.name,
    pointsToNext: next ? next.min - points : null,
    /** 0-1 through the current band; 1 once the top tier is reached. */
    progress: Number.isFinite(progress)
      ? Math.max(0, Math.min(1, progress))
      : 0,
  };
}

/**
 * Two entries, not three.
 *
 * "My events" used to be its own page showing the same card and the same list
 * the dashboard already had. A member has one screen worth of things — their
 * card, what is open, where they have been — and splitting that across tabs
 * made the portal feel bigger than it is without adding anything.
 */
export const portalNav = [
  { href: "/portal", label: "My card" },
  { href: "/portal/check-in", label: "Check in" },
] as const;

export const adminNav = [
  { href: "/portal/admin", label: "Events" },
  { href: "/portal/admin/members", label: "Members" },
] as const;
