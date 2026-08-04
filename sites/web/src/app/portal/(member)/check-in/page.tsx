import { Section } from "~/app/_components/ui";
import { PortalHeader } from "~/app/portal/_components/portal-ui";
import { requireSession } from "~/app/portal/_lib/session";
import { CheckInForm } from "./check-in-form";

export default async function CheckInPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;

  // Carry the code through sign-in: a member who scans a poster while signed
  // out must land back here with the field still filled, not on a blank form.
  await requireSession(
    code
      ? `/portal/check-in?code=${encodeURIComponent(code)}`
      : "/portal/check-in",
  );

  return (
    <>
      <PortalHeader
        eyebrow="Check in"
        title="Enter the code."
        body="Officers put it on the screen at the start of the event. It is eight characters and it is not case sensitive."
      />

      <Section size="sm">
        <div className="max-w-md">
          <CheckInForm initialCode={code ?? ""} />
        </div>
      </Section>
    </>
  );
}
