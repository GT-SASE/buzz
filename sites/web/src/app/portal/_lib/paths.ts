/**
 * Normalises a `from`/`code` value out of a query string.
 *
 * Next resolves a repeated key to an array — `?code=A&code=B` arrives as
 * `["A","B"]` — so anything that types these as `string` is lying, and the
 * first method call on the value throws during render. Taking the first entry
 * is the only sane reading: a duplicated parameter has no second meaning.
 */
export function firstParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Control characters, by code point rather than by a regex holding literal
 * control bytes — those are invisible in a diff and easy to delete by accident.
 */
function hasControlCharacter(value: string) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * A same-origin path, or `/portal`.
 *
 * Rejecting only a leading `//` is not enough. Browsers normalise backslashes
 * to forward slashes in the authority position, so `/\evil.com` is sent as a
 * relative Location header, resolved as protocol-relative, and lands on
 * `https://evil.com` — an open redirect out of a sign-in flow, which is exactly
 * where one is most convincing. Anything whose second character is a slash of
 * either kind is therefore refused.
 */
export function safeRedirectPath(value: string | string[] | undefined) {
  const path = firstParam(value);
  if (typeof path !== "string") return "/portal";

  /**
   * Refused before anything is measured, because the checks below read fixed
   * offsets and a browser does not.
   *
   * Step 2 of the WHATWG URL parser DELETES every ASCII tab, newline and
   * carriage return from the input before parsing it. So `/<TAB>/evil.com`
   * passes all three tests below — its second character is a tab, not a slash —
   * and then becomes `//evil.com` in the browser: protocol-relative, straight
   * off site. Node's header validation permits HTAB, so nothing downstream
   * catches it either. Anything that can shift a slash into position 1 after
   * the fact has to go before position 1 means anything.
   */
  if (hasControlCharacter(path)) return "/portal";

  if (!path.startsWith("/")) return "/portal";
  if (path.startsWith("//") || path.startsWith("/\\")) return "/portal";
  return path;
}
