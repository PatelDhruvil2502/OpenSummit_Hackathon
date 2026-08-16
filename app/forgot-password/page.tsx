import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, KeyRound, MailCheck, Send } from "lucide-react";
import { Brand } from "@/components/brand";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { PASSWORD_RESET_MINUTES } from "@/lib/accounts";
import { COMPANY } from "@/lib/company";
import { safeRelativeReturnPath } from "@/lib/identity";

export const metadata: Metadata = {
  title: "Reset your password",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string; return_to?: string }>;
}) {
  const query = await searchParams;
  const returnTo = safeRelativeReturnPath(query.return_to);
  const existingUser = await getChatGPTUser();
  if (existingUser) redirect("/account");

  if (query.sent === "1") {
    return (
      <main className="auth-page">
        <section className="auth-card" aria-labelledby="sent-title">
          <Brand />
          <div className="auth-icon" aria-hidden="true">
            <MailCheck size={24} />
          </div>
          <span className="eyebrow">Check your inbox</span>
          <h1 id="sent-title">If that email has an account, a link is on its way</h1>
          <p>
            The link works once and expires in {PASSWORD_RESET_MINUTES} minutes. We show the same
            message whether or not an account exists, so nobody can use this page to discover who is
            registered.
          </p>
          <p className="auth-switch">
            Remembered it? <Link href={`/signin?return_to=${encodeURIComponent(returnTo)}`}>Back to sign in</Link>
          </p>
          <Link href="/" className="back-link">
            <ArrowLeft size={14} /> Back to overview
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="forgot-title">
        <Brand />
        <div className="auth-icon" aria-hidden="true">
          <KeyRound size={24} />
        </div>
        <span className="eyebrow">Account recovery</span>
        <h1 id="forgot-title">Reset your password</h1>
        <p>
          Enter the email on your WageShield account. We will send a single-use link that expires in{" "}
          {PASSWORD_RESET_MINUTES} minutes. Resetting signs out every other device.
        </p>
        {query.error === "locked" && (
          <p className="form-error" role="alert">
            Too many reset requests. Wait a few minutes, then try again.
          </p>
        )}
        {query.error === "unavailable" && (
          <p className="form-error" role="alert">
            Password reset email could not be sent right now. Try again shortly, or contact{" "}
            <a href={`mailto:${COMPANY.supportEmail}`}>support</a>.
          </p>
        )}
        <form className="auth-form" action="/api/auth/forgot-password" method="post">
          <input type="hidden" name="return_to" value={returnTo} />
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" maxLength={254} required />
          <button className="button button-primary button-full" type="submit">
            <Send size={17} /> Send reset link
          </button>
        </form>
        <p className="auth-switch">
          Remembered it? <Link href={`/signin?return_to=${encodeURIComponent(returnTo)}`}>Back to sign in</Link>
        </p>
        <Link href="/" className="back-link">
          <ArrowLeft size={14} /> Back to overview
        </Link>
      </section>
    </main>
  );
}
