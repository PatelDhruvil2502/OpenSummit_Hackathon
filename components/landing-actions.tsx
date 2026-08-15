import Link from "next/link";
import { ArrowRight, BookOpen } from "lucide-react";

export function LandingActions({ signedIn, signInPath }: { signedIn: boolean; signInPath: string }) {
  return (
    <div className="hero-actions landing-cta-row">
      <Link className="button button-primary" href={signedIn ? "/cases/new" : signInPath || "/signup"}>
        {signedIn ? "Start a private review" : "Create an account"} <ArrowRight size={17} aria-hidden="true" />
      </Link>
      <Link className="button button-secondary" href="/methodology">
        <BookOpen size={16} aria-hidden="true" /> How the checks work
      </Link>
    </div>
  );
}
