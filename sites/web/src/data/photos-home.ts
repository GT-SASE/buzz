/**
 * Photographs the homepage actually renders. Kept in its own module so compiling
 * `/` does not also decode the about/board JPEGs.
 */

import campusTabling from "../../public/photos/campus-tabling.jpg";
import chinatownTrip from "../../public/photos/chinatown-trip.jpg";
import conventionDelegation from "../../public/photos/convention-delegation.jpeg";
import generalBody from "../../public/photos/general-body.jpg";
import hawksNight from "../../public/photos/hawks-night.jpg";
import origamiSocial from "../../public/photos/origami-social.jpg";
import seattleDelegation from "../../public/photos/seattle-delegation.jpg";

export const homePhotos = {
  conventionDelegation: {
    src: conventionDelegation,
    alt: "Around twenty SASE GT members posing behind giant SASE letters at the national convention, making heart shapes with their hands.",
  },
  generalBody: {
    src: generalBody,
    alt: "A lecture hall packed with SASE GT members in business attire, seated across every row.",
  },
} as const;

export const galleryPhotos = [
  {
    src: seattleDelegation,
    alt: "Around twenty-five SASE GT members in business attire and conference badges posing on a wide concrete staircase under a skylight, on the chapter's October 2026 trip to Seattle.",
  },
  {
    src: campusTabling,
    alt: "SASE GT members gathered around an outdoor table on campus at a calligraphy activity in autumn.",
  },
  {
    src: origamiSocial,
    alt: "A circle of hands each holding a folded paper origami heart in a different colour.",
  },
  {
    src: hawksNight,
    alt: "SASE GT members standing on the court in red shirts during an Atlanta Hawks game.",
  },
  {
    src: chinatownTrip,
    alt: "Nine SASE GT members posing under the Chinatown gate on a chapter trip.",
  },
] as const;
