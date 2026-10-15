import Image from "next/image";
import { cn } from "~/lib/utils";

/** The SASE emblem. `tile` sets it on white so it reads on navy and ink. */
export function SaseMark({
  tile = false,
  className,
}: {
  tile?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-grid size-10 shrink-0 place-items-center",
        tile && "rounded-lg bg-white p-1",
        className,
      )}
    >
      <Image
        src="/brand/sase-emblem.png"
        alt=""
        width={80}
        height={80}
        className="h-full w-full object-contain"
      />
    </span>
  );
}

/**
 * The chapter mascot. Size it with a height class; the width follows. `flip`
 * mirrors it so it can face the content.
 */
export function SaseDino({
  flip = false,
  className,
}: {
  flip?: boolean;
  className?: string;
}) {
  return (
    <Image
      src="/brand/sase-dino.png"
      alt=""
      aria-hidden
      width={636}
      height={759}
      className={cn("h-24 w-auto shrink-0", flip && "-scale-x-100", className)}
    />
  );
}
