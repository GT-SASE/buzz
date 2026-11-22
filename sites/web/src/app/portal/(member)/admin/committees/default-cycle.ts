/** The current cycle (open now, else this semester's) if it exists, else the newest. */
export function defaultCycle(data: {
  current: string;
  cycles: readonly { id: string }[];
}) {
  return (
    data.cycles.find((cycle) => cycle.id === data.current)?.id ??
    data.cycles[0]?.id ??
    data.current
  );
}
