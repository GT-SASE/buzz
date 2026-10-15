import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The theme's custom font sizes (text-body-sm, text-h3, ...) must be known as
// sizes, or twMerge files them as colours and drops text-navy / text-gold-ink.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "eyebrow",
            "body-sm",
            "body",
            "lead",
            "h1",
            "h2",
            "h3",
            "hero",
            "stat",
            "numeral",
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
