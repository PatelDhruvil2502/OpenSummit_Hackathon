# Terms of service — operator copy

The visitor-facing agreement is served at `/terms`; it is versioned with the policy constants in `lib/company.ts`. This Markdown copy records the intended launch boundary for the operator. It is not legal advice and must be reviewed and adapted by licensed counsel before commercial launch.

## 1. Service

WageShield H-1B is a document-organization tool. A user supplies employment records they are authorized to possess and, separately for each upload, may opt into AI evidence review. The AI may propose source-linked values and a second grounding pass checks each cited page; the user still confirms, corrects, or rejects every proposal before fixed published rules compare the reviewed values. The service can reconstruct selected material into an evidence packet for human review.

It is not a law firm, immigration adviser, payroll adjudicator, government service, or secure archive. It does not create an attorney-client relationship, decide that a law was broken, calculate an amount legally owed, assess immigration eligibility, file a complaint, or contact an employer, agency, or third party.

`POSSIBLE_DISCREPANCY` means supplied documents differ under a published comparison. Missing context may fully explain the difference.

## 2. Launch and eligibility boundary

The broadly shared evaluation is for generated synthetic records only. The operator may invite a limited user to an access-controlled private beta for a record the user is authorized to possess, but must disclose the security limits, short retention, and beta status before upload. Unrestricted public processing of real records is outside the approved release boundary until the production gates in [SECURITY.md](SECURITY.md) are complete.

The operator must define age, residency, geographic, payment, and professional-use eligibility with counsel. Do not silently expand the scope in marketing copy.

## 3. User responsibilities

Users must:

- possess authority to upload every record and avoid violating a law, order, agreement, or another person's rights;
- select AI evidence review only when authorized to transmit bounded page images or text from that upload to the configured inference provider, after reviewing the privacy policy;
- redact unnecessary high-risk identifiers before upload;
- verify every extracted or entered value and source excerpt against the original;
- keep their account secure and avoid sharing credentials or reset links;
- avoid harassment, unauthorized access, reverse engineering intended to defeat safeguards, quota/rate-limit evasion, malware, or unlawful use; and
- obtain qualified professional advice before acting on a finding.

## 4. Retention, deletion, and continuity

Each case has a user-selected retention period of one hour through seven days, defaulting to 24 hours. Expired cases become unreadable immediately and are deleted by a scheduled sweep that runs every 15 minutes. A user can delete a case sooner; removal from the live service is verified before success is reported. A content-free one-way tombstone may remain to prove completion. Render's paid PostgreSQL recovery system can retain a prior database state for its documented recovery window (three days on the Hobby workspace); those copies are not served by WageShield and must not be used to reintroduce deleted records.

The service is provided on an as-available basis. A user must keep their own source copy: automatic expiry is intended behavior, not data loss for which the service acts as a backup.

## 5. Accounts, suspension, and termination

A user may export or delete account data through the product. The operator may suspend abusive, unlawful, or security-threatening use and must define any notice/appeal process with counsel. Account deletion removes owned reviews as described in [PRIVACY.md](PRIVACY.md).

## 6. Disclaimers and liability

The served terms currently use an “as is”/“as available” disclaimer and a proposed liability cap. Warranty exclusions, liability limitations, governing law, venue, payment/refund terms, arbitration/class-action language, and consumer-law disclosures vary by jurisdiction. They must not be launched from placeholders or copied unchanged without counsel.

## 7. Operator checklist

Before asking a user to accept the terms:

- replace the pending entity, jurisdiction, and `.example` addresses;
- have counsel approve the visitor-facing text, policy version, effective date, consent flow, and records of acceptance;
- keep the product page, privacy copy, security limits, and these terms consistent about synthetic public use, private-beta real-record use, and the 15-minute retention sweep; and
- retain the exact accepted policy version/time without fabricating consent for pre-existing accounts.

Questions must go to the configured support address. Support channels must instruct users not to email private records or credentials.
