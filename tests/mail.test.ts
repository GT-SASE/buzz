import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAIL_TEST_TO,
  MailNotConfiguredError,
  mailConfig,
  sendMail,
} from "../packages/api/src/mail";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("mailConfig", () => {
  it("is unset without a Resend key", () => {
    vi.stubEnv("RESEND_API_KEY", "");
    expect(mailConfig()).toBeNull();
  });

  it("defaults From to Resend's test address", () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    expect(mailConfig()?.from).toBe("SASE GT <onboarding@resend.dev>");
  });
});

describe("sendMail", () => {
  it("refuses to send without a key", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    await expect(
      sendMail({ to: MAIL_TEST_TO, subject: "x", text: "y" }),
    ).rejects.toBeInstanceOf(MailNotConfiguredError);
  });

  it("posts text-only JSON to Resend", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response("{}", { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await sendMail({
      to: MAIL_TEST_TO,
      subject: "SASE GT mail test",
      text: "Hi Aamogh",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers.Authorization).toBe("Bearer re_test");
    expect(JSON.parse(init.body)).toMatchObject({
      from: "SASE GT <onboarding@resend.dev>",
      to: [MAIL_TEST_TO],
      subject: "SASE GT mail test",
      text: "Hi Aamogh",
    });
    expect(init.body).not.toContain("html");
  });
});
