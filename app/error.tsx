"use client";

import Link from "next/link";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Brand } from "@/components/brand";

export default function ErrorBoundary({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="error-title">
        <Brand />
        <div className="auth-icon" aria-hidden="true">
          <AlertTriangle size={24} />
        </div>
        <span className="eyebrow">Request interrupted</span>
        <h1 id="error-title">WageShield could not finish loading this page</h1>
        <p>Your saved review was not intentionally changed. Retry once, then return to your reviews.</p>
        <button type="button" className="button button-primary button-full" onClick={reset}>
          <RefreshCw size={17} /> Try again
        </button>
        <Link href="/cases" className="back-link">
          Open my reviews
        </Link>
      </section>
    </main>
  );
}
