# Deployment and launch runbook

This runbook leaves no application model to download and no hidden backend to provision. WageShield is one Cloudflare-compatible Worker with a D1 binding named `DB`, a private R2 binding named `BUCKET`, and a 15-minute scheduled retention handler. Resend is the only external API.

The recommended first release is a **private OpenAI Sites deployment** or an equivalently access-controlled Cloudflare private beta. A broadly available demo must remain synthetic-only until the production gates in [SECURITY.md](SECURITY.md) are complete.

## 1. Requirements

- Node.js 22.13 or newer and npm.
- A clean install from the committed `package-lock.json`.
- One deployment target:
  - OpenAI Sites, which owns the Cloudflare resource wiring; or
  - a Cloudflare account with Workers, D1, R2, and Cron Triggers enabled.
- For a direct private beta, use Workers Paid. The Free plan's 10 ms CPU limit is
  too small to rely on for SSR, password hashing, and PDF parsing; Workers Paid
  starts at $5 per account per month.
- A valid Cloudflare billing profile is required to activate the R2 subscription
  and Zero Trust onboarding, even when usage remains inside their free allowances.
- A domain you control and a verified Resend sending domain for production account recovery.
- A registered operating entity, governing jurisdiction, and monitored support/privacy/security mailboxes.

No OpenAI API key, model weights, vector database, OCR service, GPU, or background queue is required. Do not add one merely to launch this version.

## 2. Configuration contract

### Storage bindings

| Binding | Backing service | Required | Purpose |
| --- | --- | --- | --- |
| `DB` | Cloudflare D1 | Yes | Accounts, sessions, cases, reviewed facts, indexes, manifests, throttles, and deletion records |
| `BUCKET` | Private Cloudflare R2 | Yes | Uploaded source documents and generated report PDFs |

OpenAI Sites reads the logical names from `.openai/hosting.json`. Direct Cloudflare builds read the real names/ID from the `CLOUDFLARE_*` variables below. D1 and R2 bindings are credentials supplied by the platform; the application does not need access-key strings for them.

### Runtime values and secrets

| Name | Production status | Secret? | Notes |
| --- | --- | --- | --- |
| `RESEND_API_KEY` | Required | Yes | Account-recovery email; the only third-party API key |
| `EMAIL_FROM` | Required | Treat as configuration | Verified sender, e.g. `WageShield <no-reply@your-domain>` |
| `EMAIL_REPLY_TO` | Recommended | No | Monitored support address |
| `PUBLIC_APP_URL` | Required | No | Exact canonical HTTPS origin, without a path, query, credentials, or fragment |
| `TRUST_FORWARDED_IDENTITY` | Target-specific | No | `true` for OpenAI Sites; absent/`false` for an ordinary direct Worker |
| `ENABLE_SANDBOX` | Optional | No | Keep absent/`false` for a real-record private beta; `true` exposes fictional fixtures |
| `NEXT_PUBLIC_COMPANY_LEGAL_NAME` | Required | No | Registered operating entity; must not contain “pending” |
| `NEXT_PUBLIC_COMPANY_JURISDICTION` | Required | No | Counsel-approved governing law/venue |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | Required | No | Must not use `.example` |
| `NEXT_PUBLIC_PRIVACY_EMAIL` | Required | No | Must not use `.example` |
| `NEXT_PUBLIC_SECURITY_EMAIL` | Required | No | Must not use `.example` |

`TRUST_FORWARDED_IDENTITY=true` is a security assertion, not a convenience flag. Set it only when the Worker is behind a gateway proven to remove client-supplied `oai-authenticated-user-*` headers and inject authenticated values. OpenAI Sites supplies that boundary. A directly reachable Worker does not; its users should use the built-in account flow.

### Direct-build values

These select the real resources written into `dist/server/wrangler.json`. OpenAI Sites does not need them.

| Name | Required for direct deploy | Example |
| --- | --- | --- |
| `CLOUDFLARE_WORKER_NAME` | Yes | `wageshield-h1b` |
| `CLOUDFLARE_D1_DATABASE_NAME` | Yes | `wageshield-production` |
| `CLOUDFLARE_D1_DATABASE_ID` | Yes | UUID returned by `wrangler d1 create` |
| `CLOUDFLARE_R2_BUCKET_NAME` | Yes | `wageshield-private-documents` |
| `CLOUDFLARE_RETENTION_CRON` | Recommended | `*/15 * * * *` |

Use `.env.example` for sanitized build configuration and `.dev.vars.example` for the local Worker runtime contract. Real `.env*` and `.dev.vars*` files are ignored by Git.

## 3. Validate the exact release

From the repository root:

```bash
npm ci
npm run preflight
```

`preflight` performs lint, TypeScript checks, Drizzle journal validation, an in-memory fresh migration, an upgrade from the shipped `0000`–`0005` chain with data-preservation assertions, unit tests, a deployment build, and every `tests/*.test.mjs` integration suite.

Also run a dependency review before each release:

```bash
npm audit --omit=dev
```

