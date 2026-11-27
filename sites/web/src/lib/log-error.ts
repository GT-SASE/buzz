/** One JSON line for a loader that failed and fell back, searchable by `event`. */
export function logLoadError(event: string, error: unknown) {
  console.error(
    JSON.stringify({
      level: "error",
      event,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}
