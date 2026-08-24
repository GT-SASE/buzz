import { Skeleton } from "~/components/ui/skeleton";

export default function PortalShellLoading() {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="bg-cream paper-wash flex min-h-[60vh] items-center px-5 py-20 sm:px-6"
    >
      <span className="sr-only">Loading.</span>

      <div className="mx-auto w-full max-w-lg">
        <Skeleton className="h-9 w-2/3 rounded-full" />
        <Skeleton className="mt-5 h-3 w-full rounded-full" />
        <Skeleton className="mt-2 h-3 w-4/5 rounded-full" />
        <Skeleton className="mt-8 h-11 w-full rounded-lg" />
      </div>
    </div>
  );
}
