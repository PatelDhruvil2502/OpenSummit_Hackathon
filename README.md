# WageShield H-1B

WageShield is a privacy-first evidence auditor for H-1B employment records. It organizes a worker-controlled case, keeps every material fact linked to a source excerpt, runs four deterministic checks, and reconstructs a selective redacted PDF for human review.

It does **not** decide that a law was broken, calculate a legally owed amount, file a complaint, or contact an employer or agency.

## What is included

- A polished responsive landing page, methodology page, private case list, and seven-part review workspace.
- Three complete synthetic evaluation cases: a guided positive case, a clean negative control, and an intentionally ambiguous abstention case.
- A blank synthetic workflow with validated PDF/PNG/JPEG upload and a manual reviewed-fact fallback.
- Four pure, network-free rules for wage benchmarking, nonproductive time, deductions/fees, and employment-fact consistency.
- Integer-cent money arithmetic, explicit uncertainty states, evidence excerpts, official-source context, and reproducible calculation rows.
- Case-scoped Cloudflare D1 persistence and private R2 document/report objects.
- Email and password sign up / sign in, with accounts and sessions stored in D1, plus optional Sign in with ChatGPT on hosted Sites.
- Short retention settings, deletion verification, and non-substantive deletion tombstones.
- Allowlisted PDF reconstruction with selectable findings, worker/employer redaction, SHA-256 verification, and a JSON manifest.

## Quick start

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The local Sites runtime emulates the configured `DB` and `BUCKET` bindings; no cloud credentials or API keys are needed.

Create an account at `/signup`. Email, display name, and a PBKDF2 password hash are stored in D1. Sign in at `/signin` issues an HttpOnly session cookie. Cases stay scoped to that account.

Useful commands:

```bash
npm run lint
npm run typecheck
npm run test:unit
npm test
npm run build
npm run db:generate
```

## Demo path

1. Choose **Open guided demo**.
2. Confirm the two clear-use statements and create the private review.
3. Inspect each finding's evidence, exact calculation, official context, assumptions, and review questions.
4. Open **Report**, select findings and redactions, then generate the evidence packet.
5. Open **Privacy** to change retention or exercise complete case deletion.

The hosted demo accepts fictional records only. The guided fixtures are visibly watermarked and are not real people or employers.

## Architecture

```text
React / Next-compatible App Router UI
          |
Cloudflare Worker API routes
          |
   +------+------------------+
   |                         |
D1 case snapshots        R2 private objects
   |                         |
reviewed facts         documents + reports
   +-----------+-------------+
               |
      deterministic rules
               |
  evidence-linked findings + PDF
```

The public demo is deliberately dependency-free at runtime. Guided cases contain pre-reviewed synthetic facts; blank cases use an explicit human-reviewed structured fallback after upload. The extraction boundary is represented in the fact/evidence contracts, but external OCR/model calls are not enabled in the public demo. This keeps the deployed project fully functional without sending records to a third party.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for boundaries and [docs/SPEC_DECISIONS.md](docs/SPEC_DECISIONS.md) for blueprint conflicts resolved during implementation.

## Main API

All routes live under `/api/v1`:

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

Cross-case access returns the same 404-shaped response as a missing case. Error payloads contain only a stable code, safe message, request ID, and retryability flag.

All case routes require an authenticated user. Hosted requests use the stable `oai-authenticated-user-id` supplied by Sites; neither client-provided owner IDs nor email addresses are accepted for authorization. Local development identity cookies are honored only on `localhost`, `127.0.0.1`, or `::1`.

## Project map

```text
app/                  pages and versioned API routes
components/           interactive product UI
lib/fixtures.ts       synthetic canonical cases
lib/rules.ts          four deterministic modules
lib/report.ts         allowlisted PDF reconstruction
lib/storage.ts        D1/R2 case-scoped persistence
db/ + drizzle/        schema and migrations
tests/                rendered-route checks
output/pdf/           verified synthetic sample report
docs/                 design and specification decisions
```

## Safety and scope

Read [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md) before adapting the demo for real records. Production use would additionally require malware scanning, retention jobs, key management, incident response, and formal legal/privacy review beyond this hackathon implementation.
