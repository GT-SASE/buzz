"use client";

// Local edit of vendored Watermelon UI: framer-motion replaced with CSS (data-state + tw-animate-css) to keep it out of the client bundle.

import * as React from "react";
import { Dialog as DialogPrime } from "radix-ui";
import { XIcon } from "lucide-react";
import { cn } from "~/lib/utils";

type DialogProps = DialogPrimitiveProps;

function Dialog(props: DialogProps) {
  return <DialogPrimitive {...props} />;
}

type DialogTriggerProps = DialogTriggerPrimitiveProps;

function DialogTrigger(props: DialogTriggerProps) {
  return <DialogTriggerPrimitive {...props} />;
}

type DialogCloseProps = DialogClosePrimitiveProps;

function DialogClose(props: DialogCloseProps) {
  return <DialogClosePrimitive {...props} />;
}

type DialogOverlayProps = DialogOverlayPrimitiveProps;

function DialogOverlay({ className, ...props }: DialogOverlayProps) {
  return (
    <DialogOverlayPrimitive
      className={cn("fixed inset-0 z-50 bg-black/50", className)}
      {...props}
    />
  );
}

type DialogContentProps = DialogContentPrimitiveProps & {
  showCloseButton?: boolean;
};

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogContentProps) {
  return (
    <DialogPortalPrimitive>
      <DialogOverlay />
      <DialogContentPrimitive
        className={cn(
          "bg-background fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg sm:max-w-lg",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogClosePrimitive className="ring-offset-background focus:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4">
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogClosePrimitive>
        )}
      </DialogContentPrimitive>
    </DialogPortalPrimitive>
  );
}

type DialogHeaderProps = DialogHeaderPrimitiveProps;

function DialogHeader({ className, ...props }: DialogHeaderProps) {
  return (
    <DialogHeaderPrimitive
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  );
}

type DialogFooterProps = DialogFooterPrimitiveProps;

function DialogFooter({ className, ...props }: DialogFooterProps) {
  return (
    <DialogFooterPrimitive
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

type DialogTitleProps = DialogTitlePrimitiveProps;

function DialogTitle({ className, ...props }: DialogTitleProps) {
  return (
    <DialogTitlePrimitive
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  );
}

type DialogDescriptionProps = DialogDescriptionPrimitiveProps;

function DialogDescription({ className, ...props }: DialogDescriptionProps) {
  return (
    <DialogDescriptionPrimitive
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  type DialogProps,
  type DialogTriggerProps,
  type DialogCloseProps,
  type DialogContentProps,
  type DialogHeaderProps,
  type DialogFooterProps,
  type DialogTitleProps,
  type DialogDescriptionProps,
};

type DialogPrimitiveProps = React.ComponentProps<typeof DialogPrime.Root>;

function DialogPrimitive(props: DialogPrimitiveProps) {
  return <DialogPrime.Root data-slot="dialog" {...props} />;
}

type DialogTriggerPrimitiveProps = React.ComponentProps<
  typeof DialogPrime.Trigger
>;

function DialogTriggerPrimitive(props: DialogTriggerPrimitiveProps) {
  return <DialogPrime.Trigger data-slot="dialog-trigger" {...props} />;
}

type DialogPortalProps = Omit<
  React.ComponentProps<typeof DialogPrime.Portal>,
  "forceMount"
>;

function DialogPortalPrimitive(props: DialogPortalProps) {
  return <DialogPrime.Portal data-slot="dialog-portal" {...props} />;
}

type DialogOverlayPrimitiveProps = Omit<
  React.ComponentProps<typeof DialogPrime.Overlay>,
  "forceMount" | "asChild"
>;

function DialogOverlayPrimitive({
  className,
  ...props
}: DialogOverlayPrimitiveProps) {
  return (
    <DialogPrime.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 duration-200 motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}

type DialogFlipDirection = "top" | "bottom" | "left" | "right";

type DialogContentPrimitiveProps = Omit<
  React.ComponentProps<typeof DialogPrime.Content>,
  "forceMount" | "asChild"
> & {
  from?: DialogFlipDirection;
};

const dialogSlideFrom: Record<DialogFlipDirection, string> = {
  top: "data-[state=open]:slide-in-from-top-4 data-[state=closed]:slide-out-to-top-4",
  bottom:
    "data-[state=open]:slide-in-from-bottom-4 data-[state=closed]:slide-out-to-bottom-4",
  left: "data-[state=open]:slide-in-from-left-4 data-[state=closed]:slide-out-to-left-4",
  right:
    "data-[state=open]:slide-in-from-right-4 data-[state=closed]:slide-out-to-right-4",
};

function DialogContentPrimitive({
  from = "top",
  className,
  ...props
}: DialogContentPrimitiveProps) {
  return (
    <DialogPrime.Content
      data-slot="dialog-content"
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95 duration-300 motion-reduce:animate-none",
        dialogSlideFrom[from],
        className,
      )}
      {...props}
    />
  );
}

type DialogClosePrimitiveProps = React.ComponentProps<typeof DialogPrime.Close>;

function DialogClosePrimitive(props: DialogClosePrimitiveProps) {
  return <DialogPrime.Close data-slot="dialog-close" {...props} />;
}

type DialogHeaderPrimitiveProps = React.ComponentProps<"div">;

function DialogHeaderPrimitive(props: DialogHeaderPrimitiveProps) {
  return <div data-slot="dialog-header" {...props} />;
}

type DialogFooterPrimitiveProps = React.ComponentProps<"div">;

function DialogFooterPrimitive(props: DialogFooterPrimitiveProps) {
  return <div data-slot="dialog-footer" {...props} />;
}

type DialogTitlePrimitiveProps = React.ComponentProps<typeof DialogPrime.Title>;

function DialogTitlePrimitive(props: DialogTitlePrimitiveProps) {
  return <DialogPrime.Title data-slot="dialog-title" {...props} />;
}

type DialogDescriptionPrimitiveProps = React.ComponentProps<
  typeof DialogPrime.Description
>;

function DialogDescriptionPrimitive(props: DialogDescriptionPrimitiveProps) {
  return <DialogPrime.Description data-slot="dialog-description" {...props} />;
}

interface CommonControlledStateProps<T> {
  value?: T;
  defaultValue?: T;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useControlledState<T, Rest extends any[] = []>(
  props: CommonControlledStateProps<T> & {
    onChange?: (value: T, ...args: Rest) => void;
  },
): readonly [T, (next: T, ...args: Rest) => void] {
  const { value, defaultValue, onChange } = props;

  const [internalState, setInternalState] = React.useState<T>(
    value !== undefined ? value : (defaultValue as T),
  );
  const state = value !== undefined ? value : internalState;

  const setState = React.useCallback(
    (next: T, ...args: Rest) => {
      setInternalState(next);
      onChange?.(next, ...args);
    },
    [onChange],
  );

  return [state, setState] as const;
}
