# WageShield H-1B

WageShield is a privacy-first, AI-assisted evidence auditor for H-1B employment
records. Its two-pass Evidence Copilot extracts document facts and separately
verifies their page citations, explicitly abstaining when support is ambiguous.
A person confirms every surviving proposal before four deterministic
documentary checks can run, and the product can reconstruct a selective,
redacted PDF for human review.

It does **not** decide that a law was broken, calculate a legally owed amount, file a complaint, contact an employer or agency, or provide legal advice.

## Launch posture

The code supports two deliberately different uses:

- **Public evaluation:** synthetic records only. The included guided, clean-control, and ambiguous cases are fictional and visibly marked.
- **Access-controlled private beta:** a tester may use a record they are authorized to possess after accepting the served terms and reviewing the known limits in [SECURITY.md](SECURITY.md). This is not a certification that the service is ready for unrestricted public handling of immigration or payroll records.

The public hackathon/evaluation experience is synthetic-only. When configured,
the AI Evidence Copilot sends bounded page images and extracted text through a server-side
Featherless or other OpenAI-compatible inference endpoint for separate
extraction and verification passes. Provider output is untrusted, schema
validated, citation checked, and always saved as `NEEDS_REVIEW`; a failure or
uncertain result returns to manual review rather than guessing. All money,
calendar, status, reporting, access-control, and deletion logic remains
deterministic. Resend is used only for password-reset email.

## Included product

- Responsive landing, methodology, policy, account, case-list, and seven-part review surfaces.
- Email/password accounts, hashed sessions, account export/deletion, single-use password recovery, and fail-closed exact-email investor registration.
- Guided positive, clean negative-control, and intentionally ambiguous synthetic cases.
- PDF/PNG/JPEG upload with signature and structural validation, bounded text-layer parsing, and manual reviewed-fact fallback.
- Two-pass AI evidence extraction and verification with strict structured
  output, page/excerpt grounding, explicit abstentions (including
  conflict-coded warnings within the supplied document), run
  provenance, and a hard human-confirmation gate.
- Deterministic wage, nonproductive-time, deductions/fees, and employment-fact checks using exact or integer-cent arithmetic.
- Case-scoped Render PostgreSQL persistence, including private document/report bytes.
- Selective report generation with configurable redaction, SHA-256 verification, and a JSON manifest.
- One-hour to seven-day case retention, 24-hour default, immediate verified removal from the live service, and a scheduled expiry sweep every 15 minutes.

## Local setup

Requirements: Node.js 22.13 or newer.

```bash
npm ci
cp .env.example .env.local
npm run db:migrate
npm run dev
```

