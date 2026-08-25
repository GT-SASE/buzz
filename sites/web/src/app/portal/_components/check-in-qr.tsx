"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";

/** Fragment, not query: the bearer must not land in server logs or Referer. */
export function checkInQrUrl(origin: string, code: string) {
  return `${origin}/portal/check-in#code=${code}`;
}

export function usePageOrigin() {
  return useSyncExternalStore(
    () => () => undefined,
    () => window.location.origin,
    () => "",
  );
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
  const origin = usePageOrigin();
  const url = origin ? checkInQrUrl(origin, code) : null;
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    if (!url) {
      setQr(null);
      return;
    }
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
