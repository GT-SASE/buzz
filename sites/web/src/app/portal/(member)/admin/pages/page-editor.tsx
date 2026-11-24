"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { lazy, Suspense, useRef, useState } from "react";
import { toast } from "sonner";

import { Action, Field, inputClass } from "~/app/portal/_components/controls";
import { ConfirmDialog } from "~/app/portal/_components/confirm-dialog";
import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";
import { pageSlugProblem, slugFromTitle } from "@buzz/api/page-slug";
import { PageHistory } from "./page-history";
import { revalidatePages } from "./revalidate-pages";

const Markdown = lazy(() =>
  import("~/components/site/markdown").then((m) => ({ default: m.Markdown })),
);

type Draft = {
  title: string;
  slug: string;
  description: string;
  body: string;
};

const blank: Draft = { title: "", slug: "", description: "", body: "" };

export function PageEditor({ pageId }: { pageId?: string }) {
  const existing = api.page.byId.useQuery(
    { id: pageId ?? "" },
    { enabled: pageId !== undefined },
  );

  if (pageId === undefined) return <PageForm saved={null} />;
  if (existing.isPending) return <Skeleton className="h-96 w-full" />;
  if (existing.isError) {
    return (
      <p className="text-destructive text-body-sm">{existing.error.message}</p>
    );
  }
  return (
    <PageForm
      key={`${existing.data.draft.number}-${existing.data.draft.updatedAt.getTime()}-${existing.data.published}`}
      saved={existing.data}
    />
  );
}

