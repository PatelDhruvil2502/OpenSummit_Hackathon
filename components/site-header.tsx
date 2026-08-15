import Link from "next/link";
import { LogIn, LogOut, UserRound } from "lucide-react";
import { getChatGPTUser, getSignInPath } from "@/app/chatgpt-auth";
import { Brand } from "@/components/brand";

export async function SiteHeader() {
  const user = await getChatGPTUser();
  const loginPath = user ? null : await getSignInPath("/cases");
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <Brand />
        <nav className="site-nav" aria-label="Primary navigation">
          <Link href="/cases">My reviews</Link>
          <Link href="/methodology">How it works</Link>
          <Link href="/#privacy">Privacy</Link>
          {user ? (
            <details className="account-menu">
              <summary aria-label={`Account: ${user.displayName}`}>
                <span className="account-avatar" aria-hidden="true">
                  <UserRound size={15} />
                </span>
                <span className="account-name">{user.fullName ?? user.email}</span>
              </summary>
              <div className="account-popover">
                <span>Signed in</span>
                <strong>{user.fullName ?? "WageShield account"}</strong>
                <small>{user.email}</small>
                <form action="/signout" method="post">
                  <button type="submit" className="account-signout">
                    <LogOut size={14} /> Sign out
                  </button>
                </form>
              </div>
            </details>
          ) : (
            <Link href={loginPath ?? "/signin"} className="header-sign-in">
              <LogIn size={15} /> Sign in
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
