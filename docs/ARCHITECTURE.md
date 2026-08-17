# Architecture and trust boundaries

## Runtime

WageShield is a modular monolith built with React 19, the Next.js App Router on Node.js, TypeScript, PostgreSQL, Zod, Drizzle, pdf-lib, and a patched PDF.js text-layer parser. One Render Web Service serves the UI, versioned API routes, and authenticated downloads; a separate Render Cron Job invokes the same retention domain functions.

The deployed slice needs no external AI or OCR service:

- Guided cases generate watermarked source PDFs and their already-reviewed structured facts together.
- Searchable PDFs are parsed within the Node service under page, byte, image, and output bounds. Parsed values remain `NEEDS_REVIEW`.
- Images and uncertain documents route to a source-document, page, and verbatim-excerpt manual review flow.
- A future extraction service may emit the same `FactRecord` and `EvidenceRef` contracts, but its output cannot enter a rule until a person confirms it.

## Data path

1. Sign-up stores an account in Render PostgreSQL. Sign-in issues an HttpOnly cookie whose random token is hashed in PostgreSQL. Private-beta registration fails closed unless the normalized email exactly matches the configured investor allowlist; public signup requires a separate explicit opt-in.
2. Case creation freezes consent, retention, official-source-corpus, and rule-set versions.
3. Uploads are streamed under a request cap, signature/structure validated, hashed, and stored as PostgreSQL binary rows under random case-scoped keys.
4. Reviewed facts retain their displayed value, normalized rule input, review status, and exact same-case evidence reference.
5. `runAllRules` executes four pure modules using integer cents, exact rationals, and explicit calendar logic.
6. Findings carry status, calculation rows, same-case evidence, approved official context, assumptions, limitations, and questions.
7. The report service reconstructs only selected fields into a new PDF, hashes it, and stores a matching manifest.
8. Immediate deletion and the 15-minute Render cron sweep inventory case objects, remove private bytes and structured PostgreSQL rows from the live service, verify removal, and retain only a content-free one-way tombstone in the active database. Render's documented PITR window is a separate processor recovery boundary.

## Hard boundaries

- Parsers or models may propose facts; they may not perform final calculations or publish findings.
- Private evidence and official public guidance use separate data types and presentation surfaces.
- A public source supplies context, never proof about a private case.
- Money uses integer cents or rational numerator/denominator arithmetic; aggregate rounding occurs once.
- Ambiguous periods, labels, dates, deductions, and temporary/remote worksites route to abstention or human review.
- Reports never copy original document layers.
- Every object read resolves through an owner-scoped PostgreSQL record before any private bytes are returned.
- `oai-authenticated-user-*` headers are ignored unless the runtime explicitly trusts a gateway that strips client copies and injects authenticated values.

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
