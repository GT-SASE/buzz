import { Skeleton } from "~/components/ui/skeleton";

/** Simple public-site skeleton — not the member dashboard geometry. */
export default function MarketingLoading() {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="max-w-content mx-auto px-5 py-16 sm:px-6 sm:py-24"
    >
      <span className="sr-only">Loading.</span>
      <Skeleton className="h-3 w-24 rounded-full" />
      <Skeleton className="mt-6 h-12 w-full max-w-xl rounded-lg" />
      <Skeleton className="mt-4 h-4 w-full max-w-md rounded-full" />
      <Skeleton className="mt-10 h-48 w-full rounded-lg" />
    </div>
  );
}
