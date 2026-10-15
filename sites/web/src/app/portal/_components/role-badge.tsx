import type { UserRole } from "@buzz/db";

import { roleLabel } from "~/app/portal/_lib/roles";
import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";

/** One pill for the roster, the member card, and the CSV's sibling on screen. */
export function RoleBadge({
  role,
  className,
}: {
  role: UserRole;
  className?: string;
}) {
  if (role === "SUPER_ADMIN") {
    return (
      <Badge
        className={cn(
          "bg-navy text-gold-bright border-transparent font-semibold shadow-none",
          className,
        )}
      >
        {roleLabel(role)}
      </Badge>
    );
  }

  if (role === "ADMIN") {
    return (
      <Badge
        className={cn(
          "bg-gold-bright text-navy border-transparent font-semibold shadow-none",
          className,
        )}
      >
        {roleLabel(role)}
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className={cn("border-hairline text-ink-muted font-semibold", className)}
    >
      {roleLabel(role)}
    </Badge>
  );
}
