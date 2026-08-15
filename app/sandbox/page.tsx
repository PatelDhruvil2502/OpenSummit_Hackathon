import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, FlaskConical, LockKeyhole } from "lucide-react";
import { getChatGPTUser, getSignInPath } from "@/app/chatgpt-auth";
import { SiteHeader } from "@/components/site-header";
import { SandboxCases } from "@/components/sandbox-cases";

export const metadata: Metadata = {
  title: "Fictional sandbox",
  description: "Explore WageShield with clearly labeled fictional employment records.",
};

export const dynamic = "force-dynamic";

type SandboxPageProps = {
  searchParams: Promise<{ scenario?: string | string[] }>;
};

export default async function SandboxPage({ searchParams }: SandboxPageProps) {
  const params = await searchParams;
  const requestedScenario = Array.isArray(params.scenario) ? params.scenario[0] : params.scenario;
  const initialScenario = requestedScenario === "clean" || requestedScenario === "ambiguous" ? requestedScenario : "hero";
  const user = await getChatGPTUser();
  const signInPath = user ? "" : await getSignInPath("/sandbox");

  return (
    <main className="subpage sandbox-page">
      <SiteHeader />
      <section className="sandbox-hero page-shell">
        <Link href="/" className="back-link"><ArrowLeft size={14} /> Back to WageShield</Link>
        <span className="eyebrow"><FlaskConical size={14} /> Fictional learning environment</span>
        <h1>Learn the entire workflow without using real records.</h1>
        <p>
          Choose a prebuilt case to inspect traceable facts, calculations, uncertainty, reports, and deletion. Every name,
          employer, date, document, and amount in this sandbox is fictional.
        </p>
        <div className="sandbox-boundary"><LockKeyhole size={15} /> Do not upload real employment records into a sandbox case.</div>
      </section>
      <section className="page-shell sandbox-content">
        <SandboxCases signedIn={Boolean(user)} signInPath={signInPath} initialScenario={initialScenario} />
      </section>
    </main>
  );
}
