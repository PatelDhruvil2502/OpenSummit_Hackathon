import { z } from "zod";
import { authenticateCaseRequest } from "@/lib/case-auth";
import { revokeOtherSessions, updateAccount } from "@/lib/accounts";
import { mutationGuard, parseFormDataBody } from "@/lib/security";

const ProfileSchema = z.object({
  full_name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(254),
  current_password: z.string().min(1).max(128),
  new_password: z.union([z.literal(""), z.string().min(8).max(128)]).optional(),
  new_password_confirm: z.string().max(128).optional(),
});

export async function POST(request: Request) {
  const identity = await authenticateCaseRequest(request);
  if (!identity) {
    return redirect("/signin?return_to=%2Faccount");
  }
  const guarded = mutationGuard(request);
  if (guarded) return guarded;

  const body = await parseFormDataBody(request);
  if (!body.ok) return body.response;
  const form = body.value;
  const parsed = ProfileSchema.safeParse({
    full_name: form.get("full_name"),
    email: form.get("email"),
    current_password: form.get("current_password"),
    new_password: form.get("new_password") ?? "",
    new_password_confirm: form.get("new_password_confirm") ?? "",
  });
  if (!parsed.success) return redirect("/account?error=invalid");

  const newPassword = parsed.data.new_password?.trim() || undefined;
  if (newPassword && newPassword !== (parsed.data.new_password_confirm ?? "")) {
    return redirect("/account?error=mismatch");
  }

  const updated = await updateAccount(identity.user.userId, {
    currentPassword: parsed.data.current_password,
    displayName: parsed.data.full_name,
    email: parsed.data.email,
    newPassword,
  });
  if (!updated.ok) {
    const error =
      updated.reason === "password"
        ? "password"
        : updated.reason === "exists"
          ? "exists"
          : updated.reason === "missing"
            ? "missing"
            : "invalid";
    return redirect(`/account?error=${error}`);
  }
  if (newPassword) await revokeOtherSessions(request.headers.get("cookie"), identity.user.userId);
  return redirect("/account?updated=1");
}

function redirect(location: string) {
  return new Response(null, {
    status: 303,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}
