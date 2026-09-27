/** This semester's cycle if officers opened it, else the newest one. */
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
