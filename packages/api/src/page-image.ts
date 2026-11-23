/** What an uploaded page image is stored as. The table CHECK must stay at 1048576. */
export const PAGE_IMAGE_MAX_STORED_BYTES = 1024 * 1024;
/** Wider images are scaled down to this on upload. The table CHECK allows 1600. */
export const PAGE_IMAGE_MAX_WIDTH = 1600;

/** The public URL of an uploaded page image, for Markdown. The id is never reused and the bytes never change. */
export function pageImageUrl(id: string) {
  return `/page-image/${encodeURIComponent(id)}`;
}
