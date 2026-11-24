"use client";

import { useState, type FormEvent } from "react";
import { FileInput, FileInputTrigger } from "@ui-sdk/react/file-input";
import { toast } from "sonner";

import { InitialDisc } from "~/components/site/brand";
import { Button } from "~/components/ui/button";
import { api } from "~/trpc/react";

const ACCEPT = ["image/jpeg", "image/png", "image/webp"];
// The server still enforces the limit.
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Shown only to members on the current board: the public board page shows
 * the photo they upload here, cropped to a square, or their initials until
 * they do. Account avatars are never shown there.
 */
export function HeadshotSettings({ name }: { name: string }) {
  const utils = api.useUtils();
  const mine = api.headshot.mine.useQuery();
  const [file, setFile] = useState<File | null>(null);
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
      setFile(null);
      await utils.headshot.mine.invalidate();
    } catch {
      toast.error("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
          <FileInput
            accept={ACCEPT}
            maxSize={MAX_BYTES}
            disabled={busy}
            value={file ? [file] : []}
            onValueChange={(value) => setFile(value[0] ?? null)}
            onReject={() =>
              toast.error("Use a JPEG, PNG or WebP image up to 5 MB.")
            }
          >
            <div className="flex min-w-0 items-center gap-3">
              <FileInputTrigger
                aria-label={
                  file ? "Replace board photo file" : "Choose a photo"
                }
                className="border-hairline text-navy hover:bg-cream focus-visible:ring-navy min-h-11 shrink-0 rounded-lg border bg-transparent px-4 font-semibold focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50"
              >
                {file ? "Replace file" : "Choose File"}
              </FileInputTrigger>
              <span className="text-body-sm min-w-0 truncate">
                {file?.name ?? "No file chosen"}
              </span>
            </div>
          </FileInput>
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
