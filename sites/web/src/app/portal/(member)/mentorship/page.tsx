import type { Metadata } from "next";

import { requireSession } from "~/app/portal/_lib/session";
import { Toaster } from "~/components/ui/sonner";
import { MentorshipSignup } from "./mentorship-signup";

export const metadata: Metadata = {
  title: "SASE KIN",
};

export default async function MentorshipPage() {
  await requireSession("/portal/mentorship");

  return (
    <>
      <MentorshipSignup />
      <Toaster position="bottom-center" />
    </>
  );
}
