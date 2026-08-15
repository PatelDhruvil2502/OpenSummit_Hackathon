import { z } from "zod";
import {
  createAccount,
  createSession,
  isAuthLocked,
  recordAuthAttempt,
} from "@/lib/accounts";
import { requestUsesHttps, safeRelativeReturnPath } from "@/lib/identity";
import { mutationGuard } from "@/lib/security";

const SignupSchema = z
  .object({
    full_name: z.string().trim().min(1).max(100),
    email: z.string().trim().email().max(254),
    password: z.string().min(8).max(128),
    password_confirm: z.string().min(8).max(128).optional(),
    return_to: z.string().optional(),
  })
  .refine((value) => !value.password_confirm || value.password_confirm === value.password, {
    message: "Passwords do not match",
    path: ["password_confirm"],
  });

export async function POST(request: Request) {
  const guarded = mutationGuard(request);
  if (guarded) return guarded;
  const form = await request.formData();
  const returnTo = safeRelativeReturnPath(
    typeof form.get("return_to") === "string" ? String(form.get("return_to")) : "/",
  );
  const email = typeof form.get("email") === "string" ? String(form.get("email")) : "";
  const locked = await isAuthLocked(request, "signup", email);
  if (!locked.ok) {
    return redirect(`/signup?error=locked&return_to=${encodeURIComponent(returnTo)}`);
  }

  const parsed = SignupSchema.safeParse({
    full_name: form.get("full_name"),
    email: form.get("email"),
    password: form.get("password"),
    password_confirm: form.get("password_confirm") || undefined,
    return_to: form.get("return_to") ?? undefined,
  });
  if (!parsed.success) {
    await recordAuthAttempt(request, "signup", email);
    return redirect(`/signup?error=invalid&return_to=${encodeURIComponent(returnTo)}`);
  }

  const created = await createAccount(
    parsed.data.email,
    parsed.data.password,
    parsed.data.full_name,
  );
  await recordAuthAttempt(request, "signup", parsed.data.email);
  if (!created.ok) {
    const error = created.reason === "exists" ? "exists" : "invalid";
    return redirect(`/signup?error=${error}&return_to=${encodeURIComponent(returnTo)}`);
  }

  const cookie = await createSession(created.user.userId, requestUsesHttps(request));
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
