import { describe, expect, it } from "vitest";

import { firstParam, safeRedirectPath } from "~/app/portal/_lib/paths";

describe("safeRedirectPath", () => {
  it("keeps a same-origin path", () => {
    expect(safeRedirectPath("/portal/events")).toBe("/portal/events");
    expect(safeRedirectPath("/portal/check-in?code=SASEGT26")).toBe(
      "/portal/check-in?code=SASEGT26",
    );
  });

  it("refuses an absolute URL", () => {
    expect(safeRedirectPath("https://evil.com")).toBe("/portal");
    expect(safeRedirectPath("//evil.com")).toBe("/portal");
  });

  /**
   * The regression this function exists for. Browsers normalise a backslash to
   * a forward slash in the authority position, so `/\evil.com` is sent as a
   * relative Location, resolved as protocol-relative, and lands off-site — an
   * open redirect out of a sign-in flow, which is where one is most convincing.
   */
  it("refuses a backslash used as a second slash", () => {
    expect(safeRedirectPath("/\\evil.com")).toBe("/portal");
    expect(safeRedirectPath("/\\/evil.com")).toBe("/portal");
  });

  /**
   * The same escape, one layer deeper. Step 2 of the WHATWG URL parser DELETES
   * every ASCII tab, newline and carriage return before it parses anything, so
   * `/<TAB>/evil.com` is a path whose second character is not a slash right up
   * until the browser makes it one — and then it is protocol-relative and off
   * site. Node's own header validation permits HTAB, so the redirect really is
   * emitted rather than throwing. Every check in this function reads a fixed
   * offset, which is exactly what a deleted character defeats.
   */
  it("refuses a control character that would shift a slash into place", () => {
    expect(safeRedirectPath("/\t/evil.com")).toBe("/portal");
    expect(safeRedirectPath("/\n/evil.com")).toBe("/portal");
    expect(safeRedirectPath("/\r/evil.com")).toBe("/portal");
    expect(safeRedirectPath("/\t\\evil.com")).toBe("/portal");
    expect(safeRedirectPath("\t//evil.com")).toBe("/portal");
    // A tab anywhere at all, not just at the front: it has no business in a
    // path, and allowing it in the tail invites reasoning about where it does
    // and does not matter.
    expect(safeRedirectPath("/portal/check-in?code=A\tB")).toBe("/portal");
  });

  it("refuses anything that is not a path", () => {
    expect(safeRedirectPath(undefined)).toBe("/portal");
    expect(safeRedirectPath("")).toBe("/portal");
    expect(safeRedirectPath("portal")).toBe("/portal");
    expect(safeRedirectPath("javascript:alert(1)")).toBe("/portal");
  });

  it("takes the first entry when the key was repeated", () => {
    expect(safeRedirectPath(["/portal/events", "//evil.com"])).toBe(
      "/portal/events",
    );
    // ...and still refuses it when the first entry is the hostile one.
    expect(safeRedirectPath(["//evil.com", "/portal/events"])).toBe("/portal");
  });
});

describe("firstParam", () => {
  /**
   * Next resolves a repeated query key to an array. Typing these as `string`
   * was a lie the generated PageProps check cannot catch, and the first method
   * call on the value threw during render.
   */
  it("unwraps a repeated key", () => {
    expect(firstParam(["ABCD2345", "X"])).toBe("ABCD2345");
  });

  it("passes a single value through", () => {
    expect(firstParam("ABCD2345")).toBe("ABCD2345");
    expect(firstParam(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty array rather than throwing", () => {
    expect(firstParam([])).toBeUndefined();
  });
});
