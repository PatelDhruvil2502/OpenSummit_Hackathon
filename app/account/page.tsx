import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ShieldCheck, UserRound } from "lucide-react";
import { requireChatGPTUser } from "@/app/chatgpt-auth";
import { AccountDataControls } from "@/components/account-data-controls";
import { Brand } from "@/components/brand";
import { SiteHeader } from "@/components/site-header";
import { getAccountById } from "@/lib/accounts";

export const metadata: Metadata = {
  title: "Account",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; updated?: string }>;
}) {
  const user = await requireChatGPTUser("/account");
  const query = await searchParams;
  const account = await getAccountById(user.userId);
  const editable = Boolean(account) && user.source === "account";

  return (
    <main className="subpage">
      <SiteHeader />
      <section className="auth-page account-page">
        <section className="auth-card" aria-labelledby="account-title">
          <Brand />
          <div className="auth-icon" aria-hidden="true">
            <UserRound size={24} />
          </div>
          <span className="eyebrow">Your account</span>
          <h1 id="account-title">Personal information</h1>
          <p>Update the name and email shown in WageShield. Changing your password keeps this device signed in and signs out other sessions.</p>
          {query.updated === "1" && (
            <p className="form-success" role="status">
              Your account was updated.
            </p>
          )}
          {query.error === "password" && (
            <p className="form-error" role="alert">Current password is incorrect.</p>
          )}
          {query.error === "exists" && (
            <p className="form-error" role="alert">That email is already used by another account.</p>
          )}
          {query.error === "mismatch" && (
            <p className="form-error" role="alert">New password and confirmation do not match.</p>
          )}
          {query.error === "invalid" && (
            <p className="form-error" role="alert">Enter a name, a valid email, and your current password.</p>
          )}
          {query.error === "missing" && (
            <p className="form-error" role="alert">This sign-in is not a WageShield email account, so it cannot be edited here.</p>
          )}
          {editable && account ? (
            <form className="auth-form" action="/api/auth/profile" method="post">
              <label htmlFor="full-name">Full name</label>
              <input
                id="full-name"
                name="full_name"
                type="text"
                autoComplete="name"
                maxLength={100}
                defaultValue={account.displayName}
                required
              />
              <label htmlFor="email">Email</label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                maxLength={254}
                defaultValue={account.email}
                required
              />
              <label htmlFor="current-password">Current password</label>
              <input
                id="current-password"
                name="current_password"
                type="password"
                autoComplete="current-password"
                minLength={1}
                maxLength={128}
                required
              />
              <label htmlFor="new-password">New password <small>Optional</small></label>
              <input
                id="new-password"
                name="new_password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                maxLength={128}
              />
              <label htmlFor="new-password-confirm">Confirm new password</label>
              <input
                id="new-password-confirm"
                name="new_password_confirm"
                type="password"
                autoComplete="new-password"
                minLength={8}
                maxLength={128}
              />
              <button className="button button-primary button-full" type="submit">
                <ShieldCheck size={17} /> Save account
              </button>
            </form>
          ) : (
            <div className="auth-form">
              <p>Signed in as {user.fullName ?? user.displayName} ({user.email}). This identity is supplied by the host and cannot be edited inside WageShield.</p>
            </div>
          )}
          <AccountDataControls canDelete={editable} />
          <Link href="/cases" className="back-link">
            <ArrowLeft size={14} /> Back to reviews
          </Link>
        </section>
      </section>
    </main>
  );
}
