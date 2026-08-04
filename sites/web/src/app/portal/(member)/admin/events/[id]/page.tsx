import { Section, TextLink } from "~/app/_components/ui";
import { EventAttendance } from "./event-attendance";

export default async function AdminEventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <Section size="sm">
      <div className="mb-8">
        <TextLink href="/portal/admin">Back to all events</TextLink>
      </div>
      <EventAttendance eventId={id} />
    </Section>
  );
}
