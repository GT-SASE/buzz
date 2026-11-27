/**
 * The chapter's Seattle trip, October 2026, shown on /programs under the
 * conferences it belongs to. Group and place shots only: no frame is about one
 * member. The files were resized to 1920px and saved without EXIF, so they
 * carry no location data.
 */

import type { Photo } from "./photos";
import careerFair from "../../public/photos/seattle-career-fair.jpg";
import escalator from "../../public/photos/seattle-escalator.jpg";
import fountain from "../../public/photos/seattle-fountain.jpg";
import gumWall from "../../public/photos/seattle-gum-wall.jpg";
import waterfront from "../../public/photos/seattle-waterfront.jpg";

export const seattlePhotos = [
  {
    src: careerFair,
    alt: "About a dozen SASE GT members in business attire and conference badges posing together on a crowded career fair floor.",
  },
  {
    src: escalator,
    alt: "Three members wearing conference lanyards smiling for a selfie at the top of an escalator in the convention center.",
  },
  {
    src: waterfront,
    alt: "A large group of members crowded into a selfie on a waterfront walkway, with the Seattle Great Wheel and the bay behind them.",
  },
  {
    src: gumWall,
    alt: "Seven members standing arm in arm in front of Seattle's Gum Wall.",
  },
  {
    src: fountain,
    alt: "Eight members standing at the edge of a fountain pool on a college campus, with a tall jet of water and brick buildings behind.",
  },
] as const satisfies readonly Photo[];
