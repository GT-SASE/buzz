import { renderShareCard } from "~/lib/share-card";

export const alt = "About | SASE at Georgia Tech";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return renderShareCard({
    label: "About",
    title: "About SASE GT.",
    subtitle:
      "The Georgia Tech chapter of the Society of Asian Scientists and Engineers.",
  });
}
