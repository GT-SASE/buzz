import { describe, expect, it } from "bun:test";

import { noticeToast } from "../../sites/web/src/app/portal/_lib/notice";

const words = {
  done: "Changes saved.",
  unit: "calendar update",
  audience: "RSVPs",
  followUp: "Tell those members.",
};
const quiet = { sent: 0, failed: 0, skipped: 0, channel: "off" } as const;

describe("noticeToast", () => {
  it("is just the save when nothing was sent", () => {
    expect(noticeToast(quiet, words)).toEqual({
      kind: "success",
      message: "Changes saved.",
    });
  });

  it("counts what went out, with the right plural", () => {
    expect(noticeToast({ ...quiet, sent: 1 }, words).message).toBe(
      "Changes saved. 1 calendar update sent to RSVPs.",
    );
    expect(noticeToast({ ...quiet, sent: 3 }, words).message).toBe(
      "Changes saved. 3 calendar updates sent to RSVPs.",
    );
  });

  it("warns, with what to do by hand, when a send failed", () => {
    expect(noticeToast({ ...quiet, sent: 2, failed: 1 }, words)).toEqual({
      kind: "warning",
      message:
        "Changes saved. 1 of 3 calendar updates did not send. Tell those members.",
    });
  });

  it("says how many opted out without calling it a failure", () => {
    const result = noticeToast({ ...quiet, sent: 2, skipped: 4 }, words);
    expect(result.kind).toBe("success");
    expect(result.message).toContain("4 opted out of these emails.");
  });

  it("reports the Discord post, and warns when it failed", () => {
    expect(noticeToast({ ...quiet, channel: "posted" }, words).message).toBe(
      "Changes saved. Posted to Discord.",
    );
    expect(noticeToast({ ...quiet, channel: "failed" }, words)).toEqual({
      kind: "warning",
      message: "Changes saved. The Discord post did not go through.",
    });
  });
});
