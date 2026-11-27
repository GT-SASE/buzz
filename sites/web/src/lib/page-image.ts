import "server-only";

import {
  HEADSHOT_MAX_UPLOAD_BYTES,
  PAGE_IMAGE_MAX_STORED_BYTES,
  PAGE_IMAGE_MAX_WIDTH,
} from "@buzz/api";
import { processImage } from "~/lib/image-upload";

/** A page image: scaled down to at most 1600 px wide (never up), WebP. */
export function processPageImage(bytes: Uint8Array) {
  return processImage(bytes, {
    maxUploadBytes: HEADSHOT_MAX_UPLOAD_BYTES,
    maxStoredBytes: PAGE_IMAGE_MAX_STORED_BYTES,
    resize: (image) =>
      image.resize({ width: PAGE_IMAGE_MAX_WIDTH, withoutEnlargement: true }),
    quality: 80,
    noun: "Images",
  });
}
