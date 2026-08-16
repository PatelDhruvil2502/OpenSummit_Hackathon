import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Scale } from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import { COMPANY, companyDetailsArePlaceholders } from "@/lib/company";

export const metadata: Metadata = {
  title: "Terms of service",
  description: "The agreement covering use of WageShield, including its explicit limits.",
};

const SECTIONS: Array<{ heading: string; body: string[] }> = [
  {
    heading: "1. What this service is",
    body: [
      `${COMPANY.productName} is a document-organization tool. You upload employment records you are authorized to possess, review the values it extracts, and it runs fixed, published comparisons between those values. It produces an evidence packet you can share with someone you trust.`,
      "It is a records tool, not a decision-maker.",
    ],
  },
  {
    heading: "2. What this service is not",
    body: [
      "WageShield does not provide legal advice and is not a law firm, an immigration adviser, or a substitute for either. No attorney-client relationship is created by using it.",
      "It does not determine that a law was violated, calculate an amount legally owed to you, assess immigration status or eligibility, file any complaint, or contact your employer, any agency, or any third party.",
      "A finding labeled \"possible discrepancy\" means the documents you supplied differ from one another. It does not mean a violation occurred. Context absent from your documents can fully explain a difference.",
    ],
  },
  {
    heading: "3. Your responsibilities",
    body: [
      "You confirm that you are authorized to possess and upload every record you submit, and that uploading it does not breach a contract, court order, or law that applies to you.",
      "You are responsible for verifying every extracted value against the original document before relying on it. The product shows you the source excerpt for each value specifically so you can check it.",
      "You must not upload another person's records without their authorization, use the service to harass anyone, or attempt to circumvent its access controls, rate limits, or storage quotas.",
      "You must keep your password confidential. Anyone holding it can read every review in your account.",
    ],
  },
  {
    heading: "4. Accounts and termination",
    body: [
      "You need an account to create reviews. You may delete any review at any time from its Privacy tab, and deletion is verified before it reports success.",
      `We may suspend or terminate an account that violates these terms, that we are legally required to act on, or that is being used to attack the service. Where circumstances permit, we will give notice to the account email first.`,
      "You may stop using the service at any time. Deleting your reviews removes the underlying records as described in the privacy policy.",
    ],
  },
  {
    heading: "5. Availability and changes",
    body: [
      "The service is provided on an as-available basis. Reviews carry a retention window you choose, and expired reviews are deleted automatically — this is a feature, not a failure. Do not treat WageShield as your only copy of any document.",
      `We may change these terms. Material changes will be reflected in the version and effective date at the top of this page, and continued use after that date constitutes acceptance.`,
    ],
  },
  {
    heading: "6. Disclaimers and limitation of liability",
    body: [
      "To the fullest extent permitted by law, the service is provided \"as is\" and \"as available\", without warranties of any kind, whether express, implied, or statutory, including any warranty of merchantability, fitness for a particular purpose, accuracy, or non-infringement.",
      "To the fullest extent permitted by law, our aggregate liability arising out of or relating to the service is limited to the greater of the amount you paid us for the service in the twelve months preceding the claim, or one hundred United States dollars.",
      "We are not liable for indirect, incidental, special, consequential, exemplary, or punitive damages, or for lost profits, lost data, or decisions you or anyone else made based on output from the service.",
      "Some jurisdictions do not allow certain exclusions or limitations, so parts of this section may not apply to you.",
    ],
  },
  {
    heading: "7. Governing law",
    body: [
      `These terms are governed by the laws of ${COMPANY.jurisdiction}, without regard to its conflict-of-law rules. The courts located there have exclusive jurisdiction over disputes arising from these terms, except that either party may seek injunctive relief in any court of competent jurisdiction.`,
    ],
  },
  {
    heading: "8. Contact",
    body: [
      `Questions about these terms: ${COMPANY.supportEmail}. Do not include private records or credentials in your message.`,
    ],
  },
];

export default function TermsPage() {
  const placeholders = companyDetailsArePlaceholders();
  return (
    <main className="subpage legal-page">
      <SiteHeader />
      <section className="legal-hero page-shell">
        <Link href="/" className="back-link">
          <ArrowLeft size={14} /> Back to overview
        </Link>
        <span className="eyebrow">
          Terms of service · version {COMPANY.policyVersion} · effective {COMPANY.policyEffectiveDate}
        </span>
        <h1>Plain terms for a deliberately narrow tool.</h1>
        <p>
          These terms cover your use of {COMPANY.productName}, operated by {COMPANY.legalName}. By
          creating an account or uploading a record, you agree to them.
        </p>
        <p className="legal-callout">
          <Scale size={17} aria-hidden="true" />
          <span>
            This document is written to describe what the software actually does. It is not a
            substitute for review by a licensed attorney in your jurisdiction, which you should
            obtain before offering this service commercially.
          </span>
        </p>
        {placeholders && (
          <p className="form-error" role="alert">
            This deployment still uses placeholder company details. Set the operating entity,
            jurisdiction, and contact addresses in <code>lib/company.ts</code> before launch.
          </p>
        )}
      </section>

      <section className="section page-shell legal-prose">
        {SECTIONS.map((section) => (
          <article key={section.heading}>
            <h2>{section.heading}</h2>
            {section.body.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </article>
        ))}
        <article>
          <h2>Related pages</h2>
          <p>
            <Link href="/privacy">Privacy policy</Link> · <Link href="/security">Security</Link> ·{" "}
            <Link href="/methodology">Methodology</Link>
          </p>
        </article>
      </section>
    </main>
  );
}
