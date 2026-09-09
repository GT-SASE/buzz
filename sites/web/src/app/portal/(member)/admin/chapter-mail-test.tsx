"use client";

import { toast } from "sonner";

import { Action } from "~/app/portal/_components/controls";
import { api } from "~/trpc/react";

export function ChapterMailTest() {
  const status = api.mail.configured.useQuery();
  const sendTest = api.mail.sendTest.useMutation({
    onSuccess: (result) => {
      toast.success(`Sent a test to ${result.to}.`);
    },
    onError: (error) => toast.error(error.message),
  });

  if (status.isPending) return null;

  const from = status.data?.from ?? "SASE GT <onboarding@resend.dev>";
  const to = status.data?.testTo ?? "gt@saseconnect.org";
  const ready = status.data?.configured === true;

  return (
    <div className="border-hairline bg-paper/80 rounded-xl border p-5 shadow-xs">
      <p className="text-eyebrow tracking-caps text-ink-muted font-semibold uppercase">
        Chapter mail
      </p>
      <p className="text-ink-muted text-body-sm mt-2">
        Tests go to {to}. From {from}.
      </p>
      {!ready && (
        <p className="text-ink-muted text-body-sm mt-2">
          Add RESEND_API_KEY in .env from https://resend.com/api-keys.
        </p>
      )}
      <div className="mt-4">
        <Action
          tone="primary"
          disabled={!ready || sendTest.isPending}
          onClick={() => sendTest.mutate()}
        >
          {sendTest.isPending ? "Sending..." : `Email ${to}`}
        </Action>
      </div>
    </div>
  );
}
