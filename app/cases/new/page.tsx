import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Check, FileUp, LockKeyhole, ShieldCheck, TimerReset } from "lucide-react";
import { requireChatGPTUser } from "@/app/chatgpt-auth";
import { SiteHeader } from "@/components/site-header";
import { NewCaseForm } from "@/components/new-case-form";
import { sandboxIsEnabled } from "@/lib/runtime-flags";

export const metadata: Metadata = {
  title: "Start a review",
  description: "Create a private WageShield evidence review and choose its retention period.",
};

export const dynamic = "force-dynamic";

export default async function NewCasePage() {
  const user = await requireChatGPTUser("/cases/new");

  return (
    <main className="subpage intake-page">
      <SiteHeader />
      <section className="intake-hero page-shell">
        <Link href="/cases" className="back-link"><ArrowLeft size={14} /> Back to my reviews</Link>
        <span className="eyebrow"><LockKeyhole size={14} /> Private case intake</span>
        <h1>Start an evidence review.</h1>
        <p>
          Define the employment record before adding documents. Nothing is filed, shared, or sent to an employer or
          agency. Signed in as {user.email}.
        </p>
      </section>

      <section className="intake-layout page-shell">
        <NewCaseForm />
        <aside className="intake-aside" aria-label="What happens next">
          <div className="intake-aside-card">
            <span className="eyebrow">What happens next</span>
            <ol>
              <li><span><FileUp size={16} /></span><div><strong>Add records</strong><p>Upload the LCA, offer, pay records, and only the context you need.</p></div></li>
              <li><span><Check size={16} /></span><div><strong>Confirm facts</strong><p>Inspect every extracted value against its source before analysis.</p></div></li>
              <li><span><ShieldCheck size={16} /></span><div><strong>Review signals</strong><p>See evidence-linked comparisons, assumptions, and explicit uncertainty.</p></div></li>
            </ol>
          </div>
          <div className="intake-aside-card retention-explainer">
            <TimerReset size={20} aria-hidden="true" />
            <strong>Short retention by default</strong>
            <p>The selected window schedules the full case—including uploaded files and generated reports—for deletion.</p>
          </div>
          {sandboxIsEnabled() && (
            <Link href="/sandbox" className="sandbox-side-link">Need to learn the workflow first? <strong>Use fictional records in the sandbox →</strong></Link>
          )}
        </aside>
      </section>
    </main>
  );
}
