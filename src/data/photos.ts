/**
 * Chapter photography, from the existing chapter site at
 * sites.gatech.edu/gtsase. Imported statically rather than referenced by path
 * so Next knows each file's real dimensions at build time — that is what makes
 * `placeholder="blur"` and zero layout shift possible.
 *
 * Alt text describes what is actually in each frame. No one is named, because
 * the roster behind these photos is not confirmed.
 * TODO: swap in current-year photography as the chapter shoots it.
 */

import boardPortrait from "../../public/photos/board-portrait.jpg";
import campusTabling from "../../public/photos/campus-tabling.jpg";
import chinatownTrip from "../../public/photos/chinatown-trip.jpg";
import conventionDelegation from "../../public/photos/convention-delegation.jpeg";
import conventionLetters from "../../public/photos/convention-letters.jpg";
import generalBody from "../../public/photos/general-body.jpg";
import hawksNight from "../../public/photos/hawks-night.jpg";
import origamiSocial from "../../public/photos/origami-social.jpg";
import serviceCards from "../../public/photos/service-cards.jpeg";
import workshop from "../../public/photos/workshop.jpg";

export const photos = {
  conventionDelegation: {
    src: conventionDelegation,
    alt: "Around twenty SASE GT members posing behind giant SASE letters at the national convention, making heart shapes with their hands.",
  },
  generalBody: {
    src: generalBody,
    alt: "A lecture hall packed with SASE GT members in business attire, seated across every row.",
  },
  boardPortrait: {
    src: boardPortrait,
    alt: "Six SASE GT officers in business attire standing together indoors.",
  },
  workshop: {
    src: workshop,
    alt: "A SASE GT member presenting a public-speaking workshop slide to students in a Georgia Tech classroom.",
  },
  conventionLetters: {
    src: conventionLetters,
    alt: "Seven SASE GT members with conference badges standing behind giant SASE letters.",
  },
  campusTabling: {
    src: campusTabling,
    alt: "SASE GT members gathered around an outdoor table on campus at a calligraphy activity in autumn.",
  },
  hawksNight: {
    src: hawksNight,
    alt: "SASE GT members standing on the court in red shirts during an Atlanta Hawks game.",
  },
  serviceCards: {
    src: serviceCards,
    alt: "Two members resting their chins on their hands behind a table covered in dozens of handmade greeting cards.",
  },
  origamiSocial: {
    src: origamiSocial,
    alt: "A circle of hands each holding a folded paper origami heart in a different colour.",
  },
  chinatownTrip: {
    src: chinatownTrip,
    alt: "Nine SASE GT members posing under the Chinatown gate on a chapter trip.",
  },
} as const;

export type Photo = (typeof photos)[keyof typeof photos];

/** The homepage mosaic. Ordered for shape, not chronology. */
export const galleryPhotos: Photo[] = [
  photos.conventionLetters,
  photos.campusTabling,
  photos.origamiSocial,
  photos.hawksNight,
  photos.chinatownTrip,
];
