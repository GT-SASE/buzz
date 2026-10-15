import { NextResponse, type NextRequest } from "next/server";

import { signInPath } from "~/app/portal/_lib/paths";
import { auth } from "@buzz/auth";
import { isOfficerRole } from "@buzz/db";

export const dynamic = "force-dynamic";

/** "Open the portal" links land here: the role is only known server-side, so this picks officer or member view. */
export async function GET(request: NextRequest) {
  const user = (await auth())?.user;
  const path = !user
    ? signInPath("/portal/start")
    : isOfficerRole(user.role)
      ? "/portal/admin"
      : "/portal";

  return NextResponse.redirect(new URL(path, request.url));
}
