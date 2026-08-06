import Image from "next/image";

import type { Photo } from "~/data/photos";
import { cn } from "~/lib/utils";

/**
 * A chapter photo. The caller sizes the frame and this fills it. `sizes` is not
 * optional: with `fill`, omitting it makes Next request a 100vw source for a
 * tile that may render at 300px.
 */
export function PhotoFrame({
  photo,
  sizes,
  className,
  priority = false,
  rounded,
}: {
  photo: Photo;
  sizes: string;
  className?: string;
  priority?: boolean;
  rounded?: string;
}) {
  return (
    <div
      className={cn(
        "bg-sand group relative overflow-hidden",
        rounded,
        className,
      )}
    >
      <Image
        src={photo.src}
        alt={photo.alt}
        fill
        sizes={sizes}
        priority={priority}
        placeholder="blur"
        className="object-cover transition duration-700 group-hover:scale-[1.04]"
      />
    </div>
  );
}

/** Asymmetric photo mosaic — deliberately unequal, so it reads as a spread. */
export function PhotoMosaic({ photos }: { photos: Photo[] }) {
  const [lead, ...rest] = photos;
  if (!lead) return null;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:grid-rows-2">
      <PhotoFrame
        photo={lead}
        sizes="(min-width: 640px) 50vw, 100vw"
        className="aspect-[4/3] lg:col-span-2 lg:row-span-2 lg:aspect-auto"
      />
      {rest.map((photo) => (
        <PhotoFrame
          key={photo.alt}
          photo={photo}
          sizes="(min-width: 1024px) 25vw, (min-width: 640px) 50vw, 100vw"
          className="aspect-[4/3]"
        />
      ))}
    </div>
  );
}

/**
 * A statistic that counts up as it scrolls into view via a registered CSS
 * custom property — no JavaScript, no hydration, no layout shift. Generated
 * content is not reliably announced, so the real value ships as sr-only text.
 */
export function StatValue({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  // "200+" counts; "2011" does not — a founding year ticking up from zero
  // reads as a bug rather than a flourish.
  const parts = /^(\d{1,3})(\D*)$/.exec(value);

  if (!parts) {
    return <span className={className}>{value}</span>;
  }

  const [, digits, suffix] = parts;

  return (
    <span className={className}>
      <span className="sr-only">{value}</span>
      <span
        aria-hidden="true"
        className="count-up"
        style={{ "--to": Number(digits) } as React.CSSProperties}
      />
      <span aria-hidden="true">{suffix}</span>
    </span>
  );
}

/**
 * Scrolling ribbon. Two identical halves make the -50% loop seamless; the clone
 * is hidden from assistive tech. Pauses on hover and focus-within (WCAG 2.2.2),
 * and under reduced motion becomes a plain wrapped list rather than a frozen
 * track parked off-screen inside its own overflow-hidden box.
 */
export function Marquee({ items }: { items: readonly string[] }) {
  const row = (clone: boolean) => (
    <ul aria-hidden={clone || undefined} className="flex shrink-0 items-center">
      {items.map((item) => (
        <li
          key={item}
          className="font-display text-navy/90 flex items-center text-lg font-bold whitespace-nowrap sm:text-xl"
        >
          {item}
          <span
            aria-hidden="true"
            className="bg-gold-bright mx-7 size-1.5 sm:mx-10"
          />
        </li>
      ))}
    </ul>
  );

  return (
    <div className="border-hairline bg-sand border-y py-5">
      <ul className="max-w-content mx-auto hidden flex-wrap items-center gap-x-8 gap-y-2 px-5 motion-reduce:flex sm:px-6">
        {items.map((item) => (
          <li
            key={item}
            className="font-display text-navy/90 text-lg font-bold sm:text-xl"
          >
            {item}
          </li>
        ))}
      </ul>

      {/* tabIndex makes the pause reachable. The CSS pauses on hover AND on
          focus-within, but nothing inside this strip is focusable, so without
          it a keyboard user has no way to stop motion that runs past five
          seconds (WCAG 2.2.2). */}
      <div
        tabIndex={0}
        role="group"
        aria-label="What membership includes. Hold focus here to pause the scrolling."
        className="marquee-viewport overflow-hidden motion-reduce:hidden"
      >
        <div className="marquee-track">
          {row(false)}
          {row(true)}
        </div>
      </div>
    </div>
  );
}
