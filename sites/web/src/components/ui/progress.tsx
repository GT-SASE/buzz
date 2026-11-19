"use client";

// Local edit of vendored Watermelon UI: framer-motion replaced with CSS (data-state + tw-animate-css) to keep it out of the client bundle.

import * as React from "react";
import { Progress as ProgressPrime } from "radix-ui";
import { cn } from "~/lib/utils";

type ProgressProps = ProgressPrimitiveProps;

function Progress({ className, ...props }: ProgressProps) {
  return (
    <ProgressPrimitive
      className={cn(
        "bg-primary/20 relative h-2 w-full overflow-hidden rounded-full",
        className,
      )}
      {...props}
    >
      <ProgressIndicatorPrimitive className="bg-primary h-full w-full flex-1 rounded-full" />
    </ProgressPrimitive>
  );
}

export { Progress, type ProgressProps };

type ProgressContextType = {
  value: number;
};

const [ProgressProvider, useProgress] =
  getStrictContext<ProgressContextType>("ProgressContext");

type ProgressPrimitiveProps = React.ComponentProps<typeof ProgressPrime.Root>;

function ProgressPrimitive(props: ProgressPrimitiveProps) {
  return (
    <ProgressProvider value={{ value: props.value ?? 0 }}>
      <ProgressPrime.Root data-slot="progress" {...props} />
    </ProgressProvider>
  );
}

type ProgressIndicatorProps = React.ComponentProps<
  typeof ProgressPrime.Indicator
>;

function ProgressIndicatorPrimitive({
  className,
  style,
  ...props
}: ProgressIndicatorProps) {
  const { value } = useProgress();

  return (
    <ProgressPrime.Indicator
      data-slot="progress-indicator"
      className={cn(
        "transition-transform duration-500 ease-out motion-reduce:transition-none",
        className,
      )}
      style={{ transform: `translateX(-${100 - (value || 0)}%)`, ...style }}
      {...props}
    />
  );
}

function getStrictContext<T>(
  name?: string,
): readonly [
  ({
    value,
    children,
  }: {
    value: T;
    children?: React.ReactNode;
  }) => React.JSX.Element,
  () => T,
] {
  const Context = React.createContext<T | undefined>(undefined);

  const Provider = ({
    value,
    children,
  }: {
    value: T;
    children?: React.ReactNode;
  }) => <Context.Provider value={value}>{children}</Context.Provider>;

  const useSafeContext = () => {
    const ctx = React.useContext(Context);
    if (ctx === undefined) {
      throw new Error(`useContext must be used within ${name ?? "a Provider"}`);
    }
    return ctx;
  };

  return [Provider, useSafeContext] as const;
}

export { getStrictContext };
