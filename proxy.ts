import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const AUTH_COOKIE = "wageshield_auth";

function enabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function hasTrustedForwardedIdentity(request: NextRequest): boolean {
  return (
    enabled(process.env.TRUST_FORWARDED_IDENTITY) &&
    Boolean(request.headers.get("oai-authenticated-user-id")?.trim()) &&
    Boolean(request.headers.get("oai-authenticated-user-email")?.trim())
  );
}

/**
 * Perform only optimistic page gating before React starts streaming. The pages
 * still validate the session against PostgreSQL, so possession of a malformed
 * cookie can never authorize data access.
 */
export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/sandbox" && !enabled(process.env.ENABLE_SANDBOX)) {
    return new NextResponse("Not Found", {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  if (
    request.nextUrl.pathname.startsWith("/cases") &&
    !request.cookies.has(AUTH_COOKIE) &&
    !hasTrustedForwardedIdentity(request)
  ) {
    const signIn = new URL("/signin", request.url);
    signIn.searchParams.set(
      "return_to",
      `${request.nextUrl.pathname}${request.nextUrl.search}`,
    );
    return NextResponse.redirect(signIn, 307);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/cases/:path*", "/sandbox"],
};
