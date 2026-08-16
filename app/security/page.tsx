import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Bug, FileWarning, KeySquare, ShieldCheck, UserCheck } from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import { COMPANY } from "@/lib/company";
import { UPLOAD_POLICY, formatByteSize } from "@/lib/product-config";

export const metadata: Metadata = {
  title: "Security",
  description: "The controls WageShield enforces in code, and how to report a vulnerability.",
};

export default function SecurityPage() {
  return (
    <main className="subpage legal-page">
      <SiteHeader />
      <section className="legal-hero page-shell">
        <Link href="/" className="back-link">
          <ArrowLeft size={14} /> Back to overview
        </Link>
        <span className="eyebrow">Security · version {COMPANY.policyVersion}</span>
        <h1>Controls we enforce, stated precisely.</h1>
        <p>
          Everything below is implemented in the running code, not aspirational. Where a control has
          a known limit, the limit is stated rather than omitted.
        </p>
      </section>

      <section className="section page-shell legal-grid">
        <article className="legal-card">
          <span className="legal-card-icon"><UserCheck size={19} /></span>
          <h2>Identity and access</h2>
          <ul>
            <li>Passwords are hashed with PBKDF2-SHA256 at 210,000 iterations and a per-account random salt. Verification is constant-time.</li>
            <li>Sign-in issues a 256-bit random session token; only its SHA-256 hash is stored. The cookie is HttpOnly, SameSite=Lax, and Secure over HTTPS.</li>
            <li>Sign-in, sign-up, and password reset are rate limited per IP and per email address, with lockout windows.</li>
            <li>A password reset revokes every session for the account. Changing your password from the account page revokes every other session.</li>
            <li>Every case read and write resolves ownership against your account in the database before returning data. A foreign case is indistinguishable from a missing one.</li>
          </ul>
        </article>

        <article className="legal-card">
          <span className="legal-card-icon"><FileWarning size={19} /></span>
          <h2>Upload handling</h2>
          <ul>
            <li>Files are limited to {formatByteSize(UPLOAD_POLICY.maximumFileBytes)}, with a {formatByteSize(UPLOAD_POLICY.maximumCaseBytes)} and {UPLOAD_POLICY.maximumCaseDocuments}-document ceiling per review.</li>
            <li>Type is determined from the file signature, not the declared MIME type or the filename. A mismatch between signature, extension, and declared type is rejected.</li>
            <li>Container integrity is checked: truncated files and bytes appended after a PDF end marker are rejected.</li>
            <li>Encrypted PDFs and PDFs containing JavaScript, embedded files, launch actions, or rich media are rejected before any parsing.</li>
            <li>PDFs are read for their text layer only, capped at {UPLOAD_POLICY.maximumPdfPages} pages. Images are never guessed at — they route to manual review.</li>
          </ul>
        </article>

        <article className="legal-card">
          <span className="legal-card-icon"><KeySquare size={19} /></span>
          <h2>Data handling</h2>
          <ul>
            <li>Documents and reports are stored under random, case-scoped object keys and are never exposed as public URLs.</li>
            <li>Private responses set no-store caching, nosniff, and a per-request trace ID. Document downloads are served with a sandbox content-security-policy.</li>
            <li>Responses carry a strict CSP, frame-ancestors none, HSTS over HTTPS, and a restrictive permissions policy.</li>
            <li>Mutating requests are rejected when they originate cross-site, and destructive or expensive operations require an idempotency key.</li>
            <li>Audit events record opaque identifiers, stages, counts, sizes, and versions — never names, wages, excerpts, or file contents.</li>
          </ul>
        </article>

        <article className="legal-card">
          <span className="legal-card-icon"><ShieldCheck size={19} /></span>
          <h2>Analysis boundary</h2>
          <ul>
            <li>Findings are produced only by pure, versioned rule code from facts you reviewed. Document text cannot invoke a tool, change policy, or publish a status.</li>
            <li>All money arithmetic uses integer cents or exact rational arithmetic. Aggregate expectations are rounded once, after aggregation.</li>
            <li>Reports are rebuilt from an allowlist of structured fields. Original document layers are never copied, so excluded content is absent rather than covered over.</li>
            <li>Redaction rewrites matching identifiers across every included field and excerpt before the PDF is produced.</li>
          </ul>
        </article>

        <article className="legal-card">
          <span className="legal-card-icon"><Bug size={19} /></span>
          <h2>Reporting a vulnerability</h2>
          <p>
            Email <a href={`mailto:${COMPANY.securityEmail}`}>{COMPANY.securityEmail}</a> with the
            affected route, the build version, and a minimal reproduction using synthetic data.
          </p>
          <p>
            Never include real records, another person&apos;s data, or credentials in a report. Please
            give us a reasonable window to remediate before public disclosure. We do not pursue legal
            action against good-faith research that respects these boundaries.
          </p>
        </article>

        <article className="legal-card">
          <span className="legal-card-icon"><FileWarning size={19} /></span>
          <h2>Known limits</h2>
          <ul>
            <li>Uploads are not scanned by an antivirus or content-disarm engine. Structural validation is not malware detection.</li>
            <li>There is no second authentication factor yet. Account safety rests on your password.</li>
            <li>Object storage uses the provider&apos;s encryption at rest; WageShield does not add customer-managed keys.</li>
            <li>An independent penetration test and privacy assessment have not been performed on this build.</li>
          </ul>
        </article>
      </section>

      <section className="section page-shell legal-footnote">
        <h2>Related pages</h2>
        <p>
          <Link href="/privacy">Privacy policy</Link> · <Link href="/terms">Terms of service</Link> ·{" "}
          <Link href="/methodology">Methodology</Link>
        </p>
      </section>
    </main>
  );
}
