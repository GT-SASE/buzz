/** What a board member may upload: the file as sent, before it is resized. */
export const HEADSHOT_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** The stored image, a 400 px square WebP. The table CHECK must stay at 204800. */
export const HEADSHOT_MAX_STORED_BYTES = 200 * 1024;
export const HEADSHOT_SIZE = 400;

export type HeadshotType = "image/jpeg" | "image/png" | "image/webp";

/**
 * The type a file really is, from its first bytes. The declared type and the
 * file name are ignored: only JPEG, PNG and WebP are accepted.
 */
export function sniffHeadshotType(bytes: Uint8Array): HeadshotType | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) {
    return "image/png";
  }
  const text = (from: number, to: number) =>
    Buffer.from(b.subarray(from, to)).toString("ascii");
  if (b.length >= 12 && text(0, 4) === "RIFF" && text(8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

/** The public URL of a board member's photo. `version` changes with the image, so it can be cached for good. */
export function headshotUrl(userId: string, version: string) {
  return `/board/photo/${encodeURIComponent(userId)}?v=${version}`;
}
