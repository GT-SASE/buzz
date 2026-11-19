"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { lazy, Suspense, useState } from "react";
import { toast } from "sonner";

import { Action, Field, inputClass } from "~/app/portal/_components/controls";
import { ConfirmDialog } from "~/app/portal/_components/confirm-dialog";
import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";
import { pageSlugProblem, slugFromTitle } from "@buzz/api/page-slug";
import { revalidatePages } from "./revalidate-pages";

const Markdown = lazy(() =>
  import("~/components/site/markdown").then((m) => ({ default: m.Markdown })),
);

type Draft = {
  title: string;
  slug: string;
  description: string;
  body: string;
  published: boolean;
};

const blank: Draft = {
  title: "",
  slug: "",
  description: "",
  body: "",
  published: false,
};

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
    <PageForm key={existing.data.updatedAt.getTime()} saved={existing.data} />
  );
}

function PageForm({ saved }: { saved: RouterOutputs["page"]["byId"] | null }) {
  const router = useRouter();
  const utils = api.useUtils();
  const [draft, setDraft] = useState<Draft>(saved ?? blank);
  const [slugEdited, setSlugEdited] = useState(saved !== null);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const problem = draft.slug === "" ? null : pageSlugProblem(draft.slug);
  const invalid =
    draft.title.trim() === "" || pageSlugProblem(draft.slug) !== null;

  const afterWrite = async (slugs: string[]) => {
    await Promise.all([
      utils.page.list.invalidate(),
      utils.page.byId.invalidate(),
      revalidatePages(slugs),
    ]);
  };

  const create = api.page.create.useMutation({
    onSuccess: async (page) => {
      toast.success("Page saved.");
      await afterWrite([page.slug]);
      router.replace(`/portal/admin/pages/${page.id}`);
    },
    onError: (error) => toast.error(error.message),
  });
  const update = api.page.update.useMutation({
    onSuccess: async ({ page, previousSlug }) => {
      toast.success("Page saved.");
      await afterWrite([page.slug, previousSlug]);
    },
    onError: (error) => toast.error(error.message),
  });
  const remove = api.page.delete.useMutation({
    onSuccess: async ({ slug }) => {
      toast.success("Page deleted.");
      await afterWrite([slug]);
      router.replace("/portal/admin/pages");
    },
    onError: (error) => toast.error(error.message),
  });

  const saving = create.isPending || update.isPending;

  return (
    <form
      className="grid gap-8 lg:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (invalid) return;
        const fields = { ...draft, title: draft.title.trim() };
        if (saved) update.mutate({ id: saved.id, ...fields });
        else create.mutate(fields);
      }}
    >
      <div className="grid content-start gap-5">
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
                slug: slugEdited ? current.slug : slugFromTitle(title),
              }));
            }}
            className={inputClass}
          />
        </Field>
        <Field
          label="URL"
          htmlFor="page-slug"
          hint={problem ?? `Published at /${draft.slug || "your-url"}`}
        >
          <input
            id="page-slug"
            required
            value={draft.slug}
            aria-invalid={problem !== null}
            onChange={(event) => {
              setSlugEdited(true);
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
          hint="Headings, lists, links, tables, and **bold** work. Raw HTML does not."
        >
          <textarea
            id="page-body"
            rows={18}
            maxLength={100_000}
            value={draft.body}
            onChange={(event) => set("body", event.target.value)}
            className={cn(inputClass, "font-mono text-sm")}
          />
        </Field>
        <label className="text-navy flex min-h-11 items-center gap-3 text-sm font-semibold">
          <input
            type="checkbox"
            checked={draft.published}
            onChange={(event) => set("published", event.target.checked)}
            className="size-5"
          />
          Published
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <Action type="submit" tone="primary" disabled={saving || invalid}>
            {saving ? "Saving..." : "Save page"}
          </Action>
          {saved?.published && (
            <Action asChild>
              <Link href={`/${saved.slug}`} target="_blank">
                View live page
              </Link>
            </Action>
          )}
          {saved && (
            <ConfirmDialog
              danger
              title="Delete this page?"
              body={`/${saved.slug} will stop working. This cannot be undone.`}
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
            <p className="text-lead text-ink-muted mt-3">{draft.description}</p>
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
  );
}
