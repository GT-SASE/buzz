import { Skeleton } from "~/components/ui/skeleton";

/** Officer overview geometry — avoids flashing the member dashboard skeleton. */
export default function AdminLoading() {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="max-w-content mx-auto px-5 py-10 sm:px-6 sm:py-14"
    >
      <span className="sr-only">Loading admin.</span>

      <Skeleton className="h-3 w-20 rounded-full" />
      <Skeleton className="mt-4 h-10 w-64 max-w-full rounded-lg" />

      <div className="mt-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i}>
            <Skeleton className="h-3 w-16 rounded-full" />
            <Skeleton className="mt-3 h-9 w-20 rounded-lg" />
            <Skeleton className="mt-2 h-3 w-28 rounded-full" />
          </div>
        ))}
      </div>

      <div className="border-hairline mt-14 border-t pt-8">
        <Skeleton className="h-3 w-24 rounded-full" />
        <Skeleton className="mt-4 h-6 w-72 max-w-full rounded-lg" />
        <Skeleton className="mt-3 h-4 w-48 rounded-full" />
      </div>

      <div className="mt-14">
        <div className="border-hairline flex items-baseline justify-between border-b pb-3">
          <Skeleton className="h-3 w-28 rounded-full" />
          <Skeleton className="h-3 w-20 rounded-full" />
        </div>
        {[0, 1, 2, 3].map((row) => (
          <div
            key={row}
            className="border-hairline flex items-baseline gap-4 border-b py-4"
          >
            <Skeleton className="h-3 w-40 shrink-0 rounded-full" />
            <Skeleton className="h-3 flex-1 rounded-full" />
            <Skeleton className="h-3 w-16 shrink-0 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
