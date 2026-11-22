import { renderShareCard } from "~/lib/share-card";

export const alt = "Join | SASE at Georgia Tech";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return renderShareCard({
    label: "Join",
    title: "Join SASE GT.",
    subtitle:
      "Open to every Georgia Tech student: any major, any year, any background.",
  });
}
