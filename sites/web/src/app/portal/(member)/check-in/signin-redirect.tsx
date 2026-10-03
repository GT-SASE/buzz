"use client";

import { useEffect } from "react";

import { checkInPath, signInPath } from "~/app/portal/_lib/paths";
import { Spinner } from "~/components/ui/spinner";
import { codeFromScan } from "./scanner";

/**
 * Signed out with a scanned QR: the code is in `#code=`, which the server never
 * sees and which Google's OAuth round-trip drops. Move it into `from` so the
 * member lands back on this page, code filled in, after signing in.
 */
export function SignInRedirect() {
  useEffect(() => {
    const code = codeFromScan(window.location.href);
    window.location.replace(signInPath(checkInPath(code ?? undefined)));
  }, []);

  return (
    <div
      role="status"
      className="grid justify-items-center gap-4 py-14 text-center"
    >
      <Spinner className="text-gold-bright size-8" />
      <p className="text-ink-muted text-body-sm">Taking you to sign in...</p>
    </div>
  );
}
