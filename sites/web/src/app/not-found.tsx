import { Button } from "~/app/_components/ui";

export default function NotFound() {
  return (
    <section className="bg-cream paper-wash relative flex min-h-[70vh] items-center px-5 sm:px-6">
      <div className="relative mx-auto max-w-2xl text-center">
        {/* gold-ink, not gold: #b3a369 on cream is 2.2:1, and this is real
            text at display size, not decoration. */}
        <p className="font-display text-gold-ink text-hero font-bold">404</p>
        <h1 className="font-display text-navy text-h2 mt-6 font-bold text-balance">
          This page took the Tech Trolley somewhere else.
        </h1>
        <p className="text-lead text-ink-muted mt-4">
          The link may be outdated. Try the calendar or head back to the
          homepage.
        </p>
        <div className="mt-10 flex flex-wrap justify-center gap-4">
          <Button href="/">Back home</Button>
          <Button href="/events" variant="outline">
            See events
          </Button>
        </div>
      </div>
    </section>
  );
}
