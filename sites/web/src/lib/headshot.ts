import "server-only";

import {
  HEADSHOT_MAX_STORED_BYTES,
  HEADSHOT_MAX_UPLOAD_BYTES,
  HEADSHOT_SIZE,
} from "@buzz/api";
import { processImage, type ImageError } from "~/lib/image-upload";

export type ProcessedHeadshot = {
  /** A 400 px square WebP, orientation applied, metadata (GPS and all) dropped. */
  webp: Buffer;
  etag: string;
};

export type HeadshotError = ImageError;

/** A board headshot: always a small square WebP. */
export async function processHeadshot(
  bytes: Uint8Array,
): Promise<ProcessedHeadshot | HeadshotError> {
  const processed = await processImage(bytes, {
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
  if ("error" in processed) return processed;
  return { webp: processed.webp, etag: processed.etag };
}
