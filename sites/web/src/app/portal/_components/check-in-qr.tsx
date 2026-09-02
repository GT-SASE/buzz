"use client";

import { useEffect, useState } from "react";

import { Skeleton } from "~/components/ui/skeleton";
import { site } from "~/data/site";
import { cn } from "~/lib/utils";

/** Fragment, not query: the bearer must not land in server logs or Referer. */
export function checkInQrUrl(origin: string, code: string) {
  return `${origin}/portal/check-in#code=${code}`;
}

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
      const png = await toDataURL(url, {
        errorCorrectionLevel: "H",
        margin: 1,
        width: 1024,
        color: { dark: "#003057ff", light: "#fdfaf4ff" },
      });
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
      className={cn("bg-paper object-contain", className)}
    />
  );
}
