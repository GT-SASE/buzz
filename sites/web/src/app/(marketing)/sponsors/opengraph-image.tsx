import { renderShareCard } from "~/lib/share-card";

export const alt = "Sponsors | SASE at Georgia Tech";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return renderShareCard({
    label: "Sponsors",
    title: "Sponsors.",
    subtitle: "Put your company in front of hundreds of Georgia Tech students.",
  });
}
