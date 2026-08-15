import Link from "next/link";
import {
  ArrowUpRight,
  BadgeCheck,
  Calculator,
  Check,
  FileCheck2,
  FileSearch,
  FolderLock,
  MapPinned,
  ReceiptText,
  ShieldCheck,
  Sparkles,
  TimerReset,
} from "lucide-react";
import { LandingActions } from "@/components/landing-actions";
import { SiteHeader } from "@/components/site-header";
import { getChatGPTUser, getSignInPath } from "@/app/chatgpt-auth";

const CHECKS = [
  {
    icon: Calculator,
    number: "01",
    title: "Documented wage benchmark",
    text: "Compares ordinary base pay with the wage listed in the uploaded LCA and accepted offer.",
  },
  {
    icon: TimerReset,
    number: "02",
    title: "Nonproductive time",
    text: "Aligns no-work intervals with employer messages, availability, active employment, and pay records.",
  },
  {
    icon: ReceiptText,
    number: "03",
    title: "Deductions and fees",
    text: "Separates observed payroll lines from clauses, routine deductions, and unclear descriptions.",
  },
  {
    icon: MapPinned,
    number: "04",
    title: "Employment facts",
    text: "Shows where employer, dates, pay, role, or worksite details differ across records.",
  },
];

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getChatGPTUser();
  const signInPath = user ? "" : await getSignInPath("/cases/new");
  return (
    <main>
      <SiteHeader />
      <section className="hero-section">
        <div className="hero-glow" aria-hidden="true" />
        <div className="hero-grid page-shell">
          <div className="hero-copy">
            <div className="trust-chip"><BadgeCheck size={15} /> Evidence first. Human reviewed.</div>
            <h1>Turn scattered employment records into a clear evidence map.</h1>
            <p className="hero-lede">
              WageShield compares an H-1B worker&apos;s LCA, offer, pay records, timesheets, and work messages—then shows
              exactly what differs, how the math works, and what still needs human review.
            </p>
            <LandingActions signedIn={Boolean(user)} signInPath={signInPath} />
            <div className="hero-trust-row">
              <span><FolderLock size={15} /> Private case storage</span>
              <span><Calculator size={15} /> Deterministic math</span>
              <span><ShieldCheck size={15} /> No automatic filing</span>
            </div>
          </div>

          <div className="evidence-preview" aria-label="Example WageShield finding">
            <div className="preview-topbar">
              <span className="preview-dots"><i /><i /><i /></span>
              <span>Evidence review · fictional example</span>
              <span className="preview-secure"><FolderLock size={13} /> private</span>
            </div>
            <div className="preview-body">
              <div className="preview-kicker">Documented wage benchmark</div>
              <div className="preview-status"><span>Possible discrepancy</span><small>Review soon</small></div>
              <h2>Observed ordinary base pay is below the uploaded LCA benchmark.</h2>
              <p>Six complete biweekly periods were compared. Bonuses, deductions, and the separate no-work interval were excluded.</p>
              <div className="preview-math">
                <span><small>LCA benchmark</small><strong>$4,615.38</strong></span>
                <span className="math-arrow">→</span>
                <span><small>Observed base</small><strong>$3,769.23</strong></span>
                <span className="math-result"><small>Difference</small><strong>$846.15</strong></span>
              </div>
              <div className="preview-evidence-row">
                <span><FileCheck2 size={14} /> LCA · p.2</span>
                <span><FileCheck2 size={14} /> Paystub · p.1</span>
                <span><BadgeCheck size={14} /> DOL source</span>
              </div>
              <div className="preview-limit">
                <Sparkles size={15} /> Comparison signal only—not a legal determination or amount owed.
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="proof-band" aria-label="Product commitments">
        <div className="page-shell proof-grid">
          <div><strong>4</strong><span>narrow, versioned checks</span></div>
          <div><strong>100%</strong><span>finding-to-evidence traceability</span></div>
          <div><strong>0</strong><span>automatic complaints or contacts</span></div>
          <div><strong>24h</strong><span>default review retention</span></div>
        </div>
      </section>

      <section className="section page-shell" id="checks">
        <div className="section-heading split-heading">
          <div>
            <span className="eyebrow">Focused by design</span>
            <h2>Four checks. Every conclusion stays inspectable.</h2>
          </div>
          <p>
            No opaque score and no alarmist label. Each module can find a possible difference, show consistency, ask for
            more evidence, or recommend human review.
          </p>
        </div>
        <div className="check-grid">
          {CHECKS.map((check) => {
            const Icon = check.icon;
            return (
              <article className="check-card" key={check.number}>
                <div className="check-card-top"><span>{check.number}</span><Icon size={21} /></div>
                <h3>{check.title}</h3>
                <p>{check.text}</p>
              </article>
            );
          })}
        </div>
      </section>

      <section className="section workflow-section">
        <div className="page-shell workflow-grid">
          <div className="workflow-copy">
            <span className="eyebrow">One guided workflow</span>
            <h2>From folder to review packet, without losing the trail.</h2>
            <p>
              High-impact facts stay beside their source. Corrections create a new version, rules rerun from reviewed
              inputs, and the report includes only what the worker selects.
            </p>
            <Link href="/methodology" className="text-link">Read the methodology <ArrowUpRight size={15} /></Link>
          </div>
          <ol className="workflow-list">
            <li><span>1</span><div><strong>Add records</strong><p>Use a checklist for the LCA, offer, paystubs, and optional context.</p></div></li>
            <li><span>2</span><div><strong>Review the facts</strong><p>Confirm wages, periods, names, locations, and evidence excerpts.</p></div></li>
            <li><span>3</span><div><strong>Compare consistently</strong><p>Versioned code handles money, time intervals, tolerances, and statuses.</p></div></li>
            <li><span>4</span><div><strong>Choose what leaves</strong><p>Build a reconstructed PDF, inspect redactions, download, or delete the case.</p></div></li>
          </ol>
        </div>
      </section>

      <section className="section page-shell" id="privacy">
        <div className="privacy-panel">
          <div className="privacy-icon"><FileSearch size={30} /></div>
          <div>
            <span className="eyebrow">Privacy is part of the workflow</span>
            <h2>Your evidence is not a prompt library.</h2>
            <p>
              Case files stay in private, case-scoped storage. Official sources remain separate. Reports are rebuilt from
              an allowlist, and case deletion removes stored documents, reports, and private rows before returning a verified result.
            </p>
          </div>
          <div className="privacy-list">
            <span><Check size={15} /> Account-scoped private reviews</span>
            <span><Check size={15} /> No raw document text in logs</span>
            <span><Check size={15} /> Immediate user-controlled deletion</span>
            <span><Check size={15} /> No employer or agency contact</span>
          </div>
        </div>
      </section>

      <section className="closing-section page-shell">
        <span className="eyebrow">Start with the right boundary</span>
        <h2>A careful answer can be more useful than a confident one.</h2>
        <p>Create a private evidence review, or learn the full workflow first with clearly labeled fictional records.</p>
        <LandingActions signedIn={Boolean(user)} signInPath={signInPath} />
      </section>

      <footer className="site-footer">
        <div className="page-shell footer-grid">
          <div>
            <strong>WageShield H-1B</strong>
            <p>Evidence organization and issue spotting. Not legal advice.</p>
          </div>
          <div className="footer-links"><Link href="/methodology">Methodology</Link><Link href="/cases">My reviews</Link><a href="https://www.dol.gov/agencies/whd/workers/h1b" target="_blank" rel="noreferrer">DOL worker guidance</a></div>
          <small>Private evidence review · Human judgment required</small>
        </div>
      </footer>
    </main>
  );
}
