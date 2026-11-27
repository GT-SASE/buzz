import "server-only";

import { createHash } from "node:crypto";

import sharp, { type Sharp } from "sharp";

import { sniffHeadshotType } from "@buzz/api";

type ProcessedImage = {
  /** The re-encoded WebP, orientation applied, metadata (GPS and all) dropped. */
  webp: Buffer;
  etag: string;
  width: number;
  height: number;
};

type ImageError = { error: string };

type Options = {
  maxUploadBytes: number;
  maxStoredBytes: number;
  /** The resize step; `.rotate()` has already run. */
  resize: (image: Sharp) => Sharp;
  quality: number;
  /** What to call the limits in an error message. */
  noun: string;
};

/**
 * Checks an uploaded image and re-encodes it. The type comes from the file's
 * own bytes, the pixel count is capped so a small file cannot expand into a
 * huge decode, and the output is always a WebP, so what is stored and served
 * is never the uploaded file. Shared by board headshots and page images.
 */
export async function processImage(
  bytes: Uint8Array,
  options: Options,
): Promise<ProcessedImage | ImageError> {
  if (bytes.byteLength === 0) return { error: "The file is empty." };
  if (bytes.byteLength > options.maxUploadBytes) {
    return {
      error: `${options.noun} must be ${Math.round(options.maxUploadBytes / 1024 / 1024)} MB or smaller.`,
    };
  }
  if (!sniffHeadshotType(bytes)) {
    return { error: "Upload a JPEG, PNG or WebP image." };
  }

  let out: { data: Buffer; info: { width: number; height: number } };
  try {
    out = await options
      .resize(
        sharp(bytes, {
          limitInputPixels: 40_000_000,
          animated: false,
        }).rotate(),
      )
      .webp({ quality: options.quality })
      .toBuffer({ resolveWithObject: true });
  } catch {
    return { error: "That image could not be read." };
  }
  if (out.data.byteLength > options.maxStoredBytes) {
    return { error: "That image is too detailed to store. Try another." };
  }
  const etag = createHash("sha256").update(out.data).digest("hex").slice(0, 32);
  return {
    webp: out.data,
    etag,
    width: out.info.width,
    height: out.info.height,
  };
}
