# Security model

WageShield's public build is a synthetic-only demonstration. It implements meaningful trust boundaries, but it is not a production authorization or compliance certification.

## Implemented controls

- Every case belongs to a stable user ID from a D1 account (email + PBKDF2 password hash + hashed session cookie) or, when present, a Site-forwarded ChatGPT user ID. The browser never submits the owner ID as a request field.
- Case pages, reads, updates, document downloads, reports, and deletion require the matching authenticated user. A missing or foreign case returns the same 404 response.
- Forwarded email and optional full name are display attributes only. Authorization uses the stable user ID, and owner IDs are removed from JSON responses.
- A session cookie stores a random token; only the SHA-256 hash is kept in D1. Passwords are stored as PBKDF2-SHA256 hashes, never plaintext.
- Original files and reports use random case-scoped R2 keys and are never exposed as public bucket URLs.
- Uploads are limited to 12 MB and validated by file signature. The API rejects unrecognized types, declared-type mismatches, encrypted PDFs, and PDFs containing JavaScript or embedded-file markers.
- The hosted workflow accepts only explicitly marked synthetic records.
- Standard audit events contain opaque IDs, stage names, counts, sizes, MIME types, and versions—not names, wages, excerpts, signed URLs, or raw files.
- Findings can only come from reviewed structured facts and pure deterministic rules. Document text cannot invoke tools, change policy, or directly publish a finding.
- Reports are rebuilt from allowlisted structured fields. Redaction removes matching identifiers from every included field and excerpt rather than painting over an original PDF layer.
- Deletion removes all case-owned D1 rows and R2 objects, verifies the case is no longer accessible, and retains only a one-way case hash with timestamps and policy version.

## Before real-world use

Before processing real records, add any required workspace-membership or role policy, CSRF defense in depth for mutations, rate limits, malware scanning, content-disarm/normalization, OCR sandboxing, managed secrets and encryption keys, automated retention/deletion jobs, signed one-operation downloads, observability with PII scrubbing, dependency scanning, backups, incident runbooks, and independent penetration/privacy/legal review.

Do not upload real immigration, payroll, identity, medical, banking, or family records to the public demo.

## Reporting a vulnerability

Do not include private records or credentials in a report. Share a minimal reproduction using generated synthetic data and identify the affected route, build version, and safe request ID.
