import { renderShareCard } from "~/lib/share-card";

export const alt = "Discord | SASE at Georgia Tech";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return renderShareCard({
    label: "Discord",
    title: "Join the Discord.",
    subtitle: "Where the chapter talks between meetings.",
  });
}
