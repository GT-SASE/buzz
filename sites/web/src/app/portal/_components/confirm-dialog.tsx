"use client";

import { AlertDialog } from "radix-ui";
import { lazy, Suspense, useState } from "react";

const ConfirmDialogContent = lazy(() =>
  import("./confirm-dialog-content").then((m) => ({
    default: m.ConfirmDialogContent,
  })),
);

export function ConfirmDialog({
  children,
  title,
  body,
  action,
  onConfirm,
  danger = false,
}: {
  children: React.ReactElement;
  title: React.ReactNode;
  body: React.ReactNode;
  action: React.ReactNode;
  onConfirm: () => void;
  danger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);

  return (
    <AlertDialog.Root
      data-slot="alert-dialog"
      open={open}
      onOpenChange={(next) => {
        if (next) setOpened(true);
        setOpen(next);
      }}
    >
      <AlertDialog.Trigger data-slot="alert-dialog-trigger" asChild>
        {children}
      </AlertDialog.Trigger>
      {opened && (
        <Suspense fallback={null}>
          <ConfirmDialogContent
            title={title}
            body={body}
            action={action}
            onConfirm={onConfirm}
            danger={danger}
          />
        </Suspense>
      )}
    </AlertDialog.Root>
  );
}
