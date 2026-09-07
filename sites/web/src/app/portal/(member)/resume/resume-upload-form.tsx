"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { formatDate } from "~/app/portal/_lib/format";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Skeleton } from "~/components/ui/skeleton";
import { api, type RouterOutputs } from "~/trpc/react";

type Mine = RouterOutputs["resume"]["mine"];

export function ResumeUploadForm() {
  const mine = api.resume.mine.useQuery();

  if (mine.isPending) {
    return (
      <div
        aria-busy="true"
        aria-live="polite"
        className="mx-auto w-full max-w-lg px-5 py-10 sm:px-6 sm:py-14"
      >
        <span className="sr-only">Loading resume.</span>
        <Skeleton className="h-4 w-24 rounded-full" />
        <Skeleton className="mt-3 h-10 w-64 rounded-lg" />
        <Skeleton className="mt-4 h-16 w-full rounded-lg" />
        <Skeleton className="mt-8 h-28 w-full rounded-lg" />
      </div>
    );
  }

  if (mine.error) {
    return (
      <p className="text-destructive mx-auto max-w-lg px-5 py-10">
        {mine.error.message}
      </p>
    );
  }

  return <ResumeFields row={mine.data} />;
}

function ResumeFields({ row }: { row: Mine }) {
  const utils = api.useUtils();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = api.resume.remove.useMutation({
    onSuccess: async () => {
      toast.success("Resume removed.");
      setFile(null);
      await utils.resume.mine.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      setError("Choose a PDF to upload.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch("/api/portal/resume", {
        method: "POST",
        body,
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "Could not upload that resume.");
      }
      toast.success("Resume saved.");
      setFile(null);
      (event.target as HTMLFormElement).reset();
      await utils.resume.mine.invalidate();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not upload that resume.";
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-lg px-5 py-10 sm:px-6 sm:py-14">
      <p className="text-eyebrow tracking-caps text-gold-ink font-semibold uppercase">
        Resume book
      </p>
      <h1 className="font-display text-navy text-h2 mt-3 font-bold tracking-tight">
        Upload your resume.
      </h1>
      <p className="text-ink-muted text-body mt-4">
        PDF only, 2 MB or less. Officers use this for the member resume book —
        it is not posted on the public site.
      </p>

      {row && (
        <div className="border-hairline bg-cream mt-8 rounded-lg border px-5 py-5">
          <p className="text-navy font-semibold">{row.fileName}</p>
          <p className="text-ink-muted text-body-sm mt-2">
            {row.byteSize < 1024
              ? `${row.byteSize} B`
              : `${(row.byteSize / 1024).toFixed(0)} KB`}{" "}
            · uploaded {formatDate(row.uploadedAt)}
          </p>
          <a
            href="/api/portal/resume"
            className="text-navy decoration-gold mt-3 inline-flex min-h-11 items-center font-semibold underline decoration-2 underline-offset-4"
          >
            Download the file on record
          </a>
        </div>
      )}

      <form className="mt-8 grid gap-6" onSubmit={onSubmit}>
        <div>
          <Label htmlFor="resume-file">PDF</Label>
          <Input
            id="resume-file"
            type="file"
            accept="application/pdf,.pdf"
            disabled={busy}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setError(null);
            }}
            className="border-hairline mt-2 text-base"
          />
        </div>

        <Button
          type="submit"
          disabled={busy || !file}
          className="bg-navy hover:bg-navy-deep h-12 w-full rounded-md font-semibold text-white sm:w-auto"
        >
          {busy ? "Saving..." : row ? "Replace resume" : "Upload resume"}
        </Button>
      </form>

      {row && (
        <Button
          type="button"
          variant="ghost"
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
          className="text-ink-muted mt-4 h-11 px-0"
        >
          Remove resume
        </Button>
      )}

      {error && (
        <Alert variant="destructive" className="border-hairline mt-6">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
