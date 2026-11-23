"use client";

import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { InitialDisc } from "~/components/site/brand";
import { Button } from "~/components/ui/button";
import { api } from "~/trpc/react";

const ACCEPT = "image/jpeg,image/png,image/webp";

/**
 * Shown only to members on the current board: the public board page shows
 * the photo they upload here, cropped to a square, or their initials until
 * they do. Account avatars are never shown there.
 */
export function HeadshotSettings({ name }: { name: string }) {
  const utils = api.useUtils();
  const mine = api.headshot.mine.useQuery();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  if (!mine.data || mine.data.roles.length === 0) return null;
  const { roles, photo } = mine.data;

  async function send(method: "POST" | "DELETE", body?: FormData) {
    setBusy(true);
    try {
      const response = await fetch("/api/portal/headshot", { method, body });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        toast.error(result.error ?? "That did not work. Try again.");
        return;
      }
      toast.success(method === "POST" ? "Photo saved." : "Photo removed.");
      if (input.current) input.current.value = "";
      await utils.headshot.mine.invalidate();
    } catch {
      toast.error("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = input.current?.files?.[0];
    if (!file) {
      toast.error("Choose an image first.");
      return;
    }
    const body = new FormData();
    body.set("file", file);
    void send("POST", body);
  }

  return (
    <div className="mx-auto w-full max-w-lg px-5 pb-14 sm:px-6">
      <h2 className="font-display text-navy text-h3 font-bold tracking-tight">
        Board photo.
      </h2>
      <p className="text-ink-muted text-body-sm mt-2">
        You hold {roles.join(" and ")} on the current board. The public board
        page shows this photo, cropped to a square. Until you add one it shows
        your initials. JPEG, PNG or WebP, up to 5 MB.
      </p>
      <div className="mt-4 flex items-center gap-4">
        <InitialDisc
          label={name}
          photo={photo ?? undefined}
          className="size-20 text-2xl"
        />
        <form className="grid min-w-0 flex-1 gap-3" onSubmit={onSubmit}>
          <label className="grid gap-1">
            <span className="sr-only">Choose a photo</span>
            <input
              ref={input}
              type="file"
              accept={ACCEPT}
              className="text-body-sm file:border-hairline file:text-navy min-h-11 w-full file:mr-3 file:min-h-11 file:rounded-lg file:border file:bg-transparent file:px-4 file:font-semibold"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              disabled={busy}
              className="bg-navy hover:bg-navy-deep min-h-11 text-white"
            >
              {busy ? "Saving..." : photo ? "Replace photo" : "Upload photo"}
            </Button>
            {photo && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                className="min-h-11"
                onClick={() => void send("DELETE")}
              >
                Remove photo
              </Button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
