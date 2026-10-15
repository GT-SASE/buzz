import type { UserRole } from "@buzz/db";

/** The words the roster uses. The database value stays MEMBER / ADMIN / SUPER_ADMIN. */
export function roleLabel(role: UserRole): string {
  switch (role) {
    case "SUPER_ADMIN":
      return "Super admin";
    case "ADMIN":
      return "Officer";
    case "MEMBER":
      return "Member";
  }
}
