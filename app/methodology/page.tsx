import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowLeft,
  Bot,
  Braces,
  CheckCircle2,
  Database,
  FileLock2,
  Scale,
  ShieldAlert,
} from "lucide-react";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = {
  title: "Methodology",
  description: "How WageShield separates evidence extraction, deterministic comparisons, official context, and human review.",
};

const SAFE_STATUSES = [
  ["No mismatch detected", "Reviewed records agree within the configured comparison tolerance."],
  ["Possible discrepancy", "The documents support a relevant difference; missing context may change interpretation."],
  ["More evidence needed", "A required fact or usable document is missing."],
  ["Documents conflict", "Credible sources disagree and precedence is unresolved."],
  ["Human review recommended", "Context or an exception prevents safe automated resolution."],
];

export default function MethodologyPage() {
  return (
    <main className="subpage method-page">
      <SiteHeader />
      <section className="method-hero page-shell">
        <Link href="/" className="back-link"><ArrowLeft size={14} /> Back to overview</Link>
        <span className="eyebrow">Methodology · version 1.0</span>
        <h1>Document understanding can assist. Versioned code owns the conclusion.</h1>
        <p>
          WageShield is designed around a hard boundary: a parser or model may propose structured facts, but money,
          dates, tolerances, statuses, access, reporting, and deletion stay deterministic and inspectable. This public
          demo uses pre-reviewed synthetic fixtures and an explicit manual fallback, so it needs no external model service.
        </p>
      </section>

      <section className="page-shell method-flow" aria-label="Analysis architecture">
        <article><span><FileLock2 size={20} /></span><strong>Private documents</strong><p>User-authorized records remain case scoped.</p></article>
        <i>→</i>
        <article><span><Bot size={20} /></span><strong>Proposed facts</strong><p>Extraction may return typed values and exact evidence references.</p></article>
        <i>→</i>
        <article><span><Braces size={20} /></span><strong>Pure rules</strong><p>Integer-cent math and half-open date intervals produce neutral statuses.</p></article>
        <i>→</i>
        <article><span><CheckCircle2 size={20} /></span><strong>Human review</strong><p>Every result keeps uncertainty and next questions visible.</p></article>
      </section>

      <section className="section page-shell method-grid">
        <div className="method-main">
          <section>
            <span className="eyebrow">What the system checks</span>
            <h2>Evidence before explanation</h2>
            <p>
              A finding cannot publish without an accepted rule result, same-case evidence references, an approved
              source mapping, and explicit assumptions and limitations. Monetary findings also require a reproducible calculation.
            </p>
            <ul className="method-list">
              <li><CheckCircle2 size={16} /> Ordinary base pay is kept separate from bonuses, taxes, and deductions.</li>
              <li><CheckCircle2 size={16} /> Partial periods and unresolved corrections route to review.</li>
              <li><CheckCircle2 size={16} /> Temporary and remote work qualifiers prevent a simplistic worksite conclusion.</li>
              <li><CheckCircle2 size={16} /> A contract clause is never presented as a completed payroll transaction.</li>
            </ul>
          </section>

          <section>
            <span className="eyebrow">Status vocabulary</span>
            <h2>Responsible abstention is a feature</h2>
            <div className="status-definition-list">
              {SAFE_STATUSES.map(([name, description]) => (
                <div key={name}><strong>{name}</strong><p>{description}</p></div>
              ))}
            </div>
          </section>

          <section>
            <span className="eyebrow">Official context</span>
            <h2>Primary sources stay separate from private evidence</h2>
            <p>
              Findings link to versioned U.S. Department of Labor guidance for the issue category. That material gives
              general context; it does not transform a documentary difference into a case-specific legal conclusion.
            </p>
            <div className="source-link-list">
              <a href="https://www.dol.gov/agencies/whd/fact-sheets/62g-h1b-required-wage" target="_blank" rel="noreferrer">Fact Sheet #62G · Required wage</a>
              <a href="https://www.dol.gov/agencies/whd/fact-sheets/62i-h1b-nonproductive-time" target="_blank" rel="noreferrer">Fact Sheet #62I · Nonproductive time</a>
              <a href="https://www.dol.gov/agencies/whd/fact-sheets/62h-h1b-pay-deductions" target="_blank" rel="noreferrer">Fact Sheet #62H · Deductions</a>
              <a href="https://www.dol.gov/agencies/whd/fact-sheets/62j-h1b-worksite" target="_blank" rel="noreferrer">Fact Sheet #62J · Place of employment</a>
            </div>
          </section>
        </div>

        <aside className="method-aside">
          <div><Database size={19} /><strong>Reproducible</strong><p>Source corpus, rule set, facts, and corrections are versioned in every case snapshot.</p></div>
          <div><ShieldAlert size={19} /><strong>Bounded</strong><p>No complaint filing, employer contact, eligibility decision, or retaliation assurance.</p></div>
          <div><Scale size={19} /><strong>Not legal advice</strong><p>The product organizes records for discussion with a trusted advocate or qualified professional.</p></div>
        </aside>
      </section>
    </main>
  );
}
