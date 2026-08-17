# WageShield developer handoff

Last updated: 2026-08-16

This file gives a new developer the durable context from the startup-readiness,
security, and Render-deployment work completed in the preceding development
session. It is a handoff, not a replacement for the code or the operational
runbook. When this file and an implementation detail disagree, inspect the
current code and tests, then update this file in the same change.

## Read this first

- Repository: `https://github.com/PatelDhruvil2502/OpenSummit_Hackathon`
- Deployable branch: `main`
- Render-port baseline commit: `13bf1a2` (`feat(deploy): port runtime to Render`)
- The baseline was pushed to `origin/main` with a clean worktree.
- The local Git author email is still the placeholder `your-email@example.com`.
  Configure the developer's real or GitHub-noreply address before future
  commits; do not rewrite existing history only to change this metadata.
- No Render service, PostgreSQL database, Featherless/Resend secret, DNS record,
  or custom domain was created by the coding session. Those are still operator
  actions.
- No production secret is stored in Git. Do not add one to this file.
- The immediate public use is the Open Summit Atlas AI for Social Good
  hackathon and must use synthetic records only. A later low-traffic,
  access-controlled investor demo may use authorized real records only after
  the operator completes the additional privacy/security review.
- The founder wants the investor deployment to accept real records that the
  tester is authorized to possess. The deployed experience must start empty;
  it must not substitute fictional or hardcoded case data.
- The production Blueprint therefore fixes `ENABLE_SANDBOX=false`. Fictional
  fixtures remain in the repository only for explicit local evaluation.
- The desired hosting choice is Render because the founder has a $50 Render
  promotion. Cloudflare, Netlify, Vercel Blob, and S3 are not part of the final
  deployment.
- Two third-party APIs are configured: Featherless/OpenAI-compatible inference
  for the optional per-upload AI Evidence Copilot, and Resend for password
  recovery. No vector database, downloaded model, or application GPU is used.

## Product summary

WageShield H-1B is a privacy-oriented, AI-assisted evidence organizer for
employment records. With separate consent for an upload, an extraction model
proposes facts from bounded page images/text and a separate verifier pass grounds
them against exact page evidence or abstains. A user confirms every surviving
proposal before deterministic documentary checks run and can generate a
selective redacted PDF plus a JSON manifest.

The product deliberately does not:

- decide that a law was violated;
- calculate a legally owed amount;
- file or send a complaint;
- contact an employer, attorney, or agency;
- replace legal advice;
- let a model make a legal/financial conclusion, confirm a fact, or run a rule;
  or
- silently send a document to a model without per-upload consent.

The implemented checks cover documentary comparisons involving wages,
nonproductive time, deductions or fees, and employment facts. Rule inputs must
be human-reviewed structured facts. Local-parser and AI output alone is never a
final finding.

## Final deployment architecture

```text
Browser
  |
Render Web Service: Next.js 16 / Node.js
  |-- UI and App Router API routes
  |-- authentication and authorization
  |-- bounded PDF text extraction and page rendering
  |-- two-pass AI evidence adapter (explicit upload consent)
  |-- deterministic rules
  |-- PDF report reconstruction
  |
Render PostgreSQL
  |-- accounts, sessions, reset tokens, rate limits
  |-- cases and serialized case snapshots
  |-- document/report metadata
  |-- private document/report bytes (BYTEA)
  |-- audit events, idempotency receipts, tombstones
  |
Render Cron Job
  `-- retention and expired-state cleanup every 15 minutes

Resend
  `-- password-reset email only

Featherless/OpenAI-compatible API
  `-- bounded multimodal extraction and separate grounding verification