Before migrating, set `DATABASE_URL` to a PostgreSQL database. Open
[http://localhost:3000](http://localhost:3000). Without Resend configuration,
localhost uses the development password-reset flow. Without AI configuration,
local parsing and manual review continue to work, but the AI Evidence Copilot
is unavailable and the build is not a complete hackathon demo.

To exercise the real AI workflow, create a Featherless API key and select a
compatible model from its catalog, then set these server-side values in
`.env.local`:

```dotenv
AI_EVIDENCE_API_KEY=replace-with-your-key
AI_EVIDENCE_BASE_URL=https://api.featherless.ai/v1
AI_EVIDENCE_MODEL=Qwen/Qwen3-VL-8B-Instruct
# Optional: use a different model for the separate verifier pass.
AI_EVIDENCE_VERIFIER_MODEL=
```

Never prefix the key with `NEXT_PUBLIC_`, expose it in browser code, or commit
`.env.local`. See [DEPLOYMENT.md](DEPLOYMENT.md) for Render setup and
[docs/AI_EVALUATION.md](docs/AI_EVALUATION.md) for the reproducible synthetic
evaluation protocol.

Before sharing a build, run:

```bash
npm run preflight
```

The preflight runs lint, type checking, PostgreSQL migration checks, unit tests,
the AI scorer's non-provider arithmetic tests, a production Next.js build, and
the integration suites in `tests/*.test.mjs`. It does not spend inference
credits or claim a model benchmark; the real provider evaluation is an explicit
operator command documented in [docs/AI_EVALUATION.md](docs/AI_EVALUATION.md).

## Private-beta path

The Render deployment fixes `ENABLE_SANDBOX=false`, so its investor workflow
starts with an empty case and stores only data supplied by an authenticated,
allowlisted account:

1. Create a blank case and select the shortest practical retention period.
2. Upload a record that the tester is authorized to possess and separately
   consent to external AI processing for that upload. A declined consent keeps
   the record on the local parser/manual path.
3. Inspect the Evidence Copilot's supported, rejected, and abstained proposals.
   Confirm every surviving value against its source page and excerpt; provider
   failures and uncertain documents use the manual reviewed-fact flow.
4. Run the deterministic checks and inspect every finding's evidence,
   calculation, official context, assumptions, and review questions.
5. Open **Report**, explicitly select what may leave the review, choose
   redactions, and generate the evidence packet.
6. Open **Privacy** to export the account, change retention, or exercise verified
   deletion.

The fictional guided, control, and ambiguous fixtures are local evaluation aids
only. They are reachable only when a developer explicitly sets
`ENABLE_SANDBOX=true`; they are not the deployed investor experience.

## Architecture

```text
React 19 + Next.js App Router
             |
Render Node Web Service
       |             |
       |      AI Evidence Copilot
       |      extraction -> verifier
       |      (Featherless/OpenAI-compatible)
       |
     Render PostgreSQL
  structured state + private bytes
accounts, cases, facts, documents, reports
                    |
          deterministic rules
                    |
        evidence-linked PDF + manifest
                    |
           Render retention cron
```

Private evidence and public official-source context stay separate. Local parsers
and models can only propose `NEEDS_REVIEW` facts; reviewed facts are the sole
rule input. Reports are rebuilt from allowlisted structured fields rather than
copying original document layers. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
and [docs/SPEC_DECISIONS.md](docs/SPEC_DECISIONS.md).

## Why the AI is substantive

The model is not a chatbot or a report-summary button. It performs two bounded,
auditable stages in the core evidence workflow:

1. **Extractor:** proposes structured employment facts, pay periods,
   deductions, dates, normalized values, and exact page excerpts.
2. **Verifier:** receives the source pages and proposals in a separate grounding
   pass, rejects unsupported values, and records explicit abstentions. A
   conflict observed within the supplied document is represented conservatively
   as `CONFLICTING_EVIDENCE`, not as a cross-document conclusion.

Only schema-valid, source-grounded proposals reach the review UI, and even
those require human confirmation. The synthetic evaluation harness measures
exact-value extraction, citation validity/page accuracy, abstention behavior,
and conflict-abstention behavior; it ships no fabricated benchmark score. See
[docs/AI_EVALUATION.md](docs/AI_EVALUATION.md).

## Main API

All versioned routes live under `/api/v1`:

- `GET|POST /cases`
- `GET|PATCH|DELETE /cases/:caseId`
- `POST /cases/:caseId/uploads`
- `POST /cases/:caseId/facts/manual`
- `POST /cases/:caseId/facts/:factId/corrections`
- `POST /cases/:caseId/analyses`
- `PATCH /cases/:caseId/findings/:findingId`
- `POST /cases/:caseId/reports`
- `GET /cases/:caseId/reports/:reportId`
- `GET /cases/:caseId/reports/:reportId/manifest`

Cross-account access has the same 404-shaped response as a missing case. Error payloads expose only a stable code, safe message, request ID, and retryability flag.

## Deployment

[DEPLOYMENT.md](DEPLOYMENT.md) is the complete operator runbook for the Render Blueprint, PostgreSQL migrations, Resend, policy variables, smoke tests, cost control, and launch gates.

Read [PRIVACY.md](PRIVACY.md), [SECURITY.md](SECURITY.md), and [TERMS.md](TERMS.md) before accepting real private-beta records. The served `/privacy`, `/security`, and `/terms` pages are the visitor-facing copies; their entity, jurisdiction, and contact placeholders must be replaced and reviewed by counsel before launch.
