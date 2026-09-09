import { TRPCError } from "@trpc/server";

import {
  MAIL_TEST_TO,
  MailNotConfiguredError,
  mailConfig,
  sendMail,
} from "../mail";
import { assertRateLimit, MAIL_TEST_LIMIT } from "../rate-limit";
import { adminProcedure, createTRPCRouter } from "../trpc";

function mailNotConfigured(): never {
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: new MailNotConfiguredError().message,
  });
}

function asMailError(error: unknown): never {
  if (error instanceof MailNotConfiguredError) mailNotConfigured();
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: error instanceof Error ? error.message : "Could not send mail.",
  });
}

export const mailRouter = createTRPCRouter({
  configured: adminProcedure.query(() => {
    const config = mailConfig();
    return {
      configured: config !== null,
      from: config?.from ?? "SASE GT <onboarding@resend.dev>",
      testTo: MAIL_TEST_TO,
    };
  }),

  /** One copy to the pinned test inbox. Never to the roster. */
  sendTest: adminProcedure.mutation(async ({ ctx }) => {
    assertRateLimit(`mail-test:${ctx.session.user.id}`, MAIL_TEST_LIMIT);

    const config = mailConfig();
    if (!config) mailNotConfigured();

    try {
      await sendMail({
        to: MAIL_TEST_TO,
        subject: "SASE GT mail test",
        text: [
          "Hi Aamogh,",
          "",
          "This is a test from Buzz via Resend. If you received it, chapter mail is working.",
          "",
          "This is an automated note from SASE GT — please do not reply to this email.",
          "",
          "SASE GT",
        ].join("\n"),
      });
    } catch (error) {
      asMailError(error);
    }

    return { to: MAIL_TEST_TO, from: config.from };
  }),
});
