import {
  createPasswordReset,
  isAuthLocked,
  recordAuthAttempt,
  PASSWORD_RESET_MINUTES,
} from "@/lib/accounts";
import { emailIsConfigured, passwordResetMessage, sendEmail } from "@/lib/email";
import { isLocalRequest, safeRelativeReturnPath } from "@/lib/identity";
import { publicAppOrigin } from "@/lib/runtime-flags";
import { mutationGuard, parseFormDataBody } from "@/lib/security";

/**
 * Always answers with the same "check your email" outcome whether or not an
 * account exists, so this endpoint cannot be used to enumerate registered
 * addresses. Failures are only surfaced when they are the operator's fault.
 */
export async function POST(request: Request) {
  const guarded = mutationGuard(request);
  if (guarded) return guarded;

  const body = await parseFormDataBody(request);
  if (!body.ok) return body.response;
  const form = body.value;
  const email = typeof form.get("email") === "string" ? String(form.get("email")) : "";
  const returnTo = safeRelativeReturnPath(
    typeof form.get("return_to") === "string" ? String(form.get("return_to")) : "/",
  );
  const recoveryQuery = `return_to=${encodeURIComponent(returnTo)}`;

  const locked = await isAuthLocked(request, "reset", email);
  if (!locked.ok) return redirect(`/forgot-password?error=locked&${recoveryQuery}`);
  await recordAuthAttempt(request, "reset", email);

  const appOrigin = publicAppOrigin(request);
  const localDevelopment = process.env.NODE_ENV !== "production" && isLocalRequest(request);
  if ((!emailIsConfigured() || !appOrigin) && !localDevelopment) {
    return redirect(`/forgot-password?error=unavailable&${recoveryQuery}`);
  }

  const reset = await createPasswordReset(email);
  if (reset) {
    if (!appOrigin) return redirect(`/forgot-password?error=unavailable&${recoveryQuery}`);
    const resetUrl = new URL(
      `/reset-password?token=${reset.token}&${recoveryQuery}`,
      appOrigin,
    ).toString();
    const result = await sendEmail(
      passwordResetMessage(reset.email, resetUrl, PASSWORD_RESET_MINUTES),
    );
    if (!result.ok) return redirect(`/forgot-password?error=unavailable&${recoveryQuery}`);
    if (!result.delivered && localDevelopment) {
      // Local development without an email provider: print the link to the dev
      // server log instead of silently discarding it. Never reachable in
      // production because the unconfigured case redirects above.
      console.info(`[dev] password reset link: ${resetUrl}`);
    }
  }

  return redirect(`/forgot-password?sent=1&${recoveryQuery}`);
}

function redirect(location: string) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
