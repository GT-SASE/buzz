import { Skeleton } from "~/components/ui/skeleton";

/** Mirrors the dashboard's card-beside-rows geometry so nothing jumps on load. */
export default function PortalLoading() {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="max-w-content mx-auto px-5 py-10 sm:px-6 sm:py-14"
    >
      <span className="sr-only">Loading your portal.</span>

      <div className="grid gap-10 lg:grid-cols-[26rem_minmax(0,1fr)] lg:items-start lg:gap-14">
        <Skeleton className="h-[15.5rem] w-full max-w-[26rem] rounded-lg" />

        <div>
          <Skeleton className="h-[6.5rem] w-full rounded-lg" />

          {[0, 1].map((block) => (
            <div key={block} className="mt-12">
              <div className="border-hairline flex items-baseline justify-between border-b pb-3">
                <Skeleton className="h-3 w-28 rounded-full" />
              </div>
              {[0, 1, 2].map((row) => (
                <div
                  key={row}
                  className="border-hairline flex items-baseline gap-4 border-b py-4"
                >
                  <Skeleton className="h-3 w-32 shrink-0 rounded-full" />
                  <Skeleton className="h-3 flex-1 rounded-full" />
                  <Skeleton className="h-3 w-10 shrink-0 rounded-full" />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
