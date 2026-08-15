import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, LockKeyhole, ShieldCheck } from "lucide-react";
import { Brand } from "@/components/brand";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { accountSignUpPath, safeRelativeReturnPath } from "@/lib/identity";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ return_to?: string; error?: string }>;
}) {
  const query = await searchParams;
  const returnTo = safeRelativeReturnPath(query.return_to);
  const existingUser = await getChatGPTUser();
  if (existingUser) redirect(returnTo);

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="signin-title">
        <Brand />
        <div className="auth-icon" aria-hidden="true">
          <LockKeyhole size={24} />
        </div>
        <span className="eyebrow">Private account</span>
        <h1 id="signin-title">Sign in</h1>
        <p>Use the email and password stored in your WageShield account to open your private reviews.</p>
        {query.error === "invalid" && (
          <p className="form-error" role="alert">
            Email or password is incorrect.
          </p>
        )}
        {query.error === "locked" && (
          <p className="form-error" role="alert">
            Too many sign-in attempts. Wait a few minutes, then try again.
          </p>
        )}
        <form className="auth-form" action="/api/auth/signin" method="post">
          <input type="hidden" name="return_to" value={returnTo} />
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" maxLength={254} required />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            minLength={8}
            maxLength={128}
            required
          />
          <button className="button button-primary button-full" type="submit">
            <ShieldCheck size={17} /> Sign in
          </button>
        </form>
        <p className="auth-switch">
          New here? <Link href={accountSignUpPath(returnTo)}>Create an account</Link>
        </p>
        <Link href="/" className="back-link">
          <ArrowLeft size={14} /> Back to overview
        </Link>
      </section>
    </main>
  );
}
