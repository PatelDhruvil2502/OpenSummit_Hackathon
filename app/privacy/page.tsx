import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Clock3, Database, EyeOff, FolderLock, Mail, Trash2 } from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import { COMPANY, companyDetailsArePlaceholders } from "@/lib/company";
import { RETENTION_POLICY } from "@/lib/product-config";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "What WageShield stores, what it deliberately never stores, how long records are kept, and how to delete them.",
};

export default function PrivacyPage() {
  const placeholders = companyDetailsArePlaceholders();
  return (
    <main className="subpage legal-page">
      <SiteHeader />
      <section className="legal-hero page-shell">
        <Link href="/" className="back-link">
          <ArrowLeft size={14} /> Back to overview
        </Link>
        <span className="eyebrow">
          Privacy policy · version {COMPANY.policyVersion} · effective {COMPANY.policyEffectiveDate}
        </span>
        <h1>Your evidence is not a training set.</h1>
        <p>
          {COMPANY.productName} exists to organize employment records you already have. This page
          describes exactly what the running software stores, what it refuses to store, and how you
          remove it. Where the behavior is enforced in code rather than promised in prose, it says so.
        </p>
        {placeholders && (
          <p className="form-error" role="alert">
            This deployment still uses placeholder company details. Set the operator name and contact
            environment values in Render and have counsel review this page before launch.
          </p>
        )}
      </section>

      <section className="section page-shell legal-grid">
        <article className="legal-card">
          <span className="legal-card-icon"><Database size={19} /></span>
          <h2>What we store</h2>
          <ul>
            <li>Your account email, display name, and a PBKDF2-SHA256 password hash. The plaintext password is never stored or logged.</li>
            <li>A session record holding only the SHA-256 hash of your session token, plus its expiry.</li>
            <li>Case settings, the structured facts you reviewed, your corrections, generated findings, and report selections.</li>
            <li>Documents you upload and reports you generate, in private object storage under random case-scoped keys.</li>
            <li>Operational audit events containing opaque IDs, file size and type, stage names, counts, rule version, and timestamps.</li>
          </ul>
        </article>

        <article className="legal-card">
          <span className="legal-card-icon"><EyeOff size={19} /></span>
          <h2>What we deliberately do not store</h2>
          <ul>
            <li>No analytics, advertising, or third-party tracking scripts of any kind.</li>
            <li>No raw document text or evidence excerpts in application logs.</li>
            <li>No structured SSNs, passport numbers, bank accounts, or payment credentials — the product never asks for them.</li>
            <li>No copy of your private case material in the separate official-source corpus.</li>
            <li>No employer, agency, or third-party notification. WageShield never contacts anyone on your behalf.</li>
          </ul>
        </article>

        <article className="legal-card">
          <span className="legal-card-icon"><Clock3 size={19} /></span>
          <h2>How long we keep it</h2>
          <p>
            Every review carries its own retention window, which you choose and can change at any
            time. Options run from {RETENTION_POLICY.options[0].label} to{" "}
            {RETENTION_POLICY.options[RETENTION_POLICY.options.length - 1].label}, defaulting to{" "}
            {RETENTION_POLICY.defaultHours} hours. Changing the setting restarts the window from that
            moment.
          </p>
          <p>
            Expiry is enforced by a scheduled retention job that runs on the{" "}
            <code>{RETENTION_POLICY.sweepCron}</code> cron schedule. It deletes expired cases, their
            stored objects, and their audit rows, and it verifies each object is gone before
            reporting success. Expired cases also stop being readable immediately, before the sweep
            reaches them.
          </p>
        </article>

        <article className="legal-card">
          <span className="legal-card-icon"><Trash2 size={19} /></span>
          <h2>Deleting a review</h2>
          <p>
            The Privacy tab of any review deletes it immediately. Deletion inventories every stored
            object for the case, removes them, confirms each is unreadable, then removes the case
            row, documents, reports, findings, corrections, and audit events.
          </p>
          <p>
            One record survives: a deletion tombstone holding a one-way SHA-256 hash of the case ID,
            the request and completion timestamps, and the policy version. It contains no case
            content and cannot be reversed into a case ID. It is the only case record retained in
            the active database so a deletion can be proven.
          </p>
          <p>
            Render continuously retains point-in-time recovery data for the paid PostgreSQL
            service. On this Hobby deployment, a prior database state can remain recoverable to an
            authorized workspace administrator for up to three days. Recovery copies are not served
            by WageShield; the operator must not restore deleted records into the live service and
            must reapply deletions before using any disaster-recovery database.
          </p>
        </article>

        <article className="legal-card">
          <span className="legal-card-icon"><FolderLock size={19} /></span>
          <h2>Who can reach your records</h2>
          <p>
            Every read of a document, report, or case resolves through a database ownership check
            against your authenticated account before any bytes are returned. A case belonging to
            another account returns the same response as a case that does not exist, so the API
            cannot be used to discover which reviews exist.
          </p>
          <p>
            Stored objects are never exposed as public URLs. Owner identifiers are stripped from
            every JSON response.
          </p>
        </article>

        <article className="legal-card">
          <span className="legal-card-icon"><Mail size={19} /></span>
          <h2>Email and your choices</h2>
          <p>
            WageShield sends exactly one kind of email: a single-use password reset link you
            requested. There is no marketing list and no way to opt into one.
          </p>
          <p>
            To access, correct, export, or delete your data, use the account and review controls in
            the product, or write to{" "}
            <a href={`mailto:${COMPANY.privacyEmail}`}>{COMPANY.privacyEmail}</a>. Do not include
            private records or credentials in that message.
          </p>
        </article>
      </section>

      <section className="section page-shell legal-footnote">
        <h2>Scope and limits</h2>
        <p>
          WageShield organizes evidence and spots documentary differences. It does not decide that a
          law was broken, calculate a legally owed amount, file a complaint, or contact an employer or
          agency. Findings are inputs to a conversation with a qualified professional, not legal
          advice.
        </p>
        <p>
          Questions about this policy:{" "}
          <a href={`mailto:${COMPANY.privacyEmail}`}>{COMPANY.privacyEmail}</a>. Security reports:{" "}
          <Link href="/security">see our security page</Link>. Service terms:{" "}
          <Link href="/terms">terms of service</Link>.
        </p>
      </section>
    </main>
  );
}
