"use client";

import { toast } from "sonner";

import { ConfirmDialog } from "~/app/portal/_components/confirm-dialog";
import { Action } from "~/app/portal/_components/controls";
import { api } from "~/trpc/react";
import { revalidateBoard } from "./revalidate-board";

/**
 * Who is on the current public board, and a takedown for any headshot a
 * member uploaded. Members add their own from settings; an officer can only
 * remove one, and the removal is logged.
 */
export function BoardPhotos() {
  const utils = api.useUtils();
  const seats = api.headshot.seats.useQuery();
  const remove = api.headshot.remove.useMutation({
    onSuccess: async () => {
      await revalidateBoard();
      toast.success("Photo removed. The board shows their initials.");
      await utils.headshot.seats.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  if (!seats.data || seats.data.length === 0) return null;

  return (
    <section className="border-hairline bg-paper/80 mt-8 rounded-xl border p-5 shadow-xs sm:p-6">
      <h2 className="font-display text-navy text-lg font-bold">
        Public board photos
      </h2>
      <p className="text-ink-muted text-body-sm mt-1">
        Winners add their own photo in portal settings. You can take one down.
      </p>
      <ul className="border-hairline divide-hairline mt-4 divide-y rounded-lg border">
        {seats.data.map((seat) => (
          <li
            key={`${seat.userId}-${seat.role}`}
            className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
          >
            <span className="min-w-0">
              <span className="text-navy font-semibold">{seat.name}</span>
              <span className="text-ink-muted text-body-sm block">
                {seat.role}
                {seat.hasPhoto ? "" : ", no photo yet (shows initials)"}
              </span>
            </span>
            {seat.hasPhoto && (
              <ConfirmDialog
                title={`Remove ${seat.name}'s photo?`}
                body="The public board shows their initials instead. They can upload another from settings."
                action="Remove photo"
                danger
                onConfirm={() => remove.mutate({ userId: seat.userId })}
              >
                <Action tone="danger" disabled={remove.isPending}>
                  Remove photo
                </Action>
              </ConfirmDialog>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
