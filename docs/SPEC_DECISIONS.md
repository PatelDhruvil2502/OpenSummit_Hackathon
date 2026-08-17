# Product and specification decisions

These choices are canonical across fixtures, API contracts, UI, tests, and reports.

## Analysis

- Public findings use the neutral five-status vocabulary; user disposition is separate from documentary status.
- The guided case has three `POSSIBLE_DISCREPANCY` findings and one worksite `HUMAN_REVIEW_REQUIRED` finding.
- The guided wage comparison contains six complete biweekly periods plus a separate zero-pay nonproductive interval.
- `$3,769.23 × 26` is `$97,999.98`; a `$120,000` annual benchmark across six periods is rounded once after aggregation, yielding a documented `$5,076.93` difference.
- Only `CONFIRMED` and `USER_CORRECTED` facts can enter a rule. Parser candidates remain `NEEDS_REVIEW`.
- A one-day temporary trip is a clean control. Unknown-duration and remote instructions require review; only supported ongoing changes can become a possible discrepancy.
- A contract clause is not a completed deduction. Observed payroll transactions and direct payment requests remain distinct evidence types.

## Product boundary

- The public evaluation path is synthetic-only.
- The standard path exists for an access-controlled private beta and requires the user to confirm authorization. It must not be advertised as unrestricted production handling until the independent security, privacy, and legal gates in `SECURITY.md` are complete.
- The product has no external OCR/model dependency. Searchable-PDF text is handled locally, while images and uncertain values require evidence-linked manual review.
- Rules, evidence, reports, storage, account recovery, export, and deletion remain operational without an AI vendor.

## Identity and retention

- Case ownership uses a PostgreSQL account ID. Render deployments use the built-in account flow and keep `TRUST_FORWARDED_IDENTITY=false`.
- New cases default to 24-hour retention, selectable from one hour to seven days.
- Expired cases are unreadable immediately. A Render Cron Job runs every 15 minutes to delete their PostgreSQL records and private binary objects and verify removal.
- Immediate case deletion and account deletion use the same inventory-and-verify boundary. Only a content-free one-way case tombstone remains in the active database; Render's processor-level recovery window is disclosed separately.

## Deployment history

- Render PostgreSQL uses the append-only `drizzle-render/` migration chain, applied by the Blueprint pre-deploy command. Retired deployment artifacts remain only in Git history.
- Private PostgreSQL binary storage uses the same authenticated document/report API as the earlier storage adapter.
- A directly addressable Render service keeps forwarded identity disabled unless a separately verified sanitizing gateway protects the origin.
