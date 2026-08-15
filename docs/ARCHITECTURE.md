# Architecture and trust boundaries

## Runtime

WageShield is a Cloudflare-compatible modular monolith built with React 19, a Next-compatible App Router through Vinext, TypeScript, D1, R2, Zod, Drizzle, and pdf-lib. One Worker serves the UI and versioned JSON/file routes.

The narrow deployed slice is intentionally complete without external AI or OCR services:

- Guided cases generate watermarked source PDFs and their already-reviewed structured facts together.
- Blank cases validate and privately store fictional files, then require the user to enter only facts they have checked.
- An extraction service can later emit the existing `FactRecord` and `EvidenceRef` contracts, but its output must stay in `NEEDS_REVIEW` until accepted.

## Data path

1. Sign up stores an account in D1. Sign in issues an HttpOnly session cookie (token hashed in D1). Hosted ChatGPT identity headers still work when present.
2. Case creation freezes consent, retention, source-corpus, and rule-set versions.
3. Documents are signature-validated, hashed, and stored under a case-scoped R2 key.
4. Reviewed facts retain the displayed value, normalized rule input, confidence, review status, and exact evidence excerpt.
5. `runAllRules` executes four pure modules using integer-cent and calendar logic only.
6. Each finding carries status, calculation rows, same-case evidence, approved official context, assumptions, limitations, and questions.
7. The report service reconstructs selected fields into a new PDF, hashes it, and publishes the matching manifest.
8. Deletion inventories case object keys, removes objects and rows, and inserts only a verification tombstone.

## Hard boundaries

- Models or parsers may propose facts; they may not perform calculations or publish statuses.
- Private evidence and official public guidance use separate types and presentation surfaces.
- A source citation supplies general context, never case evidence.
- Every money calculation uses integer cents or rational numerator/denominator arithmetic.
- Partial periods, ambiguous labels, uncertain dates, temporary/remote worksites, missing evidence, and unresolved corrections route to abstention or human review.
- Reports never copy original document layers.
- All private object access is resolved through an account-authorized case; the D1 ownership predicate is checked before an R2 object is returned.

## Persistence

D1 stores an authoritative JSON case snapshot plus an indexed stable owner-user column, operational columns, object inventories, report manifests, safe audit events, and deletion tombstones. R2 stores source documents and report bytes. Runtime schema initialization makes local development self-starting; Drizzle migrations provide the deployable schema history.

## State transitions used in this slice

```text
DRAFT -> READY_FOR_ANALYSIS -> ANALYZING -> RESULTS_READY
                                             |
                                             +-> REPORTING -> RESULTS_READY
                                             |                or REPORT_FAILED
                                             +-> DELETION_PENDING -> DELETED
```

Corrections clear current findings and return the case to `READY_FOR_ANALYSIS`. No partial rule result is published.
