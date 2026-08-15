# Blueprint decisions

The source blueprint contains a few internally inconsistent examples. The implementation resolves them explicitly so code, fixtures, UI, tests, and reports agree.

## Canonical choices

- Later lifecycle/API contracts are canonical: plural `/uploads`, `/analyses`, and `/corrections`, plus an explicit `REPORT_FAILED` state.
- Public finding output uses the neutral five-status vocabulary and keeps user disposition separate from status.
- The hero case returns three `POSSIBLE_DISCREPANCY` results and one worksite `HUMAN_REVIEW_REQUIRED` result.
- The hero fixture contains six complete comparable pay periods plus a separate zero-pay nonproductive interval. This makes the six-period narrative reproducible.
- `$3,769.23 × 26` is represented as `$97,999.98`, not `$98,000.00`.
- A `$120,000` annual benchmark across six biweekly periods is rounded once after aggregation. Compared with six periods of `$3,769.23`, the exact documentary difference is `$5,076.93`, not `$5,076.90`.
- Fact review states accepted by the rule engine are `CONFIRMED` and `USER_CORRECTED`; unreviewed model candidates remain `NEEDS_REVIEW`.
- A temporary one-day trip is a clean control; unknown-duration and remote instructions route to human review; only supported ongoing changes can become a possible difference.
- A contract clause is never represented as a completed deduction. Observed payroll transactions and direct payment requests remain distinct evidence types.

## Intentional demo constraints

- Public use is synthetic-only.
- Case ownership uses a D1 account id after email/password sign-up, or a Site-forwarded ChatGPT user ID when those headers are present.
- External OCR/model extraction is replaced by canonical reviewed fixtures and a manual reviewed-fact fallback. The rules, evidence, report, storage, and deletion vertical slice remains fully operational without network/vendor dependency.
- Immediate deletion is implemented and verified. Automatic expiry requires a scheduled production retention worker and is disclosed in the privacy notes.
