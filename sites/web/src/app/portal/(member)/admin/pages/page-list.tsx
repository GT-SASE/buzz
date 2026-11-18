"use client";

import Link from "next/link";

import { Action } from "~/app/portal/_components/controls";
import { EmptyState } from "~/app/portal/_components/portal-ui";
import { formatDate } from "~/app/portal/_lib/format";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { api } from "~/trpc/react";

export function PageList() {
  const pages = api.page.list.useQuery();

  if (pages.isPending) return <Skeleton className="h-40 w-full" />;
  if (pages.isError) {
    return (
      <p className="text-destructive text-body-sm">{pages.error.message}</p>
    );
  }

  return (
    <div className="grid gap-6">
      <div className="flex justify-end">
        <Action asChild tone="primary">
          <Link href="/portal/admin/pages/new">New page</Link>
        </Action>
      </div>
      {pages.data.length === 0 ? (
        <EmptyState
          title="No pages yet"
          body="Create one to publish something on the public site without a code change."
        />
      ) : (
        <ul role="list" className="border-hairline border-t">
          {pages.data.map((page) => (
            <li key={page.id} className="border-hairline border-b">
              <Link
                href={`/portal/admin/pages/${page.id}`}
                className="hover:bg-cream flex flex-wrap items-center gap-x-4 gap-y-1 px-2 py-4 transition"
              >
                <span className="text-navy text-body font-semibold">
                  {page.title}
                </span>
                <span className="text-ink-muted text-body-sm">
                  /{page.slug}
                </span>
                <Badge
                  variant={page.published ? "default" : "secondary"}
                  className="ml-auto"
                >
                  {page.published ? "Published" : "Draft"}
                </Badge>
                <span className="text-ink-muted text-body-sm tabular-nums">
                  Updated {formatDate(page.updatedAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