```

`render.yaml` is the authoritative infrastructure definition. It provisions:

- `wageshield-demo`: Starter Node web service in Ohio;
- `wageshield-db`: PostgreSQL 18, Basic 256 MB, 5 GB disk in Ohio; and
- `wageshield-retention`: Starter cron job, scheduled `*/15 * * * *` UTC.

Preview environments are disabled. The web service uses five PostgreSQL pool
connections; the cron process uses two.

Cases default to 24-hour retention. The selectable range is one hour through
seven days, and the scheduled job enforces expiry every 15 minutes.

## Why PostgreSQL also stores files

Earlier options included Cloudflare R2 and Vercel Blob. The final decision was
to keep the short investor demo entirely inside Render and avoid another
provider, another storage token, and Vercel Hobby's non-commercial boundary.

`private_objects` stores private documents and generated reports as PostgreSQL
`BYTEA` rows. The design is intentionally constrained for the short,
low-traffic demo:

- every object belongs to a case through a foreign key with cascade deletion;
- object keys are random, private, and case-scoped;
- there are no public object URLs;
- writes are atomic and never overwrite an existing object;
- reads verify recorded size and SHA-256 integrity;
- one object is limited to 12 MiB;
- one case is limited to 50 source documents and 100 MiB of source files;
- a transaction advisory lock serializes storage-capacity checks;
- live private bytes are capped at 3 GiB globally and 1.5 GiB per account; and
- those limits may be lowered through environment variables but not raised
  above the code's safe defaults.

This is appropriate for the stated demo, not a recommendation to keep large
production-scale object storage inside PostgreSQL forever. The logical byte cap
does not include WAL, indexes, dead tuples, or TOAST overhead. Monitor the 5 GB
disk and revisit the storage architecture before a broader release.

## Important implementation decisions

### Authentication and private-beta access

- Local accounts use normalized email and password authentication.
- Passwords use PBKDF2-SHA256 with 210,000 iterations and a random salt.
- Browser session tokens are random; PostgreSQL stores only their SHA-256 hash.
- Password-reset tokens are hashed, single-use, expire after 30 minutes, and
  revoke existing sessions when consumed.
- Auth attempts are rate-limited using hashed email and IP buckets.
- Render's real client IP is taken from the validated first
  `X-Forwarded-For` entry.
- Successful login clears only the email bucket; it does not erase shared
  network-abuse history.
- Registration fails closed. With the production Blueprint,
  `ALLOW_PUBLIC_SIGNUP=false`, so only exact normalized addresses in
  `INVESTOR_EMAIL_ALLOWLIST` may register.
- Changing an account email cannot bypass that allowlist.
- `TRUST_FORWARDED_IDENTITY=false` is mandatory on the directly reachable
  Render service. Client-supplied `oai-authenticated-user-*` headers are not an
  authentication mechanism.
- Account deletion uses a durable deletion lock so an already-authenticated
  in-flight request cannot create an orphan case after deletion begins.

### Evidence and analysis boundary

- Upload bodies are bounded before parsing.
- PDF, PNG, and JPEG signature, extension, and declared-type checks are
  enforced.
- PDFs with encryption, declared JavaScript, embedded files, launch actions,
  rich media, suspicious truncation, or bytes after the end marker are
  rejected.
- PDF parsing uses patched `pdfjs-dist` with evaluation disabled and bounded
  pages/output.
- A PDF is limited to 200 pages.
- With explicit per-upload consent, AI preparation renders at most six pages to
  bounded metadata-stripped JPEGs and includes bounded extracted text. The
  complete raw PDF is never sent to the provider.
- The AI pipeline makes separate extraction and verification calls. Output is
  schema, count, page, excerpt, and grounding checked; failures and ambiguity
  return to the local/manual path rather than inventing a value.
- AI calls default to a 45-second timeout clamped to 5-60 seconds and retry at
  most once for transient network/HTTP failures. The model has no tools,
  database/storage credentials, retrieval corpus, or rule execution authority.
- Extracted facts, pay periods, deductions, and events are saved as
  `NEEDS_REVIEW`; upload never auto-runs analysis.
- Manual entries require same-case document, page, and source-excerpt
  provenance. Do not replace this with fabricated evidence strings.
- Deterministic rules consume only reviewed structured data.
- Images use the Evidence Copilot only with consent and configured credentials;
  otherwise they use the evidence-linked manual review path.
- Structured collection limits in `lib/product-config.ts` bound facts, pay
  periods, deductions, events, corrections, reports, active cases, and audits.

### Authorization and response safety

- Every case, document, report, correction, export, mutation, and deletion is
  resolved against the authenticated owner on the server.
- Cross-account access uses the same 404-shaped result as a nonexistent case.
- Sensitive responses are private/no-store and disable MIME sniffing.
- Download responses use a sandbox CSP and authenticated application routes;
  no storage URL is exposed.
- Next.js sets CSP, frame denial, permissions, referrer, cross-origin, and HSTS
  headers.
- Browser mutations enforce same-origin protections using the trusted public
  application origin rather than an internal Render URL.

### Idempotency, retention, and deletion

- Idempotency rows store only validated resource references and status, never
  a full case response or private snapshot.
- Replays refetch a still-live, still-authorized resource. A deleted or expired
  resource returns 404.
- Deleting a case purges case-scoped and create-case idempotency receipts.
- The scheduled job purges expired idempotency keys, sessions, reset tokens,
  auth-rate rows, and expired cases.
- Case deletion marks the case `DELETION_PENDING`, inventories and deletes
  private objects, verifies absence, deletes live structured state, and retains
  only a content-free one-way tombstone.
- `private_objects` and `audit_events` have case foreign keys with cascade
  deletion, preventing late orphan rows.
- Render paid PostgreSQL point-in-time recovery can retain recoverable prior
  database state for up to the provider's backup window. The served privacy and
  security text discloses the three-day Hobby window. A recovery procedure must
  reapply deletions before a restored database serves traffic.

## Work completed in the preceding session

The repository arrived with an interrupted launch-hardening effort. The work
was inspected, completed, and then ported from a Cloudflare-specific runtime to
Render. The completed changes include:

1. Restored a clean lint, typecheck, test, and production-build baseline.
2. Centralized product limits and enforced active-case, document, report,
   structured-record, audit, and private-storage quotas.
3. Added complete password recovery with safe reset-token storage, Resend
   delivery, single use, expiry, session revocation, no-store/no-referrer reset
   pages, and production-safe failure behavior.
4. Added and hardened account profile, export, session, and permanent-deletion
   behavior, including deletion/concurrent-creation protection.
5. Enforced fail-closed forwarded identity and exact-email private-beta signup.
6. Ensured parser proposals remain `NEEDS_REVIEW` and cannot automatically run
   analysis.
7. Replaced sensitive idempotency response snapshots with safe live-resource
   receipts and deletion/sweep cleanup.
8. Added request-size boundaries, atomic auth throttles, fixed-length hashed
   buckets, cleanup, and Render proxy-aware client IP handling.
9. Added served privacy, terms, and security pages plus company/contact launch
   readiness checks.
10. Replaced Cloudflare D1 with `node-postgres` and a Drizzle PostgreSQL schema.
11. Replaced Cloudflare R2/Vercel Blob plans with private PostgreSQL `BYTEA`
    storage and safe capacity controls.
12. Replaced the Cloudflare/Vinext worker build with standard Next.js 16 on
    Render, including `$PORT` binding, proxy gating, liveness, and deep health.
13. Added a Render retention CLI and cron definition.
14. Replaced the retired SQLite/D1 migration tree with the append-only
    `drizzle-render/` PostgreSQL chain.
15. Reworked integration tests to start a production Next server against a
    temporary real PostgreSQL database and exercise the production PostgreSQL
    object driver.
16. Removed Cloudflare, Wrangler, Vinext, OpenAI Sites, and Vercel Blob runtime
    configuration and dependencies.
17. Added the full founder-facing deployment, verification, cost-control, and
    teardown runbook in `DEPLOYMENT.md`.

The current hackathon change adds the two-pass multimodal AI Evidence Copilot,
strict grounding/abstention contracts, per-upload consent and fallback,
provider/model provenance, a review UI, provider-safe privacy/security copy,
and a synthetic evaluation harness. Do not copy the older verification counts
below into a submission as evidence for this change; rerun the current preflight
and the explicit AI evaluation first.

## Verification evidence

The pre-AI Render baseline was verified twice, including once immediately after
a clean dependency installation:

```text
npm ci --include=dev                 PASS
npm run lint                        PASS
npm run typecheck                   PASS
npm run db:check                    PASS
npm run test:unit                   PASS (48/48)
npm run build                       PASS
npm run test:integration            PASS (30/30)
npm audit --omit=dev                PASS (0 vulnerabilities)
git diff --check                    PASS
Render live Blueprint-schema check  PASS
```

Integration tests ran against native PostgreSQL 17.5. `render.yaml` targets
PostgreSQL 18; the migration and SQL features used are compatible. The suites
cover accounts, password recovery, authorization, uploads, extraction,
analysis, report generation/download, idempotency, retention, document/case/
account deletion, security headers, rendered pages, and process persistence.

Passing tests are evidence, not a claim that the system has received an
independent penetration, privacy, or legal review.

## Environment contract

The sanitized contract is `.env.example`. Production values marked
`sync: false` are entered when applying the Render Blueprint.

### Supplied automatically by Render

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Private Render PostgreSQL connection string |
| `RENDER_EXTERNAL_URL` | Canonical initial `onrender.com` HTTPS origin |
| `PORT` | Web-service listener port |

### Required operator inputs

| Variable | Purpose |
| --- | --- |
| `AI_EVIDENCE_API_KEY` | Dedicated server-only Featherless inference key |
| `RESEND_API_KEY` | Dedicated Resend sending key |
| `EMAIL_FROM` | Sender on the exact verified Resend domain |
| `EMAIL_REPLY_TO` | Monitored reply-capable address |
| `INVESTOR_EMAIL_ALLOWLIST` | Comma-separated exact founder/investor emails |
| `NEXT_PUBLIC_COMPANY_LEGAL_NAME` | Truthful operating person or entity shown in policies |
| `NEXT_PUBLIC_COMPANY_JURISDICTION` | Governing jurisdiction/venue shown in terms |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | Monitored support address |
| `NEXT_PUBLIC_PRIVACY_EMAIL` | Monitored privacy/deletion address |
| `NEXT_PUBLIC_SECURITY_EMAIL` | Monitored vulnerability-reporting address |

The support, privacy, security, and reply-to values may point to the same
monitored mailbox for the small demo. `NEXT_PUBLIC_*` values are deliberately
visible in rendered pages and are not secrets. They are build-time values;
changing them requires a redeploy. Blank, malformed, `.example`, `pending`, or
`replace with` values keep `/api/v1/health` from reporting launch readiness.

`PUBLIC_APP_URL` is optional for the initial Render hostname because
`RENDER_EXTERNAL_URL` is supplied by Render. When a custom domain is attached,
set `PUBLIC_APP_URL` to its exact HTTPS origin and redeploy.

The Blueprint pins these non-secret AI defaults:

```text
AI_EVIDENCE_BASE_URL=https://api.featherless.ai/v1
AI_EVIDENCE_MODEL=Qwen/Qwen3-VL-8B-Instruct
AI_EVIDENCE_VERIFIER_MODEL=Qwen/Qwen3-VL-8B-Instruct
AI_EVIDENCE_TIMEOUT_MS=45000
```

Changing either model requires a fresh synthetic evaluation. The verifier model
may be blank in `.env.local`, in which case it uses the extraction model.

### Blueprint-fixed safety values

```text
NODE_ENV=production
DATABASE_POOL_MAX=5                 # web; cron uses 2
OBJECT_STORAGE_DRIVER=postgres
OBJECT_STORAGE_GLOBAL_MAX_BYTES=3221225472
OBJECT_STORAGE_ACCOUNT_MAX_BYTES=1610612736
TRUST_FORWARDED_IDENTITY=false
ENABLE_SANDBOX=false
ALLOW_PUBLIC_SIGNUP=false
```

Do not change the last three values for the real-record investor demo without a
new security review.

## Deployment status and remaining operator work

The pre-AI Render baseline is pushed. The current hackathon AI change must pass
the full preflight, receive a real synthetic provider evaluation, be committed,
and be pushed before deployment. The deployment itself is not yet live. The
next developer or founder must:

1. Apply the $50 promotion to the intended Render workspace under
   **Billing -> Credit Balance** and record its expiration.
2. Create a dedicated Featherless API key, keep the pinned model pair, and run
   the real synthetic AI evaluation.
3. Add and verify a Resend sending domain or subdomain.
4. Create a restricted Resend sending key and store it outside Git.
5. Collect the exact founder and investor email allowlist.
6. Supply truthful company/operator, jurisdiction, and monitored contact
   values. These are configuration, not missing application code.
7. In Render, choose **New -> Blueprint**, connect this repository, select
   `main`, and apply `render.yaml`.
8. Enter every `sync: false` value before the initial build.
9. Wait for `npm run db:migrate`, the web deployment, and cron provisioning.
10. Check `/api/v1/live`, then require `/api/v1/health` to return HTTP 200 with
   every configuration flag and `launch_ready` set to `true`.
11. Perform every public-URL smoke test in `DEPLOYMENT.md`, including a new
    synthetic consented AI upload, explicit abstention, two-user
    cross-account isolation, reset reuse/session revocation, report integrity,
    verified deletion, retention trigger, restart persistence, and log review.
12. Monitor Render credit, unbilled usage, database disk, web health,
    Featherless inference, Resend delivery, and cron results throughout the
    demo.
13. After the demo, delete application cases/accounts, trigger retention,
    delete the web/cron/database resources, revoke both API keys, and confirm no
    unbilled resource remains.

### Clarifications from the prior hosting discussion

- Cloudflare was explored but is not compulsory and is no longer part of the
  runtime.
- Netlify was considered earlier and is not the selected deployment target.
- Vercel Blob and S3-style object storage are not used in the final demo stack.
- “Only API keys remain” is not literally complete: operator configuration,
  real provider evaluation, truthful
  truthful operator/legal identity, contacts, investor allowlist, sender/DNS
  configuration, deployment, and smoke testing still require human input.
- “No hardcoded data” means no hardcoded production user/case records. Fixed,
  versioned rules, limits, policy versions, official-source context, and
  disabled synthetic test fixtures are intentionally committed application
  code.
- The Render release expects a fresh PostgreSQL database. Historical
  Cloudflare D1/R2 data is not migrated automatically.
- The deployment is not inherently free. Its paid Render resources consume the
  promotion, which is not a hard spending cap.

The Blueprint deliberately uses paid Render resources for predictable behavior.
The $50 promotion is an invoice credit, not a hard spending cap. It is expected
to be adequate for the stated low-traffic one-to-two-week demo, but eligibility,
expiry, a required payment method, and usage remain operator responsibilities.

## Known limits and work before a public launch

No known code blocker remains for the synthetic hackathon path, but a real
provider run has not been claimed without an API key. The following are real
launch gates before unrestricted public handling of immigration,
payroll, identity, medical, banking, or family records:

- independent penetration testing and remediation;
- an independent privacy/threat-model assessment;
- jurisdiction-specific legal review of privacy and terms;
- malware scanning or content disarm/reconstruction for uploads;
- phishing-resistant MFA and least-privilege controls for Render, source
  control, DNS, and Resend operators;
- product MFA/SSO and a reviewed administrative/role model if needed;
- PII-scrubbed monitoring, alerts, on-call ownership, incident response, abuse
  response, and privacy-request runbooks;
- tested recovery objectives and a deletion-aware database restoration
  procedure;
- dependency/runtime scanning in CI and release-by-release audits;
- capacity, load, cost, and PostgreSQL disk/autovacuum testing; and
- reconsideration of dedicated object storage before materially larger traffic
  or record volume; and
- provider/model licensing, retention, data-location, DPA/consent review, and an
  independent AI evaluation before any real-record inference.

Do not describe the current build as compliant, certified, independently
audited, malware-safe, or ready for unrestricted public real-record use.

## File map for the next developer

| Area | Primary files |
| --- | --- |
| Render infrastructure | `render.yaml`, `DEPLOYMENT.md`, `.env.example` |
| Node/PostgreSQL connection | `db/index.ts`, `db/migrate.ts` |
| PostgreSQL schema/migrations | `db/schema.ts`, `drizzle.config.ts`, `drizzle-render/` |
| Private binary storage | `lib/object-storage.ts`, `lib/storage.ts` |
| Accounts and password recovery | `lib/accounts.ts`, `lib/email.ts`, `app/api/auth/` |
| Identity/CSRF/runtime flags | `lib/identity.ts`, `lib/security.ts`, `lib/runtime-flags.ts`, `proxy.ts` |
| Upload and extraction | `app/api/v1/cases/[caseId]/uploads/route.ts`, `lib/extraction.ts` |
| AI input/orchestration | `lib/ai-evidence-input.ts`, `lib/ai-evidence.ts` |
| AI evaluation | `docs/AI_EVALUATION.md`, `scripts/run-ai-evaluation.ts`, `tests/ai-evals/` |
| Deterministic analysis | `lib/rules.ts`, `lib/case-workflow.ts` |
| Reports | `lib/report.ts`, `app/api/v1/cases/[caseId]/reports/` |
| Limits and retention | `lib/product-config.ts`, `scripts/retention-sweep.ts` |
| Health | `app/api/v1/live/route.ts`, `app/api/v1/health/route.ts` |
| Integration harness | `scripts/run-integration-tests.mjs`, `tests/helpers/worker-harness.mjs` |
| Product/security decisions | `docs/ARCHITECTURE.md`, `docs/SPEC_DECISIONS.md`, `SECURITY.md` |
| Served legal/privacy copy | `app/privacy/`, `app/terms/`, `app/security/`, `lib/company.ts` |

## Development workflow

Requirements: Node.js 22.13 or newer and PostgreSQL. The integration runner can
use `TEST_DATABASE_URL`, a local Homebrew PostgreSQL installation, or Docker.

```bash
git switch main
git pull --ff-only origin main
npm ci
cp .env.example .env.local
# Replace placeholders and point DATABASE_URL to a disposable local database.
npm run db:migrate
npm run dev
```

Before proposing a change:

```bash
npm run preflight
npm audit --omit=dev
git diff --check
```

The normal preflight runs the AI scorer unit tests but never calls a provider or
claims a benchmark. With a dedicated key and synthetic data only, create a real
prediction artifact explicitly:

```bash
npm run ai:evaluate -- --predictions /tmp/wageshield-ai-predictions.json
```

Score and inspect it using `docs/AI_EVALUATION.md`; do not commit a key, raw
provider envelope, or manually edited result.

Database migrations are append-only:

1. Edit `db/schema.ts`.
2. Run `npm run db:generate -- --name <descriptive_name>`.
3. Inspect the generated SQL and snapshot.
4. Run `npm run db:check` and the full preflight.
5. Never rewrite a migration that may have reached a shared database.

Never commit `.env.local`, an AI/Resend key, a Render connection URL, reset token,
session cookie, private record, or investor email list. Use generated synthetic
records for automated and local tests.

Before making a commit, replace the repository's placeholder Git email in the
developer's local configuration, for example with an actual address or a valid
GitHub-noreply address. When served privacy or terms text changes, update the
policy version/effective date and review signup-consent persistence at the same
time.

## Non-negotiable regression rules

A future change should be rejected if it does any of the following without an
explicitly reviewed product/security redesign:

- reintroduces Cloudflare/Vinext/Vercel/S3 runtime assumptions into the Render
  release;
- exposes a public document or report URL;
- trusts forwarded identity on a directly reachable Render service;
- makes missing investor allowlist configuration enable public registration;
- lets parser or AI output become `CONFIRMED` or automatically trigger analysis;
- invokes AI without explicit per-upload consent;
- sends a complete raw PDF, more than the bounded page set, account identity,
  case history, or a provider credential to the inference request;
- lets document text alter a prompt policy, choose a model/endpoint, invoke a
  tool, access storage, or run a rule;
- accepts unsupported AI candidates without strict schema, page/excerpt, and
  separate grounding checks;
- lets rules consume unreviewed facts;
- invents document/page/excerpt evidence for manual data;
- stores full private response bodies in idempotency rows;
- skips owner revalidation on an idempotent replay;
- removes object integrity, quota, case binding, or verified-deletion checks;
- logs reset URLs, tokens, cookies, evidence, or raw record contents in
  production;
- weakens cross-account 404 behavior;
- changes served policy values to hardcoded fictional operator data; or
- makes `npm run preflight` pass by skipping real PostgreSQL integration.

## Authoritative references inside the repository

- Start with `README.md` for the product and local workflow.
- Use `DEPLOYMENT.md` for exact Render, Featherless, Resend, smoke-test,
  monitoring, and teardown steps.
- Use `SECURITY.md` for implemented controls and known limits.
- Use `PRIVACY.md` and `TERMS.md` for operator/legal review notes.
- Use `docs/ARCHITECTURE.md` and `docs/SPEC_DECISIONS.md` for technical and
  product-boundary rationale.
- Use `docs/AI_EVALUATION.md` for the synthetic dataset, metric definitions,
  run procedure, and honest result-reporting rules.

This handoff intentionally contains no secret value and no real user record.
