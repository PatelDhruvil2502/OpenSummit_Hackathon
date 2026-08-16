# Architecture and trust boundaries

## Runtime

WageShield is a Cloudflare-compatible modular monolith built with React 19, a Next-compatible App Router through Vinext, TypeScript, D1, R2, Zod, Drizzle, pdf-lib, and a patched PDF.js text-layer parser. One Worker serves the UI, versioned API routes, authenticated downloads, and the scheduled retention handler.

The deployed slice needs no external AI or OCR service:

- Guided cases generate watermarked source PDFs and their already-reviewed structured facts together.
- Searchable PDFs are parsed within the Worker under page, byte, image, and output bounds. Parsed values remain `NEEDS_REVIEW`.
- Images and uncertain documents route to a source-document, page, and verbatim-excerpt manual review flow.
- A future extraction service may emit the same `FactRecord` and `EvidenceRef` contracts, but its output cannot enter a rule until a person confirms it.

## Data path

1. Sign-up stores an account in D1. Sign-in issues an HttpOnly cookie whose random token is hashed in D1. A trusted OpenAI Sites gateway may instead supply a Site-scoped user ID.
2. Case creation freezes consent, retention, official-source-corpus, and rule-set versions.
3. Uploads are streamed under a request cap, signature/structure validated, hashed, and stored under random case-scoped R2 keys.
4. Reviewed facts retain their displayed value, normalized rule input, review status, and exact same-case evidence reference.
5. `runAllRules` executes four pure modules using integer cents, exact rationals, and explicit calendar logic.
6. Findings carry status, calculation rows, same-case evidence, approved official context, assumptions, limitations, and questions.
7. The report service reconstructs only selected fields into a new PDF, hashes it, and stores a matching manifest.
8. Immediate deletion and the 15-minute scheduled sweep inventory case objects, remove R2 bytes and D1 rows, verify removal, and retain only a content-free one-way tombstone.

## Hard boundaries

- Parsers or models may propose facts; they may not perform final calculations or publish findings.
- Private evidence and official public guidance use separate data types and presentation surfaces.
- A public source supplies context, never proof about a private case.
- Money uses integer cents or rational numerator/denominator arithmetic; aggregate rounding occurs once.
- Ambiguous periods, labels, dates, deductions, and temporary/remote worksites route to abstention or human review.
- Reports never copy original document layers.
- Every object read resolves through an owner-scoped D1 record before any R2 bytes are returned.
- `oai-authenticated-user-*` headers are ignored unless the runtime explicitly trusts a gateway that strips client copies and injects authenticated values.

## Persistence

D1 is the source of truth for accounts, hashed sessions and password resets, throttling buckets, case snapshots, object inventories, report manifests, safe audit events, idempotency receipts, and deletion tombstones. R2 holds source documents and generated report bytes. Runtime initialization keeps a local database self-starting, while the append-only Drizzle chain is the production schema history.

`scripts/validate-migrations.mjs` proves both a fresh install and an upgrade from the shipped `0000`–`0005` production chain. Never consolidate, rename, or reuse an applied migration number.

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
