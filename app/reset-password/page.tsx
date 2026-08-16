import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, LockKeyhole, ShieldCheck } from "lucide-react";
import { Brand } from "@/components/brand";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import {
  PASSWORD_RESET_MINUTES,
  passwordResetTokenIsUsable,
  validResetToken,
} from "@/lib/accounts";
import { safeRelativeReturnPath } from "@/lib/identity";

export const metadata: Metadata = {
  title: "Choose a new password",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const DEAD_LINK_ERRORS = new Set(["token", "expired"]);

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string; return_to?: string }>;
}) {
  const query = await searchParams;
  const returnTo = safeRelativeReturnPath(query.return_to);
  const existingUser = await getChatGPTUser();
  if (existingUser) redirect("/account");

  const token = query.token ?? "";
  // A used, expired, or malformed link must not render a form that cannot work.
  if (
    !validResetToken(token) ||
    DEAD_LINK_ERRORS.has(query.error ?? "") ||
    !(await passwordResetTokenIsUsable(token))
  ) {
    return (
      <main className="auth-page">
        <section className="auth-card" aria-labelledby="dead-title">
          <Brand />
          <div className="auth-icon" aria-hidden="true">
            <LockKeyhole size={24} />
          </div>
          <span className="eyebrow">Account recovery</span>
          <h1 id="dead-title">This reset link is no longer usable</h1>
          <p>
            Reset links work once and expire after {PASSWORD_RESET_MINUTES} minutes. Request a fresh
            one and open it in any browser you trust.
          </p>
          <Link
            href={`/forgot-password?return_to=${encodeURIComponent(returnTo)}`}
            className="button button-primary button-full"
          >
            <ShieldCheck size={17} /> Send a new link
          </Link>
          <Link href="/" className="back-link">
            <ArrowLeft size={14} /> Back to overview
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="reset-title">
        <Brand />
        <div className="auth-icon" aria-hidden="true">
          <LockKeyhole size={24} />
        </div>
        <span className="eyebrow">Account recovery</span>
        <h1 id="reset-title">Choose a new password</h1>
        <p>Saving signs out every device, including this one. Sign in again with the new password.</p>
        {query.error === "mismatch" && (
          <p className="form-error" role="alert">New password and confirmation do not match.</p>
        )}
        {query.error === "invalid" && (
          <p className="form-error" role="alert">Enter matching passwords of at least 8 characters.</p>
        )}
        <form className="auth-form" action="/api/auth/reset-password" method="post">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="return_to" value={returnTo} />
          <label htmlFor="password">New password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            maxLength={128}
            required
          />
          <label htmlFor="password-confirm">Confirm new password</label>
          <input
            id="password-confirm"
            name="password_confirm"
            type="password"
            autoComplete="new-password"
            minLength={8}
            maxLength={128}
            required
          />
          <button className="button button-primary button-full" type="submit">
            <ShieldCheck size={17} /> Save new password
          </button>
        </form>
        <Link href="/" className="back-link">
          <ArrowLeft size={14} /> Back to overview
        </Link>
      </section>
    </main>
  );
}
