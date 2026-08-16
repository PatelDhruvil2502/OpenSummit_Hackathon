# Security model

WageShield implements meaningful application controls, but this repository is not a penetration-test report, compliance certification, malware sandbox, legal review, or guarantee of security. The safe launch posture is a synthetic public evaluation or a tightly access-controlled private beta.

## Implemented controls

- **Authentication:** Email/password accounts use PBKDF2-SHA256 with 210,000 iterations and a random salt. Sessions use a 256-bit random cookie token; D1 stores only its SHA-256 hash. Password resets are hashed, single-use, expiring, and revoke existing sessions.
- **Rate limits:** Sign-in, sign-up, and password-reset attempts are limited by hashed IP and email buckets with bounded windows and lockout.
- **Authorization:** Every case, document, report, mutation, export, and deletion resolves against the authenticated owner on the server. A foreign case has the same response shape as a missing case.
- **Forwarded identity:** `oai-authenticated-user-*` is ignored by default. It is accepted only when `TRUST_FORWARDED_IDENTITY=true` declares a gateway—such as OpenAI Sites—that strips client copies and injects authenticated values.
- **Request boundaries:** JSON, form, and multipart bodies are read under explicit limits. State-changing cross-site requests are rejected; destructive and expensive routes use idempotency receipts that contain resource references rather than private payload snapshots.
- **Upload validation:** A file is capped at 12 MB; each case is capped at 50 documents and 100 MB. Signature, extension, declared type, truncation, and bytes after a PDF end marker are checked. Encrypted PDFs and PDFs declaring JavaScript, embedded files, launch actions, or rich media are rejected.
- **Bounded parsing:** PDF parsing uses the patched `pdfjs-dist` package with evaluation disabled and page/output limits. Parser output remains `NEEDS_REVIEW`; a person must link it to a same-case document/page/excerpt before rules may use it.
- **Private storage:** Source files and reports use random case-scoped R2 keys and never use public bucket URLs. D1 records ownership and SHA-256 integrity metadata.
- **Deterministic analysis:** Pure versioned rule code consumes only reviewed structured facts. Document text cannot invoke tools, change policy, perform the final calculation, or publish a status.
- **Report construction:** Reports are reconstructed from selected allowlisted fields. Redaction rewrites matching identifiers before PDF creation; it does not paint over a copied original layer.
- **Browser/response controls:** Sensitive responses disable caching and MIME sniffing. The Worker sets a restrictive CSP, frame denial, permissions policy, referrer policy, cross-origin isolation headers, and HSTS over HTTPS.
- **Deletion:** Immediate and scheduled deletion inventory case objects, remove D1/R2 state, verify removal, and retain only a content-free one-way tombstone.
- **Supply chain and schema:** Locked dependencies, audit overrides, append-only migrations, fresh-install validation, and old-chain upgrade tests are part of `npm run preflight`.

## Known limits

- Uploads do **not** pass through antivirus, content-disarm/reconstruction, or an independently isolated malware-scanning service. Structural PDF checks are not malware detection.
- The product has no second authentication factor, enterprise SSO policy, administrator console, or per-workspace role model.
- Cloudflare provider encryption at rest is used; the application does not add per-customer or customer-managed encryption keys.
- There has been no independent penetration test, privacy assessment, threat-model review, or legal review of this build.
- Availability monitoring, on-call ownership, scheduled-job alerting, recovery objectives, incident exercises, and Cloudflare/Resend account hardening are operator responsibilities.
- A direct Cloudflare origin cannot safely trust forwarded identity headers unless a separately verified gateway prevents bypass and header spoofing. Leave the flag false for ordinary direct deployment.

These limits block unrestricted public handling of real immigration, payroll, identity, medical, banking, or family records. They do not block a synthetic public demo. A founder who chooses an authorized-record private beta must make the limits explicit, restrict access, minimize data, monitor it, and obtain professional review first.

## Production gates

Before expanding beyond a private beta:

1. Commission independent penetration, privacy, and legal reviews and remediate their findings.
2. Add a malware-scanning/content-disarm boundary appropriate to accepted file types.
3. Define and test observability, PII scrubbing, incident response, scheduled-retention alerts, support verification, abuse response, and disaster recovery.
4. Harden Cloudflare, source-control, domain, and Resend operator accounts with phishing-resistant MFA and least privilege.
5. Confirm dependency and container/runtime scanning in CI; rerun `npm audit --omit=dev` and the full preflight on every release.
6. Validate the final access policy and prove that the Worker origin cannot bypass it before enabling trusted forwarded identity.

## Reporting a vulnerability

Use the configured security contact shown at `/security`. Include the affected route, deployed version, a safe request ID, and a minimal reproduction using generated synthetic data. Never send private records, another person's data, reset links, session cookies, API keys, or passwords in a report.
