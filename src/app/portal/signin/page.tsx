import { redirect } from "next/navigation";

import { Eyebrow } from "~/app/_components/ui";
import { signInWithDiscord } from "~/app/portal/_components/auth-actions";
import { auth } from "~/server/auth";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const { from } = await searchParams;
  const session = await auth();

  // Already signed in: honour where they were headed rather than parking them
  // on a sign-in screen they cannot act on.
  if (session?.user) {
    redirect(
      from?.startsWith("/") && !from.startsWith("//") ? from : "/portal",
    );
  }

  return (
    <section className="bg-cream paper-wash flex min-h-[70vh] items-center px-5 py-20 sm:px-6">
      <div className="rounded-panel ring-hairline bg-paper shadow-soft mx-auto w-full max-w-md p-8 ring-1 sm:p-10">
        <Eyebrow tone="gold">Member portal</Eyebrow>
        <h1 className="font-display text-navy text-h2 mt-5 font-bold tracking-tight text-balance">
          Sign in to check in.
        </h1>
        <p className="text-ink-muted text-body mt-4">
          Membership is free. Signing in is only how the chapter records that
          you were there and credits your points — there is nothing to pay and
          no application to fill out.
        </p>

        <form action={signInWithDiscord} className="mt-8">
          <input type="hidden" name="from" value={from ?? "/portal"} />
          <button
            type="submit"
            className="bg-navy hover:bg-navy-deep flex w-full items-center justify-center gap-3 rounded-full px-7 py-3.5 font-semibold text-white transition duration-300"
          >
            Continue with Discord
          </button>
        </form>

        <p className="text-ink-muted text-body-sm mt-6">
          The chapter Discord is where meeting rooms and event codes get posted,
          so it is the account the portal uses.
        </p>
      </div>
    </section>
  );
}
