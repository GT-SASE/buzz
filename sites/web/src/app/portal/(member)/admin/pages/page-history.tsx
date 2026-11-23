"use client";

import { toast } from "sonner";

import { Action } from "~/app/portal/_components/controls";
import { ConfirmDialog } from "~/app/portal/_components/confirm-dialog";
import { formatEventTime } from "~/app/portal/_lib/format";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { api } from "~/trpc/react";

const stateLabel = {
  live: "Live",
  published: "Published earlier",
  draft: "Draft",
  replaced: "Replaced draft",
} as const;

export function PageHistory({ pageId }: { pageId: string }) {
  const utils = api.useUtils();
  const versions = api.page.versions.useQuery({ id: pageId });
  const restore = api.page.restore.useMutation({
    onSuccess: async ({ number }) => {
      toast.success(
        `Restored as draft v${number}. Publish it to make it live.`,
      );
      await Promise.all([
        utils.page.versions.invalidate(),
        utils.page.byId.invalidate(),
        utils.page.list.invalidate(),
      ]);
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <section aria-label="Version history" className="grid gap-3">
      <h2 className="font-display text-navy text-h3 font-bold tracking-tight">
        Version history
      </h2>
      {versions.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : versions.isError ? (
        <p className="text-destructive text-body-sm">
          {versions.error.message}
        </p>
      ) : versions.data.length === 0 ? (
        <p className="text-ink-muted text-body-sm">No versions yet.</p>
      ) : (
        <ul role="list" className="border-hairline border-t">
          {versions.data.map((version) => (
            <li
              key={version.number}
              className="border-hairline flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-2 py-3"
            >
              <span className="text-navy text-body font-semibold tabular-nums">
                v{version.number}
              </span>
              <span className="text-body-sm min-w-0 flex-1">
                {version.title}
                <span className="text-ink-muted"> /{version.slug}</span>
                {version.restoredFrom !== null && (
                  <span className="text-ink-muted">
                    {" "}
                    restored from v{version.restoredFrom}
                  </span>
                )}
              </span>
              <Badge
                variant={version.state === "live" ? "default" : "secondary"}
              >
                {stateLabel[version.state]}
              </Badge>
              <span className="text-ink-muted text-body-sm">
                {formatEventTime(version.publishedAt ?? version.updatedAt)}
                {(version.authorName ?? version.authorEmail) &&
                  `, ${version.authorName ?? version.authorEmail}`}
              </span>
              {version.state !== "draft" && (
                <ConfirmDialog
                  title={`Restore v${version.number}?`}
                  body="Its text becomes a new draft. The live page does not change until you publish, and any draft you have open stays in the history."
                  action="Restore as draft"
                  onConfirm={() =>
                    restore.mutate({ id: pageId, number: version.number })
                  }
                >
                  <Action disabled={restore.isPending}>Restore</Action>
                </ConfirmDialog>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
