import { clearAuthCookie, revokeSession } from "@/lib/accounts";
import { requestUsesHttps, safeRelativeReturnPath } from "@/lib/identity";
import { mutationGuard } from "@/lib/security";

function signOutResponse(request: Request) {
  if (request.method === "POST") {
    const guarded = mutationGuard(request);
    if (guarded) return Promise.resolve(guarded);
  }
  const returnTo = safeRelativeReturnPath(new URL(request.url).searchParams.get("return_to"));
  return (async () => {
    await revokeSession(request.headers.get("cookie"));
    const headers = new Headers({
      Location: returnTo,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    headers.append("Set-Cookie", clearAuthCookie(requestUsesHttps(request)));
    headers.append(
      "Set-Cookie",
      "wageshield_dev_identity=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
    );
    return new Response(null, { status: 303, headers });
  })();
}

export function GET(request: Request) {
  return signOutResponse(request);
}

export function POST(request: Request) {
  return signOutResponse(request);
}
