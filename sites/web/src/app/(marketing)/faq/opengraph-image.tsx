import { renderShareCard } from "~/lib/share-card";

export const alt = "FAQ | SASE at Georgia Tech";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return renderShareCard({
    label: "FAQ",
    title: "Questions, answered.",
    subtitle: "How to join, what it costs, when we meet, and how points work.",
  });
}
