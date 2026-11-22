import { renderShareCard } from "~/lib/share-card";

export const alt = "Contact | SASE at Georgia Tech";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return renderShareCard({
    label: "Contact",
    title: "Reach the chapter.",
    subtitle: "Three ways in, depending on who you are.",
  });
}
