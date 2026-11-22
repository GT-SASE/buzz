import { renderShareCard } from "~/lib/share-card";

export const alt = "Website team | SASE at Georgia Tech";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return renderShareCard({
    label: "Web team",
    title: "Join the website team.",
    subtitle: "Build the chapter site and Buzz, the member portal.",
  });
}
