import { renderShareCard } from "~/lib/share-card";

export const alt = "Programs | SASE at Georgia Tech";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return renderShareCard({
    label: "Programs",
    title: "What a semester here looks like.",
    subtitle: "Six standing programs, every semester.",
  });
}
