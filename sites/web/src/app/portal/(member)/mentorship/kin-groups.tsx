"use client";

import { toast } from "sonner";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { api, type RouterOutputs } from "~/trpc/react";

type Group = RouterOutputs["mentorship"]["groups"][number];

function seatsLabel(group: Group) {
  if (group.capacity === null) return `${group.memberCount} in group`;
  return `${group.memberCount} of ${group.capacity} seats`;
}

export function KinGroups({
  signedUp,
  year,
}: {
  signedUp: boolean;
  year: string;
}) {
  const utils = api.useUtils();
  const groups = api.mentorship.groups.useQuery();
  const myGroup = api.mentorship.myGroup.useQuery();

  const refresh = () =>
    Promise.all([
      utils.mentorship.mine.invalidate(),
      utils.mentorship.groups.invalidate(),
      utils.mentorship.myGroup.invalidate(),
    ]);

  const join = api.mentorship.joinGroup.useMutation({
    onSuccess: async () => {
      toast.success("Welcome to your kin group.");
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const leave = api.mentorship.leaveGroup.useMutation({
    onSuccess: async () => {
      toast.success("You left the group.");
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  if (groups.isPending || myGroup.isPending) {
    return (
      <div className="mt-12 grid gap-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-28 w-full rounded-xl" />
      </div>
    );
  }

  if (groups.error) {
    return <p className="text-destructive mt-12">{groups.error.message}</p>;
  }

  const mine = myGroup.data ?? null;
  const all = groups.data ?? [];
  const standings = [...all]
    .filter((group) => group.memberCount > 0)
    .sort((a, b) => b.points - a.points);
  const busy = join.isPending || leave.isPending;

  return (
    <>
      {mine && (
        <section aria-labelledby="my-kin-group" className="mt-12">
          <p className="text-eyebrow tracking-caps text-gold-ink font-semibold uppercase">
            Your kin group
          </p>
          <h2
            id="my-kin-group"
            className="font-display text-navy text-h3 mt-2 font-bold tracking-tight"
          >
            {mine.name}
          </h2>
          {mine.description && (
            <p className="text-ink-muted text-body mt-2">{mine.description}</p>
          )}
          <ul className="border-hairline divide-hairline mt-5 divide-y rounded-xl border">
            {mine.members.map((member) => (
              <li
                key={member.userId}
                className="flex items-start justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="text-navy font-semibold">
                    {member.name ?? member.email}
                  </p>
                  <a
                    href={`mailto:${member.email}`}
                    className="text-ink-muted text-body-sm hover:text-navy break-all underline-offset-2 hover:underline"
                  >
                    {member.email}
                  </a>
                </div>
                <div className="shrink-0 text-right">
                  <Badge variant="secondary" className="capitalize">
                    {member.role}
                  </Badge>
                  <p className="text-ink-muted text-body-sm mt-1 tabular-nums">
                    {member.points} pts
                  </p>
                </div>
              </li>
            ))}
          </ul>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => leave.mutate()}
            className="text-ink-muted mt-3 h-11 px-0"
          >
            Leave this group
          </Button>
        </section>
      )}

      <section aria-labelledby="kin-groups" className="mt-12">
        <h2
          id="kin-groups"
          className="font-display text-navy text-h3 font-bold tracking-tight"
        >
          {mine ? "All kin groups" : "Pick a kin group"}
          <span className="text-ink-muted ml-2 text-base font-semibold">
            {year}
          </span>
        </h2>
        <p className="text-ink-muted text-body-sm mt-2">
          {mine
            ? "Leave your group first if you want to switch."
            : signedUp
              ? "Join an open group with room. Invite-only groups are placed by an officer."
              : "Sign up above first, then join a group."}
        </p>

        {all.length === 0 ? (
          <p className="text-ink-muted text-body mt-6">
            No kin groups yet. Officers set them up at the start of the
            semester.
          </p>
        ) : (
          <ul className="mt-6 grid gap-4">
            {all.map((group) => {
              const full =
                group.capacity !== null && group.memberCount >= group.capacity;
              const isMine = mine?.id === group.id;
              const canJoin = signedUp && !mine && group.isOpen && !full;

              return (
                <li
                  key={group.id}
                  className="border-hairline bg-paper/80 rounded-xl border p-5 shadow-xs"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-display text-navy text-lg font-bold">
                      {group.name}
                    </p>
                    <Badge
                      variant="secondary"
                      className="shrink-0 font-semibold"
                    >
                      {isMine
                        ? "Your group"
                        : !group.isOpen
                          ? "Invite-only"
                          : full
                            ? "Full"
                            : "Open"}
                    </Badge>
                  </div>
                  {group.description && (
                    <p className="text-ink-muted text-body-sm mt-2">
                      {group.description}
                    </p>
                  )}
                  <p className="text-ink-muted text-body-sm mt-3">
                    {seatsLabel(group)} ·{" "}
                    <span className="text-navy font-semibold tabular-nums">
                      {group.points} KIN pts
                    </span>
                  </p>
                  {group.mentors.length > 0 && (
                    <p className="text-ink-muted text-body-sm mt-1">
                      Mentors: {group.mentors.join(", ")}
                    </p>
                  )}
                  {canJoin && (
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={() => join.mutate({ groupId: group.id })}
                      className="bg-navy hover:bg-navy-deep mt-4 min-h-11 font-semibold text-white"
                    >
                      Join {group.name}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {standings.length > 1 && (
        <section aria-labelledby="kin-standings" className="mt-12">
          <h2
            id="kin-standings"
            className="font-display text-navy text-h3 font-bold tracking-tight"
          >
            Group standings
          </h2>
          <ol className="border-hairline divide-hairline mt-5 divide-y rounded-xl border">
            {standings.map((group, index) => (
              <li
                key={group.id}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <span className="text-navy min-w-0 font-semibold">
                  <span className="text-ink-muted mr-3 tabular-nums">
                    {index + 1}
                  </span>
                  {group.name}
                </span>
                <span className="text-navy shrink-0 font-bold tabular-nums">
                  {group.points}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}
