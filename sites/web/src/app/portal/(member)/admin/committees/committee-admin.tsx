"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Action } from "~/app/portal/_components/controls";
import {
  formatEventTime,
  fromLocalInputValue,
  toLocalInputValue,
} from "~/app/portal/_lib/format";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import { api, type RouterOutputs } from "~/trpc/react";
import { CommitteeInbox } from "./committee-inbox";
import { defaultCycle } from "./default-cycle";
import { revalidateCommitteeRecruiting } from "./revalidate-recruiting";

type Cycles = RouterOutputs["committee"]["cycles"];
type Cycle = Cycles["cycles"][number];

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function useRefresh() {
  const utils = api.useUtils();
  return () =>
    Promise.all([
      utils.committee.cycles.invalidate(),
      utils.committee.mine.invalidate(),
      revalidateCommitteeRecruiting(),
    ]);
}

function OpenCycle({ label }: { label: string }) {
  const refresh = useRefresh();
  const [closes, setCloses] = useState(() =>
    toLocalInputValue(new Date(Date.now() + 2 * WEEK_MS)),
  );
  const open = api.committee.openCycle.useMutation({
    onSuccess: async () => {
      toast.success(`${label} applications are open.`);
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <form
      className="border-hairline bg-paper/80 grid gap-4 rounded-xl border p-5 sm:grid-cols-[1fr_auto] sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        open.mutate({ closesAt: fromLocalInputValue(closes) });
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="cycle-closes">
          {label} applications close (Atlanta time)
        </Label>
        <Input
          id="cycle-closes"
          type="datetime-local"
          required
          value={closes}
          onChange={(event) => setCloses(event.target.value)}
          className="text-base tabular-nums"
        />
      </div>
      <Action type="submit" tone="primary" disabled={open.isPending}>
        {open.isPending ? "Opening..." : `Open ${label} applications`}
      </Action>
    </form>
  );
}

function CycleSettings({ cycle }: { cycle: Cycle }) {
  const refresh = useRefresh();
  const [closes, setCloses] = useState(() => toLocalInputValue(cycle.closesAt));
  const update = api.committee.setCycleCloses.useMutation({
    onSuccess: async () => {
      toast.success("Close date saved.");
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <div className="border-hairline bg-paper/80 rounded-xl border p-5">
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant={cycle.open ? "default" : "secondary"}>
          {cycle.open ? "Open" : "Closed"}
        </Badge>
        <p className="text-ink-muted text-body-sm">
          {cycle.open ? "Closes" : "Closed"} {formatEventTime(cycle.closesAt)}
        </p>
      </div>
      <form
        className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          update.mutate({
            id: cycle.id,
            closesAt: fromLocalInputValue(closes),
          });
        }}
      >
        <div className="grid gap-2">
          <Label htmlFor={`closes-${cycle.id}`}>
            Close date (Atlanta time)
          </Label>
          <Input
            id={`closes-${cycle.id}`}
            type="datetime-local"
            required
            value={closes}
            onChange={(event) => setCloses(event.target.value)}
            className="text-base tabular-nums"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Action type="submit" tone="solid" disabled={update.isPending}>
            Save date
          </Action>
          {cycle.open && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Action tone="danger" disabled={update.isPending}>
                  Close now
                </Action>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Close {cycle.label} applications now?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    Members can no longer apply or edit. You can reopen by
                    setting a later close date.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() =>
                      update.mutate({ id: cycle.id, closesAt: new Date() })
                    }
                    className="bg-destructive hover:bg-destructive/90 text-white"
                  >
                    Close applications
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </form>
    </div>
  );
}

export function CommitteeAdmin() {
  const cycles = api.committee.cycles.useQuery();
  const [picked, setPicked] = useState<string | null>(null);

  if (cycles.isPending) {
    return <Skeleton className="h-24 w-full rounded-xl" />;
  }
  if (cycles.error) {
    return <p className="text-destructive">{cycles.error.message}</p>;
  }

  const data = cycles.data;
  const selectedId = picked ?? defaultCycle(data);
  const selected = data.cycles.find((cycle) => cycle.id === selectedId);
  const currentExists = data.cycles.some((cycle) => cycle.id === data.current);

  return (
    <>
      {data.cycles.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <Label htmlFor="committee-cycle">Cycle</Label>
          <Select value={selectedId} onValueChange={setPicked}>
            <SelectTrigger
              id="committee-cycle"
              className="h-auto min-h-11 w-48"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {data.cycles.map((cycle) => (
                <SelectItem key={cycle.id} value={cycle.id}>
                  {cycle.label} · {cycle.applications}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {!currentExists && (
        <div className="mb-8">
          <OpenCycle label={data.currentLabel} />
        </div>
      )}

      {selected && (
        <div className="mb-8">
          <CycleSettings key={selected.id} cycle={selected} />
        </div>
      )}

      {selected ? (
        <CommitteeInbox cycle={selected.id} />
      ) : (
        <p className="text-ink-muted text-body">
          No applications yet. Open {data.currentLabel} applications above and
          members can apply from the portal.
        </p>
      )}
    </>
  );
}
