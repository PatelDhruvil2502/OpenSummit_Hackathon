import Link from "next/link";
import { ArrowRight, FlaskConical } from "lucide-react";

export function LandingActions({ signedIn, signInPath }: { signedIn: boolean; signInPath: string }) {
  return (
    <div className="hero-actions landing-cta-row">
      <Link className="button button-primary" href={signedIn ? "/cases/new" : signInPath || "/signin"}>
        {signedIn ? "Start a private review" : "Sign in to start a review"} <ArrowRight size={17} aria-hidden="true" />
      </Link>
      <Link className="button button-secondary" href="/sandbox">
        <FlaskConical size={16} aria-hidden="true" /> Explore fictional sandbox
      </Link>
    </div>
  );
}
