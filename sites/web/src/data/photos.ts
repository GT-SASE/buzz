/**
 * Chapter photography, from the existing chapter site at
 * sites.gatech.edu/gtsase. Imported statically rather than referenced by path
 * so Next knows each file's real dimensions at build time — that is what makes
 * `placeholder="blur"` and zero layout shift possible.
 *
 * Alt text describes what is actually in each frame. No one is named. Drop in
 * newer shoots under /public/photos and update the imports here when they land.
 */

import type { StaticImageData } from "next/image";

import boardPortrait from "../../public/photos/board-portrait.jpg";
import serviceCards from "../../public/photos/service-cards.jpeg";
import workshop from "../../public/photos/workshop.jpg";
import { galleryPhotos, homePhotos } from "./photos-home";

export { galleryPhotos };

export type Photo = {
  src: StaticImageData;
  alt: string;
};

export const photos = {
  ...homePhotos,
  boardPortrait: {
    src: boardPortrait,
    alt: "Six SASE GT officers in business attire standing together indoors.",
  },
  workshop: {
    src: workshop,
    alt: "A SASE GT member presenting a public-speaking workshop slide to students in a Georgia Tech classroom.",
  },
  conventionLetters: galleryPhotos[0],
  campusTabling: galleryPhotos[1],
  hawksNight: galleryPhotos[3],
  serviceCards: {
    src: serviceCards,
    alt: "Two members resting their chins on their hands behind a table covered in dozens of handmade greeting cards.",
  },
  origamiSocial: galleryPhotos[2],
  chinatownTrip: galleryPhotos[4],
} as const satisfies Record<string, Photo>;
