/** Dark projector shell so the member dashboard never flashes on the wall. */
export default function PresentLoading() {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="bg-navy navy-wash fixed inset-0 z-50 flex flex-col items-center justify-center overflow-hidden px-8"
    >
      <span className="sr-only">Loading present screen.</span>
      <div className="bg-gold-bright/20 h-3 w-32 animate-pulse rounded-full" />
      <div className="bg-gold-bright/30 mt-8 h-14 w-full max-w-2xl animate-pulse rounded-lg" />
      <p className="text-gold-bright/60 mt-10 text-sm tracking-wide uppercase">
        Loading present screen
      </p>
    </div>
  );
}
