import { afterEach, describe, expect, it, vi } from "vitest";

import {
  inviteIcs,
  sendCalendarInvite,
} from "../packages/api/src/calendar-invite";

const event = {
  id: "evt-1",
  title: "SASExSpaceXAI",
  startsAt: new Date("2026-10-20T22:00:00.000Z"),
  location: "Van Leer C456",
  description: "Bring a laptop; we build, then eat, then demo.",
};

function ics(method: "REQUEST" | "CANCEL", now: Date) {
  return inviteIcs({
    method,
    event,
    organizer: "gt@saseconnect.org",
    attendee: "member@example.com",
    now,
  });
}

describe("calendar invite", () => {
  it("is a 90-minute UTC event with CRLF lines", () => {
    const body = ics("REQUEST", new Date("2026-10-01T12:00:00Z"));
    expect(body).toContain("METHOD:REQUEST\r\n");
    expect(body).toContain("DTSTART:20261020T220000Z");
    expect(body).toContain("DTEND:20261020T233000Z");
    expect(body).toContain("STATUS:CONFIRMED");
    expect(body).not.toMatch(/[^\r]\n/);
  });

  it("escapes commas and semicolons in text fields", () => {
    const body = ics("REQUEST", new Date("2026-10-01T12:00:00Z"));
    expect(body).toContain(
      String.raw`DESCRIPTION:Bring a laptop\; we build\, then eat\, then demo.`,
    );
  });

  it("cancels the same entry with a higher sequence", () => {
    const sent = ics("REQUEST", new Date("2026-10-01T12:00:00Z"));
    const cancelled = ics("CANCEL", new Date("2026-10-02T12:00:00Z"));
    const uid = (body: string) => /UID:(.*)/.exec(body)?.[1];
    const sequence = (body: string) => Number(/SEQUENCE:(\d+)/.exec(body)?.[1]);

    expect(uid(cancelled)).toBe(uid(sent));
    expect(sequence(cancelled)).toBeGreaterThan(sequence(sent));
    expect(cancelled).toContain("METHOD:CANCEL");
    expect(cancelled).toContain("STATUS:CANCELLED");
  });

  describe("sending", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("skips quietly when Gmail is not configured", async () => {
      vi.stubEnv("GMAIL_USER", "");
      vi.stubEnv("GMAIL_APP_PASSWORD", "");
      expect(
        await sendCalendarInvite("REQUEST", event, "member@example.com"),
      ).toBe(false);
    });

    it("returns false instead of throwing when Gmail rejects the login", async () => {
      vi.stubEnv("GMAIL_USER", "not-a-real-account@example.invalid");
      vi.stubEnv("GMAIL_APP_PASSWORD", "wrong");
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      expect(
        await sendCalendarInvite("CANCEL", event, "member@example.com"),
      ).toBe(false);
    }, 30_000);
  });
});
