import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, UserPlus, ShieldCheck } from "lucide-react";
import { Brand } from "@/components/brand";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { accountSignInPath, safeRelativeReturnPath } from "@/lib/identity";

export const metadata: Metadata = {
  title: "Create account",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function SignUpPage({
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
      <section className="auth-card" aria-labelledby="signup-title">
        <Brand />
        <div className="auth-icon" aria-hidden="true">
          <UserPlus size={24} />
        </div>
        <span className="eyebrow">Private account</span>
        <h1 id="signup-title">Create an account</h1>
        <p>Your email, name, and password hash are stored in the WageShield database. Cases stay tied to this account.</p>
        {query.error === "exists" && (
          <p className="form-error" role="alert">
            An account with that email already exists. Sign in instead.
          </p>
        )}
        {query.error === "invalid" && (
          <p className="form-error" role="alert">
            Enter a name, a valid email, matching passwords of at least 8 characters.
          </p>
        )}
        {query.error === "locked" && (
          <p className="form-error" role="alert">
            Too many account attempts. Wait a few minutes, then try again.
          </p>
        )}
        <form className="auth-form" action="/api/auth/signup" method="post">
          <input type="hidden" name="return_to" value={returnTo} />
          <label htmlFor="full-name">Full name</label>
          <input
            id="full-name"
            name="full_name"
            type="text"
            autoComplete="name"
            maxLength={100}
            required
          />
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" maxLength={254} required />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            maxLength={128}
            required
          />
          <label htmlFor="password-confirm">Confirm password</label>
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
            <ShieldCheck size={17} /> Create account
          </button>
        </form>
        <p className="auth-switch">
          Already have an account? <Link href={accountSignInPath(returnTo)}>Sign in</Link>
        </p>
        <Link href="/" className="back-link">
          <ArrowLeft size={14} /> Back to overview
        </Link>
      </section>
    </main>
  );
}
