import type { UserRole } from "@buzz/db";

import { roleLabel } from "~/app/portal/_lib/roles";
import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";

const roleClass = {
  SUPER_ADMIN:
    "bg-navy text-gold-bright border-transparent font-semibold shadow-none",
  ADMIN:
    "bg-gold-bright text-navy border-transparent font-semibold shadow-none",
  MEMBER: "border-hairline text-ink-muted font-semibold",
} satisfies Record<UserRole, string>;

/** One pill for the roster, the member card, and the CSV's sibling on screen. */
export function RoleBadge({
  role,
  className,
}: {
  role: UserRole;
  className?: string;
}) {
  return (
    <Badge
      variant={role === "MEMBER" ? "outline" : undefined}
      className={cn(roleClass[role], className)}
    >
      {roleLabel(role)}
    </Badge>
  );
}
