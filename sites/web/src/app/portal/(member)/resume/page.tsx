import type { Metadata } from "next";
import { Suspense } from "react";

import { requireSession } from "~/app/portal/_lib/session";
import { Toaster } from "~/components/ui/sonner";
import { HydrateClient, api } from "~/trpc/server";
import PortalLoading from "../loading";
import { ResumeUploadForm } from "./resume-upload-form";

export const metadata: Metadata = {
  title: "Resume",
};

export default function ResumePage() {
  return (
    <Suspense fallback={<PortalLoading />}>
      <ResumeBody />
    </Suspense>
  );
}

async function ResumeBody() {
  await requireSession("/portal/resume");
  await api.resume.mine();

  return (
    <HydrateClient>
      <ResumeUploadForm />
      <Toaster position="bottom-center" />
    </HydrateClient>
  );
}
