import { requireOfficer } from "~/app/portal/_lib/session";
import { Toaster } from "~/components/ui/sonner";

/**
 * Officer-only subtree.
 *
 * Server-side so there is no flash of an admin screen and no client spinner
 * state. This is UX; `adminProcedure` is the gate that actually matters, and
 * every procedure under here carries it independently.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireOfficer("/portal/admin");
  return (
    <>
      {children}
      <Toaster position="bottom-center" />
    </>
  );
}
