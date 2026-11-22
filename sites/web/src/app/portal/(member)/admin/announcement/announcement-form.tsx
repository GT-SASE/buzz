"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Action, Field, inputClass } from "~/app/portal/_components/controls";
import { Skeleton } from "~/components/ui/skeleton";
import { api, type RouterOutputs } from "~/trpc/react";
import { HREF_MAX, LABEL_MAX, MESSAGE_MAX } from "./limits";
import { revalidateAnnouncement } from "./revalidate-announcement";

export function AnnouncementForm() {
  const saved = api.announcement.get.useQuery();

  if (saved.isPending) return <Skeleton className="h-96 w-full" />;
  if (saved.isError) {
    return (
      <p className="text-destructive text-body-sm">{saved.error.message}</p>
    );
  }
  return (
    <AnnouncementFields
      key={saved.data.updatedAt?.getTime() ?? "new"}
      saved={saved.data}
    />
  );
}

function AnnouncementFields({
  saved,
}: {
  saved: RouterOutputs["announcement"]["get"];
}) {
  const utils = api.useUtils();
  const [draft, setDraft] = useState({
    enabled: saved.enabled,
    message: saved.message,
    linkLabel: saved.linkLabel,
    linkHref: saved.linkHref,
  });
  const set = <K extends keyof typeof draft>(
    key: K,
    value: (typeof draft)[K],
  ) => setDraft((current) => ({ ...current, [key]: value }));

  const save = api.announcement.set.useMutation({
    onSuccess: async () => {
      toast.success(
        draft.enabled ? "Banner is live." : "Banner saved and switched off.",
      );
      await Promise.all([
        utils.announcement.get.invalidate(),
        revalidateAnnouncement(),
      ]);
    },
    // A refused input arrives as a JSON list of issues; show the first sentence.
    onError: (error) =>
      toast.error(error.data?.zodError?.formErrors[0] ?? error.message),
  });

  const message = draft.message.trim();
  const showsLink =
    draft.linkLabel.trim() !== "" && draft.linkHref.trim() !== "";

  return (
    <form
      className="grid gap-8 lg:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (message === "") return;
        save.mutate({ ...draft, message });
      }}
    >
      <div className="grid content-start gap-5">
        <Field
          label="Message"
          htmlFor="banner-message"
          hint={`${draft.message.length} of ${MESSAGE_MAX}`}
        >
          <textarea
            id="banner-message"
            required
            rows={3}
            maxLength={MESSAGE_MAX}
            value={draft.message}
            onChange={(event) => set("message", event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field
          label="Link label"
          htmlFor="banner-link-label"
          hint="Optional. Leave the label and the address empty for no link."
        >
          <input
            id="banner-link-label"
            maxLength={LABEL_MAX}
            value={draft.linkLabel}
            onChange={(event) => set("linkLabel", event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field
          label="Link address"
          htmlFor="banner-link-href"
          hint="/events for a page on this site, or a full https:// address."
        >
          <input
            id="banner-link-href"
            maxLength={HREF_MAX}
            value={draft.linkHref}
            onChange={(event) => set("linkHref", event.target.value)}
            className={inputClass}
          />
        </Field>
        <label className="text-navy flex min-h-11 items-center gap-3 text-sm font-semibold">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => set("enabled", event.target.checked)}
            className="size-5"
          />
          Show the banner on the public site
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <Action
            type="submit"
            tone="primary"
            disabled={save.isPending || message === ""}
          >
            {save.isPending ? "Saving..." : "Save banner"}
          </Action>
        </div>
      </div>

      <section aria-label="Preview" className="min-w-0">
        <p className="text-eyebrow tracking-caps text-ink-muted font-semibold uppercase">
          Preview{draft.enabled ? "" : " (switched off)"}
        </p>
        <div className="bg-navy text-body-sm mt-2 rounded-lg px-5 py-3 leading-snug text-white">
          {message || "Your message appears here."}
          {showsLink && (
            <>
              {" "}
              <span className="text-gold-bright font-semibold underline decoration-2 underline-offset-4">
                {draft.linkLabel.trim()}
              </span>
            </>
          )}
        </div>
      </section>
    </form>
  );
}
