# Privacy notes

This file is the operator/auditor companion to the visitor-facing `/privacy` page. It describes the current software; it is not a substitute for a jurisdiction-specific privacy policy or data-processing assessment.

## Permitted launch scope

- A public or broadly shared evaluation must use generated synthetic records only.
- Authorized real records may be accepted only in an access-controlled private beta after the operator completes the mandatory items in [DEPLOYMENT.md](DEPLOYMENT.md), discloses the limits in [SECURITY.md](SECURITY.md), and obtains appropriate legal/privacy review.
- Do not advertise WageShield as a legal adviser, law firm, immigration decision-maker, payroll adjudicator, or secure archive.

## Data the product stores

- Account email, display name, PBKDF2-SHA256 password hash, policy-consent version/time, and hashed session tokens in Render PostgreSQL.
- Hashed, single-use password-reset tokens and hashed rate-limit buckets. Raw passwords, session tokens, reset tokens, and raw rate-limit emails are not stored.
- Case settings, reviewed structured facts, evidence excerpts, corrections, findings, report selections, and retention timestamps.
- Accepted AI Evidence Copilot proposals plus sanitized abstention counts,
  warnings, and bounded run provenance such as provider, model, prompt/schema
  version, timing, and completion status. Raw provider prompts, responses,
  rendered base64 pages, extracted page text, and provider errors are not
  persisted as AI-run telemetry. Model proposals remain unreviewed until a
  person confirms or corrects them.
- Uploaded documents and generated reports as private binary rows in Render PostgreSQL under random case-scoped keys, together with ownership and integrity metadata.
- Safe operational audit metadata: opaque IDs, event stage, document size/type, counts, rule/policy versions, and timestamps.
- In the active database after deletion, a tombstone containing only a one-way SHA-256 case-ID hash, request/completion times, and deletion-policy version.

## Data deliberately excluded

- No advertising, analytics, behavioral profiling, or third-party tracking scripts.
- No raw file bodies or evidence excerpts in normal application logs.
- No employer, agency, or other third-party notification and no automatic complaint filing.
- No copy of private case material in the separate official-source corpus.
- No structured SSN, passport, banking, card, medical, or government-credential field. Users should redact unnecessary identifiers before upload.
- No claim that private evidence is used to train WageShield's own model;
  WageShield does not train or fine-tune one. When the AI Evidence Copilot is
  enabled for an individual upload with explicit consent, up to six bounded
  JPEG page images plus bounded extracted page text are transferred to the
  configured inference provider for separate extraction and verification
  requests. A complete raw PDF is not transferred. The provider API key and raw
  authentication headers are never case data.

## Retention and deletion

Each case has an independent retention period from one hour through seven days; the default is 24 hours. Changing it restarts the window from that moment.

An expired case becomes unreadable immediately at the ownership query boundary. The Render Cron Job runs every 15 minutes (`*/15 * * * *`) and inventories, deletes, and verifies expired case records and private binary objects. Physical removal therefore occurs on the next successful sweep, normally within 15 minutes of expiry. Operators must monitor failed cron runs; a cron declaration without alerting is not an operational guarantee.

A user can delete a case immediately from the live service. Deletion covers original objects, report objects, structured case content, object inventories, case audit events, and case-scoped idempotency state, then verifies the objects and record are no longer accessible through the application. The active database retains only the non-substantive tombstone described above to prove the deletion was completed.

The paid Render PostgreSQL service continuously keeps point-in-time recovery data. On the Hobby workspace used by this Blueprint, a previous database state can remain recoverable by an authorized Render workspace administrator for up to three days. These recovery copies are not queried or exposed by WageShield, and deleting a Render database also removes its backups. The operator must not restore a point before a user's deletion except under a documented, legally reviewed disaster-recovery process; if a recovery is unavoidable, deleted records must be removed again before the recovered database is connected to the application.

Account controls provide an export and verified account deletion. Account deletion revokes sessions and removes account-owned cases before removing the account. A user must not treat the service as the only copy of a document, because short retention is a product feature.

## Processors and credentials

Render processes the Node application, PostgreSQL records and private
document/report bytes, cron execution, delivery traffic, and its documented
recovery copies. Resend receives the destination email address and
password-reset message only when the user requests account recovery. No
evidence document is sent to Resend.

When configured, OpenRouter and its selected downstream model host receive the
bounded page images, extracted text, and task prompts
required for two inference passes after the user consents for that upload.
OpenRouter states that it does not retain prompts or completions unless prompt
logging is explicitly enabled. Downstream providers have separate policies, so
the application requests `data_collection: "deny"` by default and requires an
explicit synthetic-only override before permitting data-collecting endpoints.
Those provider statements are not WageShield guarantees and may change. The
operator must review the current policy, chosen model license, account plan,
data location, subprocessors, incident terms, and any data-processing
agreement before enabling AI for a real private record. See
[OpenRouter provider logging](https://openrouter.ai/docs/guides/privacy/provider-logging/)
and [zero-data-retention controls](https://openrouter.ai/docs/guides/features/zdr).

The public hackathon demonstration must use generated synthetic records only,
which avoids sending a real person's payroll or immigration evidence to the
inference provider. No evidence document is sent to Resend.

## Operator obligations before launch

- Replace every `.example` contact and the pending entity/jurisdiction values.
- Have counsel review the served `/privacy` and `/terms` pages and set a real effective date/version when text changes.
- Decide the lawful basis, user eligibility, geographic scope, request-response procedure, and incident notice process.
- Restrict support tickets to non-sensitive metadata; never ask users to email employment records or credentials.
- Keep the public demo synthetic-only. Before enabling AI for authorized real
  private-beta records, document the provider/model decision, verify its
  current retention and training terms, obtain any required agreement or
  consent, and update both the served privacy notice and processing inventory.
- Rotate `OPENROUTER_API_KEY` if exposed; never place it in a `NEXT_PUBLIC_*`
  variable, browser bundle, log, screenshot, evaluation result, or repository.
- Test export, immediate deletion, scheduled expiry, password reset, and cross-account denial against the deployed environment.

Localhost may emit a password-reset link to the local development log when Resend is not configured. Production refuses reset-link creation without an explicit canonical HTTPS origin and email provider.
