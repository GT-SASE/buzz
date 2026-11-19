"use client";

import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogProvider,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";

export function ConfirmDialogContent({
  open,
  onOpenChange,
  title,
  body,
  action,
  onConfirm,
  danger,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  body: React.ReactNode;
  action: React.ReactNode;
  onConfirm: () => void;
  danger: boolean;
}) {
  return (
    <AlertDialogProvider value={{ isOpen: open, setIsOpen: onOpenChange }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className={
              danger
                ? "bg-destructive hover:bg-destructive/90 text-white"
                : undefined
            }
          >
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialogProvider>
  );
}