Treat a failing check or unresolved production vulnerability as a release blocker. Do not run `npm audit fix --force` against a release branch without reviewing the resulting dependency and behavior changes.

## 4A. Recommended: OpenAI Sites

1. Keep `.openai/hosting.json` limited to the logical resource declarations:

   ```json
   {
     "d1": "DB",
     "r2": "BUCKET"
   }
   ```

   On first publication, Sites adds its own `project_id`. Do not invent a Cloudflare database ID or bucket name in this file.

2. Use the Sites publish flow in Codex and choose a **private** deployment. Sites creates/wires the real D1 and R2 resources and packages the checked-in `drizzle/` migrations with the validated build.

3. In Sites runtime configuration, set the company/contact values, `RESEND_API_KEY`, `EMAIL_FROM`, optional `EMAIL_REPLY_TO`, and `PUBLIC_APP_URL`. Set `TRUST_FORWARDED_IDENTITY=true` only for this Sites-hosted version.

4. If `PUBLIC_APP_URL` was unknown until the Site was created, set it to the exact assigned HTTPS origin and publish a new version before testing password recovery.

5. Keep access private during verification. Promote access only after every smoke test below passes and the legal/privacy/security launch checklist is signed off.

Sites deployment must contain:

- `dist/server/index.js`;
- emitted static assets;
- `dist/.openai/hosting.json`; and
- `dist/.openai/drizzle/**` with the complete append-only migration chain.

The Sites packaging flow validates these artifacts. A private URL is not evidence by itself that migrations, email, or retention are healthy; verify them below.

## 4B. Direct Cloudflare deployment

### Create resources once

Activate R2 first in **Cloudflare Dashboard → Storage & databases → R2 →
Overview** and complete its subscription checkout. Choose Standard storage so
the monthly R2 free allowance applies. Then authenticate Wrangler, verify the
selected account, and create one production database and one private bucket:

```bash
npx wrangler login
npx wrangler whoami
npx wrangler d1 create wageshield-production
npx wrangler d1 info wageshield-production
npx wrangler r2 bucket create wageshield-private-documents
npx wrangler r2 bucket list
```

Copy the returned D1 UUID and the selected names into an ignored `.env.local` based on `.env.example`. Never commit the UUID together with secrets, and never use the all-zero placeholder for a deployment. The binding values are read from `process.env` while Vite evaluates its configuration, so export the file into the build shell rather than assuming Vite will load it later.

### Build against the real bindings

```bash
set -a
source .env.local
set +a
npm run preflight
npm run build
```

Inspect `dist/server/wrangler.json` before continuing. It must contain:

- the intended Worker name;
- D1 binding `DB`, the real database name, and a non-placeholder UUID;
- R2 binding `BUCKET` and the intended private bucket;
- `migrations_dir` resolving to the repository `drizzle/` directory;
- cron `*/15 * * * *` (or an explicitly reviewed equivalent);
- `keep_vars: true`; and
- the `nodejs_compat` compatibility flag.

If `00000000-0000-4000-8000-000000000000` appears, stop: Vite did not load the intended environment file.

### Apply migrations before application code

Check the append-only chain. D1 Time Travel is automatic; confirm its retention
for the selected plan, then apply the migrations to the remote binding:

```bash
npm run db:check
npm run db:validate
npx wrangler d1 migrations apply DB --remote --config dist/server/wrangler.json
```

Review the migration list Wrangler shows before confirming. Never rename, edit, consolidate, or delete an already-applied migration. New schema work is generated as the next numbered file and must pass both migration paths before deployment.

### Deploy and configure runtime values

```bash
npx wrangler deploy --config dist/server/wrangler.json
```

Use **Workers & Pages → WageShield worker → Settings → Variables and Secrets**
to configure `RESEND_API_KEY` as a Secret. Alternatively, target the generated
configuration explicitly:

```bash
npx wrangler secret put RESEND_API_KEY --config dist/server/wrangler.json
npx wrangler secret list --config dist/server/wrangler.json
```

Put `PUBLIC_APP_URL`, sender settings, and company/contact values in the
Worker's runtime variables. `keep_vars: true` prevents later application
deploys from silently erasing dashboard-managed text variables.

The first deployment may be needed to learn the `workers.dev` origin. Set that exact HTTPS origin—or preferably the final custom-domain origin—as `PUBLIC_APP_URL` before account-recovery testing. Verify the Resend domain and its SPF/DKIM/DMARC configuration.

Keep `TRUST_FORWARDED_IDENTITY` absent or `false`. If a future gateway supplies forwarded identity, first disable/bypass-proof the direct origin, restrict routes to the gateway, prove client headers are stripped, and only then enable the flag. A custom domain alone is not a sanitizing identity gateway.

Confirm the Cron Trigger is visible in the deployed Worker's settings and alert on scheduled-handler exceptions. The handler purges expired sessions and expired cases; if verified object deletion fails, it throws so monitoring can detect the failure.

### Restrict the investor deployment

