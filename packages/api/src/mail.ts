import nodemailer from "nodemailer";

export const SENDER_NAME = "GT SASE";

export type Mailer = NonNullable<ReturnType<typeof mailer>>;

export type Mail = {
  to: string;
  subject: string;
  text: string;
  icalEvent?: { method: "REQUEST" | "CANCEL"; content: string };
};

/**
 * The chapter's Gmail account, or null when it is not configured: callers
 * treat that as "not sent", never as an error, so a deployment without
 * credentials (a preview, a laptop) still saves everything it was asked to.
 */
export function mailer() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  return {
    user,
    replyTo:
      process.env.MAIL_REPLY_TO === "" ? undefined : process.env.MAIL_REPLY_TO,
    transport: nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass },
    }),
  };
}

/** Sends one message. Returns false, after logging why, when it did not go out. */
export async function deliver(mail: Mailer, message: Mail, what: string) {
  try {
    await mail.transport.sendMail({
      from: { name: SENDER_NAME, address: mail.user },
      replyTo: mail.replyTo,
      ...message,
    });
    return true;
  } catch (error) {
    console.error(`${what} failed:`, error);
    return false;
  }
}
