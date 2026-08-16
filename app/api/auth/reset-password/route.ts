import { z } from "zod";
import { completePasswordReset, validResetToken } from "@/lib/accounts";
import { clearAuthCookie } from "@/lib/accounts";
import { requestUsesHttps, safeRelativeReturnPath } from "@/lib/identity";
import { mutationGuard, parseFormDataBody } from "@/lib/security";

const ResetSchema = z.object({
  token: z.string().trim().length(64),
  password: z.string().min(8).max(128),
  password_confirm: z.string().min(8).max(128),
  return_to: z.string().optional(),
});

export async function POST(request: Request) {
  const guarded = mutationGuard(request);
  if (guarded) return guarded;

  const body = await parseFormDataBody(request);
  if (!body.ok) return body.response;
  const form = body.value;
  const rawToken = typeof form.get("token") === "string" ? String(form.get("token")) : "";
  const returnTo = safeRelativeReturnPath(
    typeof form.get("return_to") === "string" ? String(form.get("return_to")) : "/",
  );
  const returnQuery = `&return_to=${encodeURIComponent(returnTo)}`;
  const tokenQuery = validResetToken(rawToken) ? `&token=${rawToken}` : "";

  const parsed = ResetSchema.safeParse({
    token: rawToken,
    password: form.get("password"),
    password_confirm: form.get("password_confirm"),
    return_to: form.get("return_to") ?? undefined,
  });
  if (!parsed.success) return redirect(`/reset-password?error=invalid${tokenQuery}${returnQuery}`, request);
  if (parsed.data.password !== parsed.data.password_confirm) {
    return redirect(`/reset-password?error=mismatch${tokenQuery}${returnQuery}`, request);
  }

  const result = await completePasswordReset(parsed.data.token, parsed.data.password);
  if (!result.ok) {
    const error = result.reason === "expired" ? "expired" : result.reason === "weak" ? "invalid" : "token";
    return redirect(`/reset-password?error=${error}${returnQuery}`, request);
  }

  // Every session for the account was revoked, so drop this browser's cookie
  // too rather than leaving it pointing at a session that no longer resolves.
  return redirect(`/signin?reset=1&return_to=${encodeURIComponent(returnTo)}`, request, true);
}

function redirect(location: string, request: Request, clearSession = false) {
  const headers = new Headers({
    Location: location,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (clearSession) {
    headers.append("Set-Cookie", clearAuthCookie(requestUsesHttps(request)));
  }
  return new Response(null, { status: 303, headers });
}
