/**
 * Chapter photography for the about and board pages. Imported statically
 * rather than referenced by path so Next knows each file's real dimensions at
 * build time — that is what makes `placeholder="blur"` and zero layout shift
 * possible. The homepage's photos live in photos-home.ts and the Seattle 2026
 * spread in photos-seattle.ts, so no page compiles JPEGs it does not render.
 *
 * Alt text describes what is actually in each frame. No one is named. Drop in
 * newer shoots under /public/photos and update the imports here when they land.
 */

import type { StaticImageData } from "next/image";

import boardPortrait from "../../public/photos/board-portrait.jpg";
import serviceCards from "../../public/photos/service-cards.jpeg";
import workshop from "../../public/photos/workshop.jpg";

export type Photo = {
  src: StaticImageData;
  alt: string;
};

export const photos = {
  boardPortrait: {
    src: boardPortrait,
    alt: "Six SASE GT officers in business attire standing together indoors.",
  },
  workshop: {
    src: workshop,
    alt: "A SASE GT member presenting a public-speaking workshop slide to students in a Georgia Tech classroom.",
  },
  serviceCards: {
    src: serviceCards,
    alt: "Two members resting their chins on their hands behind a table covered in dozens of handmade greeting cards.",
  },
} as const satisfies Record<string, Photo>;
