import Image, { type StaticImageData } from "next/image";

import { cn } from "~/lib/utils";

/** The strap a badge hangs from: navy and gold, cut to a taper. */
export function Strap({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("flex flex-col items-center", className)}
    >
      <div className="lanyard-strap relative z-10 -mb-5 h-24 w-16" />
      <div className="relative z-20 -mb-1.5 h-6 w-7 rounded-md bg-[#8b97a3]" />
    </div>
  );
}

/**
 * A convention badge on its lanyard: the home page's hero object, and the
 * shape the member card in the portal shares.
 */
export function LanyardBadge({
  photo,
  year,
  next,
  className,
}: {
  photo: { src: StaticImageData; alt: string };
  year: string;
  next: { title: string; when: string; where: string | null } | null;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center", className)}>
      <Strap />
      <article className="border-hairline bg-paper relative w-full max-w-[24rem] -rotate-2 overflow-hidden rounded-[1.375rem] border shadow-[0_1px_0_var(--hairline),0_18px_40px_-18px_rgb(15_31_48/0.35)]">
        <div
          aria-hidden="true"
          className="border-hairline bg-cream mx-auto mt-4 h-3 w-[4.5rem] rounded-full border"
        />
        <div className="bg-navy mt-3.5 flex items-baseline justify-between gap-3 px-5 py-4 text-white">
          <span className="font-display text-xl font-bold">SASE GT</span>
          <span className="text-[0.8125rem] text-white/75">
            Member · {year}
          </span>
        </div>
        <div className="relative aspect-[4/3]">
          <Image
            src={photo.src}
            alt={photo.alt}
            fill
            priority
            sizes="(min-width: 1024px) 24rem, 90vw"
            placeholder="blur"
            className="object-cover"
          />
        </div>
        <div className="px-5 pt-4">
          <p className="text-ink-muted text-[0.8125rem] font-semibold">
            Hello, my name is
          </p>
          <p className="font-display text-navy mt-1 text-[2.125rem] leading-tight font-bold">
            You, probably.
          </p>
        </div>
        <ul className="flex flex-wrap gap-2 px-5 pt-3">
          {["Free", "Any major", "No application"].map((tag) => (
            <li
              key={tag}
              className="bg-cream text-navy rounded-full px-2.5 py-1 text-[0.8125rem] font-bold"
            >
              {tag}
            </li>
          ))}
        </ul>
        <div className="border-sand mx-5 mt-4 mb-5 border-t-2 border-dashed pt-3.5">
          {next ? (
            <>
              <p className="text-navy font-extrabold">
                {next.title} · {next.when}
              </p>
              <p className="text-ink-muted text-body-sm">
                {next.where ? `${next.where} · ` : ""}RSVP and it goes on your
                calendar
              </p>
            </>
          ) : (
            <p className="text-navy font-extrabold">
              General body meetings every few weeks
            </p>
          )}
        </div>
      </article>
    </div>
  );
}
