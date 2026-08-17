# Security model

WageShield implements meaningful application controls, but this repository is not a penetration-test report, compliance certification, malware sandbox, legal review, or guarantee of security. The safe launch posture is a synthetic public evaluation or a tightly access-controlled private beta.

## Implemented controls

- **Authentication:** Email/password accounts use PBKDF2-SHA256 with 210,000 iterations and a random salt. Sessions use a 256-bit random cookie token; PostgreSQL stores only its SHA-256 hash. Password resets are hashed, single-use, expiring, and revoke existing sessions.
- **Rate limits:** Sign-in, sign-up, and password-reset attempts are limited by hashed IP and email buckets with bounded windows and lockout.
- **Authorization:** Every case, document, report, mutation, export, and deletion resolves against the authenticated owner on the server. A foreign case has the same response shape as a missing case.
- **Private-beta registration:** Registration fails closed unless an address exactly matches `INVESTOR_EMAIL_ALLOWLIST` or the operator deliberately sets `ALLOW_PUBLIC_SIGNUP=true`. The Render Blueprint fixes public signup to false. `oai-authenticated-user-*` forwarded identity remains disabled on Render because no sanitizing identity gateway is configured.
- **Request boundaries:** JSON, form, and multipart bodies are read under explicit limits. State-changing cross-site requests are rejected; destructive and expensive routes use idempotency receipts that contain resource references rather than private payload snapshots.
- **Upload validation:** A file is capped at 12 MB; each case is capped at 50 documents and 100 MB. Signature, extension, declared type, truncation, and bytes after a PDF end marker are checked. Encrypted PDFs and PDFs declaring JavaScript, embedded files, launch actions, or rich media are rejected.
- **Bounded parsing:** PDF parsing uses the patched `pdfjs-dist` package with evaluation disabled and page/output limits. Parser output remains `NEEDS_REVIEW`; a person must link it to a same-case document/page/excerpt before rules may use it.
- **Untrusted AI boundary:** When explicitly configured and separately
  consented for an upload, the AI Evidence Copilot sends up to six bounded JPEG
  page images plus bounded extracted text to a server-side OpenAI-compatible
  inference endpoint; it never sends the complete raw PDF. Document content is
  always treated as untrusted data, never as
  instructions. The model has no tools, storage credentials, account context,
  rule-execution capability, or direct database access. Responses pass strict
  shape, size, page, excerpt, and same-document evidence checks.
- **Separate grounding verification and abstention:** Extraction and evidence
  verification are separate model passes. Unsupported candidates are rejected;
  missing, conflicting, or ambiguous support produces an explicit abstention.
  Every surviving candidate remains `NEEDS_REVIEW` until a person confirms or
  corrects it. Provider timeout, refusal, malformed JSON, invalid citations, or
  network failure returns to human review and never fabricates a result.
- **Inference resource bounds:** Page count, render dimensions/pixels, text,
  response bytes, and candidate counts are bounded. Each provider request uses
  a timeout clamped to 5-30 seconds (20 seconds by default) and has at most one
  retry for a transient HTTP/network failure. Provider errors are sanitized
  before persistence or display.
- **AI credential and provenance:** The provider API key is read only by the
  Node service and is never sent to the browser, stored in a case, or exposed by
  readiness endpoints. A run records bounded provenance such as provider,
  model, prompt/schema version, completion time, sanitized outcome counts, and
  verifier decisions; raw prompts, responses, base64 pages, page text, and
  provider errors are not persisted as AI-run telemetry. Provenance does not
  turn a model response into a legal or financial conclusion.
- **Private storage:** Source files and reports are stored as private PostgreSQL binary rows under random case-scoped keys. PostgreSQL records ownership and SHA-256 integrity metadata; authenticated application routes mediate every read.
- **Deterministic analysis:** Pure versioned rule code consumes only reviewed structured facts. Document text cannot invoke tools, change policy, perform the final calculation, or publish a status.
- **Report construction:** Reports are reconstructed from selected allowlisted fields. Redaction rewrites matching identifiers before PDF creation; it does not paint over a copied original layer.
- **Browser/response controls:** Sensitive responses disable caching and MIME sniffing. Next.js sets a restrictive CSP, frame denial, permissions policy, referrer policy, cross-origin isolation headers, and HSTS over HTTPS.
- **Deletion:** Immediate and scheduled deletion inventory case objects, remove them from the live PostgreSQL service, verify removal, and retain only a content-free one-way tombstone in the active database. Render's paid-database point-in-time recovery window can retain a recoverable prior state for up to three days on Hobby and must be governed by the operator's recovery procedure.
- **Supply chain and schema:** Locked dependencies, audit overrides, append-only migrations, fresh-install validation, and old-chain upgrade tests are part of `npm run preflight`.

## Known limits

- Uploads do **not** pass through antivirus, content-disarm/reconstruction, or an independently isolated malware-scanning service. Structural PDF checks are not malware detection.
- AI output can be incomplete, inconsistent, or wrong. Schema validation,
  citation checks, a second model pass, and human confirmation reduce risk but
  do not establish factual correctness. The current synthetic evaluation suite
  is a regression harness, not an independent model audit or accuracy claim.
- A configured inference provider is a separate processor and third-party
  availability boundary. The operator must review the provider's current
  logging/retention policy, model license, data location, account plan, and
  incident terms before sending any real private record. The hackathon demo is
  synthetic-only.
- The product has no second authentication factor, enterprise SSO policy, administrator console, or per-workspace role model.
- Render PostgreSQL provider encryption at rest is used; the application does not add per-customer or customer-managed encryption keys.
- There has been no independent penetration test, privacy assessment, threat-model review, or legal review of this build.
- Availability monitoring, on-call ownership, scheduled-job alerting, recovery objectives, incident exercises, and Render/Resend account hardening are operator responsibilities.
- A directly reachable Render service cannot safely trust forwarded identity headers unless a separately verified gateway prevents bypass and header spoofing. Leave the flag false.

These limits block unrestricted public handling of real immigration, payroll, identity, medical, banking, or family records. They do not block a synthetic public demo. A founder who chooses an authorized-record private beta must make the limits explicit, restrict access, minimize data, monitor it, and obtain professional review first.

## Production gates

Before expanding beyond a private beta:

1. Commission independent penetration, privacy, and legal reviews and remediate their findings.
2. Add a malware-scanning/content-disarm boundary appropriate to accepted file types.
3. Define and test observability, PII scrubbing, incident response, scheduled-retention alerts, support verification, abuse response, and disaster recovery.
4. Harden Render, source-control, domain, and Resend operator accounts with phishing-resistant MFA and least privilege.
5. Confirm dependency and container/runtime scanning in CI; rerun `npm audit --omit=dev` and the full preflight on every release.
6. Validate the investor allowlist and final access policy. Do not enable trusted forwarded identity without a separately reviewed sanitizing gateway and origin-bypass proof.

## Reporting a vulnerability

Use the configured security contact shown at `/security`. Include the affected route, deployed version, a safe request ID, and a minimal reproduction using generated synthetic data. Never send private records, another person's data, reset links, session cookies, API keys, or passwords in a report.