1. Complete Cloudflare Zero Trust onboarding on its Free plan.
2. In **Zero Trust → Integrations → Identity providers**, enable One-time PIN.
3. Create an Access Allow policy whose Include selector is **Emails**, listing
   each exact founder/investor address. Do not use One-time PIN as the only
   Include rule; that would allow any valid email address.
4. Open **Workers & Pages → WageShield worker → Access**, select **Protect this
   Worker behind Access**, choose **All traffic**, and apply the exact-email
   policy. This protects the `workers.dev` hostname and preview routes together.
5. Keep `TRUST_FORWARDED_IDENTITY=false`. Access is the outer gate; the
   application continues to use its own account authorization inside it.

Cron expressions run in UTC and a trigger update can take up to 15 minutes to
propagate. Verify `*/15 * * * *` under **Settings → Triggers → Cron Triggers**
and inspect Trigger Events after a test execution.

## 5. Deployment smoke test

Use two clean accounts and only generated synthetic files. Record the deployed version and safe request IDs, not private payloads.

1. `GET /api/v1/health` returns `200`, `status: "ok"`, database/object dependencies `true`, and `launch_ready: true`. Any configuration flag `false` blocks launch.
2. Create an account, verify duplicate and malformed sign-up handling, sign out, and sign back in.
3. Request password recovery, receive the Resend message, confirm the link uses exactly `PUBLIC_APP_URL`, reset once, prove the old password and a reused link fail, and prove existing sessions were revoked.
4. Create each synthetic scenario and confirm their expected clear, clean-control, and abstention outcomes.
5. In a blank synthetic case, upload one searchable PDF and one image. Confirm file/type/size rejection paths, parser values remaining review-required, and evidence-linked manual review for the image.
6. Correct a fact, rerun analysis, select only intended findings, apply redactions, generate/download a PDF, fetch its manifest, and verify its SHA-256 hash.
7. From the second account, request the first account's case, document, report, manifest, correction, and deletion routes. Every attempt must be denied with the same missing-resource shape.
8. Export the first account and verify it contains no password hash, token, R2 object key, or foreign case.
9. Delete one case and prove its API, document, report, and idempotent replays cannot recover private content.
10. Set a synthetic case to the shortest retention window (or use a dedicated non-production test database), trigger/await the scheduled handler, and verify D1/R2 removal plus the content-free tombstone.
11. Delete the test account, verify its sessions and cases are gone, and confirm a stale in-flight request cannot recreate a case.
12. Check Worker logs and Resend events for secrets, email-body echoes, names, wages, evidence excerpts, or raw file data. None should appear.

Repeat the critical paths on the final custom domain, mobile viewport, and keyboard-only navigation. Retest after any access-policy, runtime-variable, migration, or domain change.

## 6. Launch checklist

### Required to open the private beta

- [ ] `npm ci`, `npm run preflight`, and `npm audit --omit=dev` pass on the exact release commit.
- [ ] D1/R2 bindings and every append-only migration are present in the deployed version.
- [ ] `RESEND_API_KEY`, verified `EMAIL_FROM`, and canonical `PUBLIC_APP_URL` pass the recovery smoke test.
- [ ] Entity, jurisdiction, policy version/date, and support/privacy/security contacts are real and monitored.
- [ ] Counsel reviewed `/terms`, `/privacy`, disclaimers, consent records, eligibility, governing law, liability language, and private-beta copy.
- [ ] Private access policy and origin-bypass tests pass; forwarded identity is enabled only for a sanitizing gateway.
- [ ] Scheduled retention is visible, manually exercised, monitored, and alerts a human on failure.
- [ ] Immediate case deletion, account export/deletion, and cross-account denial pass in production.
- [ ] Cloudflare, source-control, domain, and Resend operators use least privilege and phishing-resistant MFA.
- [ ] Support, abuse, vulnerability, privacy-request, and incident-response owners/runbooks exist.
- [ ] Testers are told not to upload unnecessary identifiers and not to treat WageShield as legal advice or their only document copy.

### Required before unrestricted real-record use

- [ ] Independent penetration test and privacy/threat-model assessment completed and findings remediated.
- [ ] Appropriate antivirus/content-disarm isolation added for accepted uploads.
- [ ] Jurisdiction-specific legal and regulatory review completed.
- [ ] Production monitoring, PII-safe alerting, recovery objectives, incident exercises, and dependency scanning operate continuously.
- [ ] Capacity/abuse tests cover the documented account, case, upload, parsing, report, event, and correction quotas.

Until the second checklist is complete, market the live service as a private beta and keep the public demo synthetic-only. This is an honest product boundary, not a code defect that an API key can remove.

## 7. Release and rollback discipline

- Tag the exact tested source commit and record the deployment/version, migration list, policy version, rule-set version, and operator.
- Apply forward migrations before code that requires them. Keep the previous application version available for an application rollback; do not “roll back” D1 by deleting migration records.
- Use Cloudflare's D1 recovery/time-travel capability according to the account plan and incident runbook. Remember that restoring private records can conflict with deletion promises; privacy/legal approval is required before any restore involving user data.
- Run the smoke test after rollback as well as deployment. A successful HTTP response alone is not recovery.