function PageForm({ saved }: { saved: RouterOutputs["page"]["byId"] | null }) {
  const router = useRouter();
  const utils = api.useUtils();
  const [draft, setDraft] = useState<Draft>(
    saved
      ? {
          title: saved.draft.title,
          slug: saved.draft.slug,
          description: saved.draft.description,
          body: saved.draft.body,
        }
      : blank,
  );
  const slugEdited = useRef(saved !== null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const problem = draft.slug === "" ? null : pageSlugProblem(draft.slug);
  const invalid =
    draft.title.trim() === "" || pageSlugProblem(draft.slug) !== null;

  const refresh = (slugs: string[] = []) =>
    Promise.all([
      ...(slugs.length > 0 ? [revalidatePages(slugs)] : []),
      utils.page.list.invalidate(),
      utils.page.byId.invalidate(),
      utils.page.versions.invalidate(),
    ]);

  const fail = (error: { message: string }) => toast.error(error.message);

  const create = api.page.create.useMutation({ onError: fail });
  const saveDraft = api.page.saveDraft.useMutation({ onError: fail });
  const publish = api.page.publish.useMutation({ onError: fail });
  const unpublish = api.page.unpublish.useMutation({
    onSuccess: async ({ revalidate }) => {
      toast.success("Page taken down. It is a draft again.");
      await refresh(revalidate);
    },
    onError: fail,
  });
  const remove = api.page.delete.useMutation({
    onSuccess: async ({ revalidate }) => {
      toast.success("Page deleted.");
      await Promise.all([
        revalidatePages(revalidate),
        utils.page.list.invalidate(),
      ]);
      router.replace("/portal/admin/pages");
    },
    onError: fail,
  });

  const fields = () => ({
    slug: draft.slug,
    title: draft.title.trim(),
    description: draft.description,
    body: draft.body,
  });

  /** Save the text, and publish it when asked. A new page is created first. */
  const submit = async (andPublish: boolean) => {
    if (invalid) return;
    try {
      let id = saved?.id;
      let published: { revalidate: string[] } | undefined;
      if (id) await saveDraft.mutateAsync({ id, ...fields() });
      else id = (await create.mutateAsync(fields())).id;
      if (andPublish) {
        published = await publish.mutateAsync({ id });
        toast.success(`Published at /${published.slug}.`);
      } else {
        toast.success("Draft saved. The public page is unchanged.");
      }
      await refresh(published?.revalidate);
      if (!saved) router.replace(`/portal/admin/pages/${id}`);
    } catch {
      // The mutation's onError already showed the message.
    }
  };

  const busy =
    create.isPending ||
    saveDraft.isPending ||
    publish.isPending ||
    unpublish.isPending;

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.set("file", file);
      const response = await fetch("/api/admin/page-image", {
        method: "POST",
        body: form,
      });
      const result = (await response.json()) as {
        url?: string;
        error?: string;
      };
      if (!response.ok || !result.url) {
        toast.error(result.error ?? "The upload failed.");
        return;
      }
      const alt = file.name.replace(/\.[^.]+$/, "").replace(/[[\]]/g, "");
      const markdown = `![${alt}](${result.url})`;
      const area = bodyRef.current;
      const start = area?.selectionStart ?? draft.body.length;
      const end = area?.selectionEnd ?? draft.body.length;
      setDraft((current) => {
        // An image is a block: keep it on its own paragraph.
        const before = current.body.slice(0, start);
        const after = current.body.slice(end);
        const lead = before && !before.endsWith("\n\n") ? "\n\n" : "";
        const trail = after && !after.startsWith("\n\n") ? "\n\n" : "";
        return {
          ...current,
          body: `${before}${lead}${markdown}${trail}${after}`,
        };
      });
      toast.success("Image added. Edit its description in the text.");
    } catch {
      toast.error("The upload failed.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const status = !saved
    ? "New page. Not on the public site."
    : saved.published
      ? saved.hasDraft
        ? `Live at /${saved.liveSlug}, with unpublished changes.`
        : `Live at /${saved.liveSlug}.`
      : "Draft. Not on the public site.";

  return (
    <div className="grid gap-10">
      <form
        className="grid gap-8 lg:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
      >
        <div className="grid content-start gap-5">
          <p
            className="text-navy text-body-sm font-semibold"
            data-testid="page-status"
          >
            {status}
          </p>
          <Field label="Title" htmlFor="page-title">
            <input
              id="page-title"
              required
              maxLength={200}
              value={draft.title}
              onChange={(event) => {
                const title = event.target.value;
                setDraft((current) => ({
                  ...current,
                  title,
                  slug: slugEdited.current
                    ? current.slug
                    : slugFromTitle(title),
                }));
              }}
              className={inputClass}
            />
          </Field>
          <Field
            label="URL"
            htmlFor="page-slug"
            hint={
              problem ??
              (saved?.published && draft.slug !== saved.liveSlug
                ? `Moves from /${saved.liveSlug} to /${draft.slug} when you publish; the old address redirects.`
                : `Published at /${draft.slug || "your-url"}`)
            }
          >
            <input
              id="page-slug"
              required
              value={draft.slug}
              aria-invalid={problem !== null}
              onChange={(event) => {
                slugEdited.current = true;
                set("slug", event.target.value);
              }}
              className={cn(inputClass, problem && "border-destructive")}
            />
          </Field>
          <Field
            label="Description"
            htmlFor="page-description"
            hint="Shown under the title and in link previews."
          >
            <input
              id="page-description"
              maxLength={300}
              value={draft.description}
              onChange={(event) => set("description", event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field
            label="Body (Markdown)"
            htmlFor="page-body"
            hint="Headings, lists, links, tables, images, and **bold** work. Raw HTML does not."
          >
            <textarea
              id="page-body"
              ref={bodyRef}
              rows={18}
              maxLength={100_000}
              value={draft.body}
              onChange={(event) => set("body", event.target.value)}
              className={cn(inputClass, "font-mono text-sm")}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileRef}
              id="page-image-file"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              aria-label="Image file"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
              }}
            />
            <Action
              type="button"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? "Uploading..." : "Insert image"}
            </Action>
            <span className="text-ink-muted text-body-sm">
              JPEG, PNG or WebP up to 5 MB. Scaled to 1600 px wide.
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Action type="submit" disabled={busy || invalid}>
              {saveDraft.isPending || create.isPending
                ? "Saving..."
                : "Save draft"}
            </Action>
            <Action
              type="button"
              tone="primary"
              disabled={busy || invalid}
              onClick={() => void submit(true)}
            >
              {publish.isPending ? "Publishing..." : "Publish"}
            </Action>
            {saved?.published && (
              <>
                <Action asChild>
                  <Link href={`/${saved.liveSlug}`} target="_blank">
                    View live page
                  </Link>
                </Action>
                <ConfirmDialog
                  title="Take this page down?"
                  body={`/${saved.liveSlug} stops showing the page. The text and history stay, and you can publish it again.`}
                  action="Take down"
                  onConfirm={() => unpublish.mutate({ id: saved.id })}
                >
                  <Action disabled={busy}>Unpublish</Action>
                </ConfirmDialog>
              </>
            )}
            {saved && (
              <ConfirmDialog
                danger
                title="Delete this page?"
                body={`/${saved.liveSlug} will stop working, and its history and redirects are deleted. This cannot be undone.`}
                action="Delete page"
                onConfirm={() => remove.mutate({ id: saved.id })}
              >
                <Action tone="danger" disabled={remove.isPending}>
                  Delete
                </Action>
              </ConfirmDialog>
            )}
          </div>
        </div>

        <section aria-label="Preview" className="min-w-0">
          <p className="text-eyebrow tracking-caps text-ink-muted font-semibold uppercase">
            Preview
          </p>
          <div className="border-hairline mt-2 rounded-xl border p-6">
            <h2 className="font-display text-navy text-h2 font-bold tracking-tight text-balance">
              {draft.title || "Untitled"}
            </h2>
            {draft.description && (
              <p className="text-lead text-ink-muted mt-3">
                {draft.description}
              </p>
            )}
            {draft.body === "" ? (
              <div className="mt-8" />
            ) : (
              <Suspense fallback={<div className="mt-8" />}>
                <Markdown className="mt-8">{draft.body}</Markdown>
              </Suspense>
            )}
          </div>
        </section>
      </form>

      {saved && <PageHistory pageId={saved.id} />}
    </div>
  );
}
