/** The projector view has an audience, not a user: no tab rail, no header, no footer. */
export default function PresentLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
