"use client";

import { useEffect, useState } from "react";

import { Skeleton } from "~/components/ui/skeleton";
import { site } from "~/data/site";
import { cn } from "~/lib/utils";

/** Fragment, not query: the bearer must not land in server logs or Referer. */
export function checkInQrUrl(origin: string, code: string) {
  return `${origin}/portal/check-in#code=${code}`;
}

/**
 * True black on white, with a wide quiet zone. Navy-on-cream on a projector
 * washes out under room lights and phones refuse the code until the lights
 * go off.
 */
export const CHECK_IN_QR_RENDER = {
  errorCorrectionLevel: "M" as const,
  margin: 4,
  width: 1024,
  color: { dark: "#000000ff", light: "#ffffffff" },
};

export function CheckInQr({
  code,
  className,
  label = "Check-in QR code",
}: {
  code: string;
  className?: string;
  label?: string;
}) {
  const url = checkInQrUrl(site.url, code);
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const { toDataURL } = await import("qrcode");
      const png = await toDataURL(url, CHECK_IN_QR_RENDER);
      if (!cancelled) setQr(png);
    })();

    return () => {
      cancelled = true;
    };
  }, [url]);

  if (!qr) {
    return (
      <Skeleton
        className={cn("aspect-square rounded-none bg-white/10", className)}
      />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={qr}
      alt={label}
      className={cn("bg-white object-contain", className)}
    />
  );
}
