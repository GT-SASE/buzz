import { Eyebrow } from "~/components/site";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { signOutOfPortal } from "./auth-actions";

/** Portal masthead. Quieter than the marketing `PageHeader` on purpose. */
export function PortalHeader({
  eyebrow,
  title,
  body,
  aside,
}: {
  eyebrow: string;
  title: string;
  body?: string;
  aside?: React.ReactNode;
}) {
  return (
    <section className="bg-cream paper-wash border-hairline relative border-b">
      <div className="max-w-content relative mx-auto grid gap-10 px-5 py-12 sm:px-6 sm:py-16 lg:grid-cols-[1fr_auto] lg:items-center lg:gap-16">
        <div className="max-w-xl">
          <Eyebrow tone="gold">{eyebrow}</Eyebrow>
          <h1 className="font-display text-navy text-h1 mt-5 font-bold tracking-tight text-balance">
            {title}
          </h1>
          {body && (
            <p className="text-lead text-ink-muted max-w-measure mt-5">
              {body}
            </p>
          )}
        </div>
        {aside}
      </div>
    </section>
  );
}

/** Nothing here yet — always carrying the action that fills it. */
export function EmptyState({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <Card className="border-hairline bg-cream rounded-lg border-dashed py-14 text-center shadow-none">
      <CardContent>
        <h3 className="font-display text-navy text-h3 font-bold text-balance">
          {title}
        </h3>
        <p className="text-ink-muted text-body max-w-measure mx-auto mt-3">
          {body}
        </p>
        {children && (
          <div className="mt-7 flex flex-wrap justify-center gap-4">
            {children}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Sign out. A form post, so it works with JavaScript still loading. */
export function SignOutButton() {
  return (
    <form action={signOutOfPortal}>
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        className="text-ink-muted hover:text-navy hover:bg-cream text-body-sm rounded-none font-semibold"
      >
        Sign out
      </Button>
    </form>
  );
}
