"use client";

import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";

/**
 * The thing members point a phone at. Encoded in the browser so the encoder is
 * dynamically imported here and never ships to a member's bundle. Error
 * correction is high because this gets projected, photographed at an angle and
 * read across a room.
 */
export function EventQr({ url, code }: { url: string; code: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const { toDataURL } = await import("qrcode");
        const png = await toDataURL(url, {
          errorCorrectionLevel: "H",
          margin: 2,
          width: 512,
          // Navy on parchment rather than pure black on white: it has to read
          // as part of the slide, and the contrast is still far past what a
          // scanner needs.
          color: { dark: "#003057ff", light: "#fdfaf4ff" },
        });
        if (!cancelled) setDataUrl(png);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url]);

  // The code beside it is the fallback that always works, so a failed encode
  // is a missing convenience rather than a broken door.
  if (failed) return null;

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="bg-paper border-hairline grid h-44 w-44 place-items-center rounded-lg border p-2 sm:h-52 sm:w-52">
        {dataUrl ? (
          // A data: URL generated in this component, so there is nothing for
          // next/image to fetch, optimise or cache.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={dataUrl}
            alt={`QR code for check-in code ${code}`}
            className="h-full w-full"
          />
        ) : (
          <>
            <Skeleton className="h-full w-full rounded-md" />
            <span className="sr-only">Drawing...</span>
          </>
        )}
      </div>

      {/* An anchor styled as a button: a <button> nested in an <a> is invalid
          HTML. The filename carries no code — downloads outlive the event. */}
      {dataUrl && (
        <Button
          asChild
          variant="outline"
          size="sm"
          className="border-hairline text-navy hover:bg-cream rounded-full font-semibold"
        >
          <a href={dataUrl} download="check-in-qr.png">
            Download PNG
          </a>
        </Button>
      )}
    </div>
  );
}
