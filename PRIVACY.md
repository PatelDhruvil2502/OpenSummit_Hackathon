# Privacy notes

The hosted WageShield demo is designed for fictional synthetic records only.

## Data used by the demo

- Account email, display name, and a password hash in D1, used only for sign-in. Case records store the account id, not the password. Hosted ChatGPT identity headers, when present, are display attributes and access control only.
- Case settings, reviewed structured facts, corrections, findings, and report selections.
- Synthetic uploaded documents and reconstructed reports in private object storage.
- Safe audit metadata such as opaque IDs, document size/type, event stage, rule version, and timestamps.

## Data deliberately excluded

- Analytics, advertising trackers, employer or agency notifications, and automatic complaint filing.
- Raw file contents or evidence excerpts in standard application logs.
- Private case material in the separate official-source corpus.
- Structured SSNs, account numbers, government credentials, passport numbers, or banking details.

## Retention and deletion

New demo cases default to 24-hour retention and may be shortened or extended to at most seven days in this build. A user can delete a case immediately. Deletion covers original objects, structured facts, findings, corrections, reports, case audit events, and active database rows. A non-substantive verification tombstone stores only a SHA-256 case-ID hash, timestamps, and the deletion-policy version.

The public build does not yet include a scheduled expiration worker, so time-based expiry is a product policy signal rather than a background-job guarantee. Use the immediate deletion control to remove a case during evaluation. A production deployment must add and monitor an automatic retention sweep.

On localhost only, WageShield can store a fictional development identity in an HTTP-only cookie so the complete account-owned workflow can be tested. Deployed hostnames never accept that cookie as identity.
