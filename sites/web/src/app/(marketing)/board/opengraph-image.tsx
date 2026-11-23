import { renderShareCard } from "~/lib/share-card";

export const alt = "Board | SASE at Georgia Tech";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return renderShareCard({
    label: "Board",
    title: "Meet the board.",
    subtitle: "The students who run SASE GT.",
  });
}
