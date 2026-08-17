# Architecture and trust boundaries

## Runtime

WageShield is a modular monolith built with React 19, the Next.js App Router on Node.js, TypeScript, PostgreSQL, Zod, Drizzle, pdf-lib, a patched PDF.js text-layer parser, and an optional two-pass AI Evidence Copilot. One Render Web Service serves the UI, versioned API routes, authenticated downloads, and the server-only inference adapter; a separate Render Cron Job invokes the same retention domain functions.

The evidence path deliberately separates probabilistic document understanding
from deterministic product decisions:

- Guided cases generate watermarked source PDFs and their already-reviewed
  structured facts together. They are local synthetic controls, not claimed AI
  evaluations.
- Searchable PDFs are parsed within the Node service under page, byte, image,
  and output bounds. Local parser values remain `NEEDS_REVIEW`.
- With explicit per-upload consent and configured provider credentials, the
  Evidence Copilot renders at most six bounded PDF pages to JPEG (or bounds a
  directly uploaded image), includes bounded extracted page text when present,
  and sends that multimodal task through a server-side OpenAI-compatible
  endpoint. It never sends the complete raw PDF.
  The extraction pass proposes structured facts, pay periods, deductions, and
  citations. A distinct verifier pass must support or reject those proposals
  and may explicitly abstain.
- Provider output is untrusted. Zod schemas and application checks enforce
  response limits, valid page references, exact supporting excerpts, and the
  permitted proposal vocabulary before anything is displayed.
- A verified model proposal is still only a proposal. It cannot become
  `CONFIRMED`, enter a rule, run an analysis, generate a finding, or leave the
  review in a report until a person reviews it.
- Unsupported files, provider failures, invalid output, and uncertain evidence
  return to a source-document, page, and verbatim-excerpt manual review flow.

## Data path

1. Sign-up stores an account in Render PostgreSQL. Sign-in issues an HttpOnly cookie whose random token is hashed in PostgreSQL. Private-beta registration fails closed unless the normalized email exactly matches the configured investor allowlist; public signup requires a separate explicit opt-in.
2. Case creation freezes consent, retention, official-source-corpus, and rule-set versions.
3. Uploads are streamed under a request cap, signature/structure validated,
   hashed, and stored as PostgreSQL binary rows under random case-scoped keys.
4. Local extraction produces bounded page text and deterministic parser
   candidates. If the user consents and AI is configured, bounded page JPEGs
   and text enter the extractor/verifier pipeline; the raw complete PDF and
   provider credential never enter a provider payload or browser response.
5. AI run provenance records the provider, model, prompt/schema version,
   completion timing, verifier decisions, and abstentions needed to reproduce
   and audit the behavior. The API key is never case data.
6. Reviewed facts retain their displayed value, normalized rule input, review
   status, and exact same-case evidence reference.
7. `runAllRules` executes four pure modules using integer cents, exact
   rationals, and explicit calendar logic.
8. Findings carry status, calculation rows, same-case evidence, approved
   official context, assumptions, limitations, and questions.
9. The report service reconstructs only selected fields into a new PDF, hashes
   it, and stores a matching manifest.
10. Immediate deletion and the 15-minute Render cron sweep inventory case
    objects, remove private bytes and structured PostgreSQL rows from the live
    service, verify removal, and retain only a content-free one-way tombstone in
    the active database. Render's documented PITR window is a separate
    processor recovery boundary.

## Hard boundaries

- Parsers or models may propose facts; they may not perform final calculations or publish findings.
- Document text cannot override the system task, invoke a tool, request a
  credential, choose an endpoint/model, or alter a case outside its bounded
  proposal response.
- A model's confidence is not evidence. A supported proposal requires a valid
  same-document page and an excerpt present on that page; weak support must
  abstain.
- Private evidence and official public guidance use separate data types and presentation surfaces.
- A public source supplies context, never proof about a private case.
- Money uses integer cents or rational numerator/denominator arithmetic; aggregate rounding occurs once.
- Ambiguous periods, labels, dates, deductions, and temporary/remote worksites route to abstention or human review.
- Reports never copy original document layers.
- Every object read resolves through an owner-scoped PostgreSQL record before any private bytes are returned.
- `oai-authenticated-user-*` headers are ignored unless the runtime explicitly trusts a gateway that strips client copies and injects authenticated values.

## AI request boundary

```text
validated upload + explicit AI consent
      |
up to 6 bounded page JPEGs + bounded local text
      |
AI extraction pass ---------> strict candidate schema
      |                                |
      `---- AI verifier pass <---------'
                       |
      supported / rejected / abstained proposals
                       |
               human review gate
                       |
        deterministic rules and reporting
```

`AI_EVIDENCE_API_KEY` is server-only. `AI_EVIDENCE_BASE_URL` defaults to the
Featherless OpenAI-compatible API and the pinned default extraction model is
`Qwen/Qwen3-VL-8B-Instruct`. `AI_EVIDENCE_VERIFIER_MODEL` can pin a different
verifier and otherwise uses the extraction model. Each provider call defaults
to a 20-second timeout clamped to 5-30 seconds, with at most one retry for a
transient network/HTTP failure. The AI adapter is not an autonomous agent: it
has no tool loop, retrieval corpus, browser, database connection, or write
authority.

## Persistence

Render PostgreSQL is the source of truth for accounts, hashed sessions and password resets, throttling buckets, case snapshots, private source/report bytes, object inventories, report manifests, safe audit events, idempotency receipts, and deletion tombstones. The append-only `drizzle-render/` chain is the production PostgreSQL schema history and `npm run db:migrate` applies it before each Render deploy.

Never consolidate, rename, edit, or reuse an already-applied `drizzle-render/` migration number. Retired deployment migrations remain available in source-control history, not in the active release tree.

## Lifecycle

```text
DRAFT -> INTAKE_COMPLETE -> UPLOADING -> FACT_REVIEW_REQUIRED
                                              |
                                              v
READY_FOR_ANALYSIS -> ANALYZING -> RESULTS_READY
                                         |
                                         +-> REPORTING -> RESULTS_READY
                                         |                or REPORT_FAILED
                                         +-> DELETION_PENDING -> DELETED
                                                                  or DELETION_FAILED
```

Corrections invalidate current findings and return the case to `READY_FOR_ANALYSIS`. A failed rule run never publishes a partial result. Expired cases become unreadable immediately even if the next scheduled deletion sweep has not run yet.
