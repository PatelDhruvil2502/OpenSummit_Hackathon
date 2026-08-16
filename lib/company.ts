/**
 * Company-specific details that appear in the served legal pages.
 *
 * These are the only company strings a founder must configure before launch. They are kept
 * out of the page components so a legal review can change them in one place,
 * and so nothing in the app silently ships a placeholder that reads as real.
 */
export const COMPANY = {
  productName: "WageShield H-1B",
  /** Registered entity that operates the service. */
  legalName: process.env.NEXT_PUBLIC_COMPANY_LEGAL_NAME ?? "WageShield (entity name pending)",
  /** Governing law and venue for the terms of service. */
  jurisdiction:
    process.env.NEXT_PUBLIC_COMPANY_JURISDICTION ?? "Jurisdiction pending legal review",
  supportEmail: process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "support@wageshield.example",
  privacyEmail: process.env.NEXT_PUBLIC_PRIVACY_EMAIL ?? "privacy@wageshield.example",
  securityEmail: process.env.NEXT_PUBLIC_SECURITY_EMAIL ?? "security@wageshield.example",
  /** Update when the served legal text changes. */
  policyVersion: "1.0",
  policyEffectiveDate: "2026-08-16",
} as const;

/** True when the deployment is still using the shipped placeholder values. */
export function companyDetailsArePlaceholders(): boolean {
  return (
    COMPANY.legalName.toLowerCase().includes("pending") ||
    COMPANY.jurisdiction.toLowerCase().includes("pending") ||
    COMPANY.supportEmail.endsWith(".example") ||
    COMPANY.privacyEmail.endsWith(".example") ||
    COMPANY.securityEmail.endsWith(".example")
  );
}
