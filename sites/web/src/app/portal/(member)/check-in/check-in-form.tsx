"use client";

import { CameraOffIcon, OctagonXIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Honeycomb } from "~/app/portal/_components/honeycomb";
import { Eyebrow } from "~/components/site";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Spinner } from "~/components/ui/spinner";
import { site } from "~/data/site";
import { api } from "~/trpc/react";
import { Scanner, codeFromScan } from "./scanner";

function codeFromHash() {
  if (typeof window === "undefined") return "";
  return (
    codeFromScan(
      `${window.location.origin}${window.location.pathname}${window.location.hash}`,
    ) ?? ""
  );
}

export function CheckInForm({ initialCode }: { initialCode: string }) {
  const router = useRouter();
  const utils = api.useUtils();

  /** Set when a QR arrives in the URL, which needs a tap before it fires. */
  const [confirm, setConfirm] = useState(() =>
    (codeFromHash() || initialCode).toUpperCase(),
  );
  /** Why the camera is not on screen, when it could not be started. */
  const [cameraNote, setCameraNote] = useState<string | null>(null);

  // Prefer the fragment (`#code=`) so the bearer never hits the server as a
  // query string. Strip it after the initial read so a refresh cannot re-share.
  useEffect(() => {
    if (!window.location.hash.includes("code=")) return;
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const checkIn = api.event.checkIn.useMutation({
    onSuccess: async (result) => {
      toast.success("Checked in", {
        description: `${result.eventTitle} — +${result.pointsEarned} points`,
      });
      // The dashboard is server-rendered, so both the query cache and the RSC
      // payload have to be told the totals moved.
      await Promise.all([
        utils.event.home.invalidate(),
        utils.event.myStats.invalidate(),
        utils.event.myEvents.invalidate(),
        utils.event.upcoming.invalidate(),
        utils.member.leaderboard.invalidate(),
      ]);
      router.refresh();
    },
    onError: (error) => {
      if (error.data?.code === "UNAUTHORIZED") {
        router.push("/portal/signin?from=/portal/check-in");
        return;
      }
      toast.error("Not checked in", { description: error.message });
    },
  });

  const submit = (code: string) => {
    if (checkIn.isPending) return;
    checkIn.mutate({ code });
  };

  if (checkIn.data) {
    const { eventTitle, pointsEarned, totalPoints, totalEvents } = checkIn.data;

    return (
      <div>
        <Alert
          role="status"
          className="border-navy-deep bg-navy relative overflow-hidden rounded-lg px-6 py-12 text-center text-white"
        >
          <Honeycomb className="absolute inset-0 h-full w-full text-white/[0.07]" />
          <AlertTitle className="text-eyebrow tracking-masthead text-gold-bright relative font-semibold uppercase">
            Checked in
          </AlertTitle>
          <AlertDescription className="relative justify-items-center text-white">
            <p className="font-display text-gold-bright mt-5 text-6xl leading-none font-bold tabular-nums">
              +{pointsEarned}
            </p>
            <p className="font-display mt-6 text-xl font-bold text-white">
              {eventTitle}
            </p>
            <p className="mt-3 text-white/70">
              {totalPoints} points across {totalEvents}{" "}
              {totalEvents === 1 ? "event" : "events"}.
            </p>
          </AlertDescription>
        </Alert>

        <div className="mt-6 flex justify-center">
          <Button
            asChild
            size="lg"
            className="bg-gold-bright text-navy hover:bg-gold text-eyebrow tracking-caps h-auto min-h-12 rounded-md px-6 font-semibold uppercase"
          >
            <Link href="/portal">See your card</Link>
          </Button>
        </div>
      </div>
    );
  }

  // The camera is released the moment a QR is read, so this replaces the
  // viewfinder rather than sitting under it.
  if (checkIn.isPending) {
    return (
      <Card className="border-hairline bg-paper rounded-lg">
        <CardContent
          role="status"
          className="grid justify-items-center gap-4 py-14 text-center"
        >
          <Spinner className="text-gold-bright size-8" />
          <p className="text-ink-muted text-body-sm">Checking you in...</p>
        </CardContent>
      </Card>
    );
  }

  if (checkIn.error?.data?.code === "UNAUTHORIZED") {
    return (
      <Card className="border-hairline bg-paper rounded-lg">
        <CardContent
          role="status"
          className="grid justify-items-center gap-4 py-14 text-center"
        >
          <Spinner className="text-gold-bright size-8" />
          <p className="text-ink-muted text-body-sm">Signing you back in...</p>
        </CardContent>
      </Card>
    );
  }

  if (checkIn.error) {
    return (
      <div>
        <Alert
          variant="destructive"
          className="border-destructive/30 bg-paper rounded-lg"
        >
          <OctagonXIcon />
          <AlertTitle>Not checked in</AlertTitle>
          <AlertDescription>
            <p>{checkIn.error.message}</p>
          </AlertDescription>
        </Alert>

        <Button
          size="lg"
          onClick={() => {
            setConfirm("");
            checkIn.reset();
          }}
          className="bg-gold-bright text-navy hover:bg-gold mt-5 h-auto min-h-12 w-full rounded-md py-6 text-base font-semibold"
        >
          Scan again
        </Button>

        <p className="text-ink-muted text-body-sm mt-6 text-center">
          Ask an officer to add you if it will not go through.
        </p>
      </div>
    );
  }

  // Arrived from the phone's own camera. One tap rather than an automatic
  // submit, because a link preview or a prefetch must never check anyone in.
  if (confirm) {
    return (
      <Card className="border-hairline bg-paper rounded-lg">
        <CardHeader>
          <Eyebrow tone="muted">QR scanned</Eyebrow>
          <CardTitle className="font-display text-navy text-h3 mt-2 font-bold">
            Check in to this event?
          </CardTitle>
        </CardHeader>

        <CardContent>
          <Button
            size="lg"
            onClick={() => submit(confirm)}
            className="bg-gold-bright text-navy hover:bg-gold h-auto min-h-12 w-full rounded-md py-6 text-base font-semibold"
          >
            Check in
          </Button>

          <div className="mt-6 flex justify-center">
            <Button
              variant="ghost"
              onClick={() => setConfirm("")}
              className="text-ink-muted hover:text-navy hover:bg-cream text-body-sm min-h-11 rounded-md font-semibold"
            >
              Scan a different QR
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (cameraNote) {
    return (
      <Card className="border-hairline bg-paper rounded-lg">
        <CardContent className="py-10">
          <Alert
            variant="destructive"
            className="border-destructive/30 bg-paper rounded-lg"
          >
            <CameraOffIcon />
            <AlertTitle>The scanner cannot start</AlertTitle>
            <AlertDescription>
              <p>{cameraNote}</p>
            </AlertDescription>
          </Alert>

          <p className="text-ink-muted text-body-sm mt-6">
            Point your phone&rsquo;s own camera at the QR on the screen — it
            opens this page ready to check in. Otherwise ask an officer to add
            you, or email{" "}
            <a
              href={`mailto:${site.email}`}
              className="text-navy inline-flex min-h-11 items-center underline"
            >
              {site.email}
            </a>
            .
          </p>

          <Button
            variant="outline"
            onClick={() => setCameraNote(null)}
            className="border-hairline text-navy hover:bg-cream mt-6 min-h-11 w-full rounded-md"
          >
            Try the camera again
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-hairline bg-paper rounded-lg">
      <CardHeader>
        <Eyebrow tone="gold">Check in</Eyebrow>
        <CardTitle className="font-display text-navy text-h3 mt-2 font-bold">
          Scan the QR code.
        </CardTitle>
        <CardDescription className="text-ink-muted text-body-sm">
          It is on the screen at the front of the room.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <Scanner onDetect={submit} onUnavailable={setCameraNote} />
      </CardContent>
    </Card>
  );
}
