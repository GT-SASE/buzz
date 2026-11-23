import "server-only";

import { createHash } from "node:crypto";

import sharp from "sharp";

import {
  HEADSHOT_MAX_STORED_BYTES,
  HEADSHOT_MAX_UPLOAD_BYTES,
  HEADSHOT_SIZE,
  sniffHeadshotType,
} from "@buzz/api";

export type ProcessedHeadshot = {
  /** A 400 px square WebP, orientation applied, metadata (GPS and all) dropped. */
  webp: Buffer;
  etag: string;
};

export type HeadshotError = { error: string };

/**
 * Checks an uploaded image and re-encodes it. The type comes from the file's
 * own bytes, the pixel count is capped so a small file cannot expand into a
 * huge decode, and the output is always a small square WebP, so what is
 * stored and served is never the uploaded file.
 */
export async function processHeadshot(
  bytes: Uint8Array,
): Promise<ProcessedHeadshot | HeadshotError> {
  if (bytes.byteLength === 0) return { error: "The file is empty." };
  if (bytes.byteLength > HEADSHOT_MAX_UPLOAD_BYTES) {
    return { error: "Photos must be 5 MB or smaller." };
  }
  if (!sniffHeadshotType(bytes)) {
    return { error: "Upload a JPEG, PNG or WebP image." };
  }

  let webp: Buffer;
  try {
    webp = await sharp(bytes, { limitInputPixels: 40_000_000, animated: false })
      .rotate()
      .resize(HEADSHOT_SIZE, HEADSHOT_SIZE, {
        fit: "cover",
        position: "attention",
      })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    return { error: "That image could not be read." };
  }
  if (webp.byteLength > HEADSHOT_MAX_STORED_BYTES) {
    return { error: "That image is too detailed to store. Try another." };
  }
  const etag = createHash("sha256").update(webp).digest("hex").slice(0, 32);
  return { webp, etag };
}
