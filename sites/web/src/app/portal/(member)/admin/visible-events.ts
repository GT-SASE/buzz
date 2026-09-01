export const adminEventFilters = ["Open", "Past", "Archived", "All"] as const;
export type AdminEventFilter = (typeof adminEventFilters)[number];

type RankableEvent = {
  startsAt: Date;
  archivedAt: Date | null;
  isPast: boolean;
};

/**
 * Open is the next door: soonest first. Past / archived / all keep the
 * newest date at the top so last week's GBM is not buried under 2024.
 */
export function visibleEvents<T extends RankableEvent>(
  events: T[],
  filter: AdminEventFilter,
): T[] {
  const filtered = events.filter((event) => {
    const archived = event.archivedAt !== null;
    if (filter === "Archived") return archived;
    if (filter === "All") return true;
    if (archived) return false;
    return filter === "Past" ? event.isPast : !event.isPast;
  });

  const nextFirst = filter === "Open";
  return [...filtered].sort((a, b) => {
    const delta = a.startsAt.getTime() - b.startsAt.getTime();
    return nextFirst ? delta : -delta;
  });
}
