import Link from "next/link";
import { ArrowLeft, FileQuestion } from "lucide-react";
import { Brand } from "@/components/brand";

export default function NotFound() {
  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="not-found-title">
        <Brand />
        <div className="auth-icon" aria-hidden="true">
          <FileQuestion size={24} />
        </div>
        <span className="eyebrow">Unavailable</span>
        <h1 id="not-found-title">This page or review is not available</h1>
        <p>
          The address may be incorrect, the private review may have expired, or your account may
          not have access to it.
        </p>
        <Link href="/cases" className="button button-primary button-full">
          Open my reviews
        </Link>
        <Link href="/" className="back-link">
          <ArrowLeft size={14} /> Back to overview
        </Link>
      </section>
    </main>
  );
}
