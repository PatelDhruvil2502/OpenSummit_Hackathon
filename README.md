# WageShield H-1B

WageShield is a privacy-first evidence auditor for H-1B employment records. It keeps each reviewed fact linked to a source excerpt, runs four deterministic documentary checks, and reconstructs a selective, redacted PDF for human review.

It does **not** decide that a law was broken, calculate a legally owed amount, file a complaint, contact an employer or agency, or provide legal advice.

## Launch posture

The code supports two deliberately different uses:

- **Public evaluation:** synthetic records only. The included guided, clean-control, and ambiguous cases are fictional and visibly marked.
- **Access-controlled private beta:** a tester may use a record they are authorized to possess after accepting the served terms and reviewing the known limits in [SECURITY.md](SECURITY.md). This is not a certification that the service is ready for unrestricted public handling of immigration or payroll records.

The remaining launch work is operator configuration and independent review, not an ML-model download. WageShield makes no external OCR or model call: searchable PDF text is parsed inside the Worker, images route to evidence-linked manual review, and every rule is deterministic. The only external API integration is optional-in-development but required-for-production password-reset email through Resend.

## Included product

- Responsive landing, methodology, policy, account, case-list, and seven-part review surfaces.
- Email/password accounts, hashed sessions, account export/deletion, single-use password recovery, and optional OpenAI Sites identity.
- Guided positive, clean negative-control, and intentionally ambiguous synthetic cases.
- PDF/PNG/JPEG upload with signature and structural validation, bounded text-layer parsing, and manual reviewed-fact fallback.
- Deterministic wage, nonproductive-time, deductions/fees, and employment-fact checks using exact or integer-cent arithmetic.
- Case-scoped Cloudflare D1 persistence and private R2 document/report storage.
- Selective report generation with configurable redaction, SHA-256 verification, and a JSON manifest.
- One-hour to seven-day case retention, 24-hour default, immediate verified deletion, and a scheduled expiry sweep every 15 minutes.

## Local setup

Requirements: Node.js 22.13 or newer.

```bash
npm ci
cp .env.example .env.local
cp .dev.vars.example .dev.vars
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Local D1 and R2 bindings are emulated; no cloud account, API key, or model is needed for the product workflow. Without Resend configuration, a requested local password-reset link is written to the local development log.

Before sharing a build, run:

```bash
npm run preflight
```

The preflight runs lint, type checking, Drizzle history validation, fresh/upgrade migration tests, unit tests, a deployment build, and all integration suites in `tests/*.test.mjs`.

## Demo path

1. Open the synthetic sandbox and create the guided review.
2. Inspect every finding's evidence, calculation, official context, assumptions, and review questions.
3. Open **Report**, explicitly select what may leave the review, choose redactions, and generate the evidence packet.
4. Open **Privacy** to change retention or exercise verified deletion.
5. For the blank workflow, upload only a generated synthetic PDF or image, confirm source/page/excerpt references, and run the same checks.

## Architecture

```text
React 19 + Vinext App Router
             |
Cloudflare-compatible Worker
       +-----+------------------+
       |                        |
  D1 structured state      R2 private objects
       |                        |
accounts, cases, facts     documents + reports
       +------------+-----------+
                    |
          deterministic rules
                    |
        evidence-linked PDF + manifest
```

Private evidence and public official-source context stay separate. Parsers can only propose `NEEDS_REVIEW` facts; reviewed facts are the sole rule input. Reports are rebuilt from allowlisted structured fields rather than copying original document layers. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/SPEC_DECISIONS.md](docs/SPEC_DECISIONS.md).

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

[DEPLOYMENT.md](DEPLOYMENT.md) is the complete operator runbook for OpenAI Sites and direct Cloudflare deployment, D1 migration, R2 setup, Resend, trusted identity, policy variables, smoke tests, and launch gates.

Read [PRIVACY.md](PRIVACY.md), [SECURITY.md](SECURITY.md), and [TERMS.md](TERMS.md) before accepting real private-beta records. The served `/privacy`, `/security`, and `/terms` pages are the visitor-facing copies; their entity, jurisdiction, and contact placeholders must be replaced and reviewed by counsel before launch.
