import "server-only";

import {
  HEADSHOT_MAX_STORED_BYTES,
  HEADSHOT_MAX_UPLOAD_BYTES,
  HEADSHOT_SIZE,
} from "@buzz/api";
import { processImage } from "~/lib/image-upload";

/** A board headshot: always a small square WebP. */
export function processHeadshot(bytes: Uint8Array) {
  return processImage(bytes, {
    maxUploadBytes: HEADSHOT_MAX_UPLOAD_BYTES,
    maxStoredBytes: HEADSHOT_MAX_STORED_BYTES,
    resize: (image) =>
      image.resize(HEADSHOT_SIZE, HEADSHOT_SIZE, {
        fit: "cover",
        position: "attention",
      }),
    quality: 82,
    noun: "Photos",
  });
}
