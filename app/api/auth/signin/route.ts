import { z } from "zod";
import {
  authenticateAccount,
  clearAuthRateLimit,
  createSession,
  isAuthLocked,
  recordAuthAttempt,
} from "@/lib/accounts";
import { requestUsesHttps, safeRelativeReturnPath } from "@/lib/identity";
import { mutationGuard, parseFormDataBody } from "@/lib/security";

const SigninSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128),
  return_to: z.string().optional(),
});

export async function POST(request: Request) {
  const guarded = mutationGuard(request);
  if (guarded) return guarded;
  const body = await parseFormDataBody(request);
  if (!body.ok) return body.response;
  const form = body.value;
  const returnTo = safeRelativeReturnPath(
    typeof form.get("return_to") === "string" ? String(form.get("return_to")) : "/",
  );
  const email = typeof form.get("email") === "string" ? String(form.get("email")) : "";
  const locked = await isAuthLocked(request, "signin", email);
  if (!locked.ok) {
    return redirect(`/signin?error=locked&return_to=${encodeURIComponent(returnTo)}`);
  }

  const parsed = SigninSchema.safeParse({
    email: form.get("email"),
    password: form.get("password"),
    return_to: form.get("return_to") ?? undefined,
  });
  if (!parsed.success) {
    await recordAuthAttempt(request, "signin", email);
    return redirect(`/signin?error=invalid&return_to=${encodeURIComponent(returnTo)}`);
  }

  const user = await authenticateAccount(parsed.data.email, parsed.data.password);
  if (!user) {
    await recordAuthAttempt(request, "signin", parsed.data.email);
    return redirect(`/signin?error=invalid&return_to=${encodeURIComponent(returnTo)}`);
  }

  await clearAuthRateLimit(request, parsed.data.email);
  const cookie = await createSession(user.userId, requestUsesHttps(request));
  return new Response(null, {
    status: 303,
    headers: {
      Location: returnTo,
      "Set-Cookie": cookie,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function redirect(location: string) {
  return new Response(null, {
    status: 303,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}
