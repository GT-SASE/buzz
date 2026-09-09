/** Resend's unverified account can only deliver to this inbox. */
export const MAIL_TEST_TO = "gt@saseconnect.org";

/** Works on Resend's free trial with no domain verified. */
export const RESEND_TEST_FROM = "SASE GT <onboarding@resend.dev>";

const BODY_CAP = 8_000;
const FETCH_TIMEOUT_MS = 15_000;

export class MailNotConfiguredError extends Error {
  constructor() {
    super(
      "Chapter mail is not configured. Add a Resend API key as RESEND_API_KEY.",
    );
    this.name = "MailNotConfiguredError";
  }
}

export type OutgoingMail = {
  to: string;
  subject: string;
  text: string;
};

export function mailConfig() {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    from: process.env.RESEND_FROM?.trim() || RESEND_TEST_FROM,
  };
}

/**
 * One HTTP POST per message, then nothing is kept. No SMTP socket, no SDK.
 */
export async function sendMail(mail: OutgoingMail) {
  if (mail.text.length > BODY_CAP) {
    throw new Error("Mail body is too large.");
  }

  const config = mailConfig();
  if (!config) throw new MailNotConfiguredError();

  const abort = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.from,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
    }),
    signal: abort,
  });

  if (!response.ok) {
    const detail = await resendError(response);
    throw new Error(detail);
  }
}

async function resendError(response: Response) {
  try {
    const body: unknown = await response.json();
    if (
      body &&
      typeof body === "object" &&
      "message" in body &&
      typeof body.message === "string"
    ) {
      return body.message;
    }
  } catch {
    // Fall through to the status code.
  }
  return `Resend returned ${response.status}.`;
}
