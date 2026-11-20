/**
 * Reads a request body up to a limit, keeping the exact bytes. The body comes
 * from an unauthenticated caller, so nothing here trusts the declared length.
 */

/** A missing length is allowed, because the read enforces the limit anyway. */
export function isDeclaredLengthWithin(
  contentLength: string | null,
  limit: number,
): boolean {
  if (contentLength === null) {
    return true;
  }
  return /^\d{1,15}$/.test(contentLength) && Number(contentLength) <= limit;
}

/**
 * Stops reading and returns undefined as soon as the body passes the limit.
 * Leaving the loop early cancels the stream.
 */
export async function readBodyWithin(
  request: Request,
  limit: number,
): Promise<Uint8Array | undefined> {
  if (request.body === null) {
    return new Uint8Array();
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of request.body as ReadableStream<Uint8Array>) {
    length += chunk.byteLength;
    if (length > limit) {
      return undefined;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
