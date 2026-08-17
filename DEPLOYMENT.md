# Render deployment and investor-demo runbook

WageShield deploys as a standard Next.js Node service. The production stack is:

```text
Render Web Service (Next.js UI + API)
├── Render PostgreSQL (structured state + private document/report bytes)
├── OpenRouter (two-pass multimodal evidence extraction + verification)
├── Resend (password-reset email)
└── Render Cron Job (15-minute expiry/deletion sweep)
```

Cloudflare is not part of this deployment. The hackathon AI workflow requires
one server-side inference API key; it does not require downloaded model weights,
a vector database, a GPU, or a background queue.

The checked-in [`render.yaml`](render.yaml) provisions the Render resources and
wires their private connection values. Do not create separate Render services
manually unless the Blueprint cannot be used.

## 1. Before you deploy

You need:

- the repository pushed to a GitHub, GitLab, or Bitbucket branch;
- a Render account with the promotional credit applied;
- an OpenRouter account, API key, and credit balance for the AI Evidence Copilot;
- a Resend API key and verified sender domain for password recovery;
- the exact investor email addresses that may register;
- real company, jurisdiction, support, privacy, and security details for the
  served policy pages; and
- Node.js 22.13 or newer for local verification.

Apply the Render promotion before provisioning anything:

1. Open the [Render Dashboard](https://dashboard.render.com/) and select the
   workspace that will own this deployment.
2. Open **Billing → Credit Balance**.
3. Choose **Enter promo code**, paste the code exactly, and select **Apply**.
4. Confirm the credit **total**, **remaining balance**, and **valid-until** date
   before creating resources.

Promo eligibility and expiry are issuer-specific. Render credit offsets eligible
future invoice usage; it is not cash and cannot be withdrawn. Paid resources can
still require a valid payment method or temporary authorization hold. If the
promo field is absent or the code is rejected, use the issuer's redemption link
or contact Render support before deploying—do not create paid resources first.

The Blueprint intentionally selects an always-on `starter` web service, a
`basic-256mb` PostgreSQL instance with 5 GB of disk, and a `starter` cron job.
Those are paid resources, but a valid $50 credit should cover a low-traffic
one-to-two-week demonstration. Credit coverage is not guaranteed: Render usage
beyond the balance, eligibility, or expiry can be charged. Check **Billing →
Unbilled Usage** and the remaining credit daily, then delete the resources after
the demo.

Official references:

- [Render Blueprints](https://render.com/docs/infrastructure-as-code)
- [Render Blueprint fields](https://render.com/docs/blueprint-spec)
- [Render Next.js deployment](https://render.com/docs/deploy-nextjs-app)
- [Render Cron Jobs](https://render.com/docs/cronjobs)
- [Render Terms of Service](https://render.com/terms)
- [Resend domain verification](https://resend.com/docs/dashboard/domains/introduction)
- [OpenRouter API quickstart](https://openrouter.ai/docs/quickstart)
- [OpenRouter image inputs](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding)
- [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)
- [OpenRouter provider data controls](https://openrouter.ai/docs/guides/privacy/provider-logging/)

## 2. Validate the release locally

From the repository root:

```bash
npm ci
npm run preflight
npm audit --omit=dev
```

Every command must pass on the exact commit you deploy. Do not use
`npm audit fix --force` on the release branch without reviewing and retesting
the dependency changes.

For local application testing, copy `.env.example` to `.env.local`, replace the
placeholders, point `DATABASE_URL` at a PostgreSQL database you control, then:

```bash
npm run db:migrate
npm run dev
```

Open <http://localhost:3000>. PostgreSQL stores both structured state and private
document/report bytes, so no separate object-storage account or key is needed.
The checked-in production settings cap private objects at 3 GiB globally and
1.5 GiB per account, preserving disk headroom for tables and PostgreSQL's
write-ahead log. These are byte-count configuration values, not secrets.
Resend may be left unconfigured only for local development; localhost returns
the reset link through its development flow. Never upload real records to a
developer machine or shared test database. The AI key may also be left blank
for local deterministic/manual work, but the Evidence Copilot will be
unavailable and that is not a complete hackathon demonstration.

## 3. Configure Resend

1. Add a domain or subdomain you control to Resend.
2. Add the DNS records Resend provides and wait until verification succeeds.
3. Create a sending API key dedicated to this investor demo.
4. Save the key as `RESEND_API_KEY` in a password manager.
5. Choose a verified sender value such as:

   ```text
   WageShield <account@updates.yourdomain.com>
   ```
6. Choose a monitored, reply-capable address for `EMAIL_REPLY_TO`. It may be the
   same address used for `NEXT_PUBLIC_SUPPORT_EMAIL`.

Without a verified sender domain, Resend's test sender is not suitable for
password-reset messages to arbitrary investor addresses. If you intentionally
skip Resend, account recovery is not launch-ready.

## 4. Configure the AI Evidence Copilot

The Render Blueprint uses OpenRouter's OpenAI-compatible chat-completions
endpoint, strict JSON Schema responses, and a pinned vision-language model. The
application sends a model request only when the user explicitly consents for
that upload.

1. Sign in to [OpenRouter](https://openrouter.ai/) and open **Keys**.
2. Create a key dedicated to this demo, give it a small spending limit, and
   store it in a password manager.
3. Add enough OpenRouter credits for the paid pinned model, then set
   `OPENROUTER_API_KEY` locally or enter it when Render applies the
   Blueprint. Never expose it through a `NEXT_PUBLIC_*` variable.
4. Keep the checked-in defaults for the first verified run:

   ```dotenv
   AI_EVIDENCE_BASE_URL=https://openrouter.ai/api/v1
   AI_EVIDENCE_MODEL=qwen/qwen3-vl-8b-instruct
   AI_EVIDENCE_VERIFIER_MODEL=qwen/qwen3-vl-8b-instruct
   AI_EVIDENCE_TIMEOUT_MS=45000
   AI_EVIDENCE_ALLOW_PROVIDER_DATA_COLLECTION=false
   ```

   The selected model is listed as vision-capable in the
   [OpenRouter model catalog](https://openrouter.ai/qwen/qwen3-vl-8b-instruct),
   and OpenRouter currently reports support for both image inputs and
   structured outputs. The application requires providers that support every
   requested parameter and denies data-collecting provider endpoints.
   A different verifier may be configured only after running the complete
   synthetic evaluation against that exact model pair. The timeout is clamped
   by the application to 5-60 seconds.
5. Run one generated synthetic upload locally. Consent to AI processing and
   verify that the UI shows model provenance plus supported, rejected, or
   abstained evidence—not a hardcoded response.
6. Rotate the key immediately if it appears in a terminal recording,
   screenshot, client bundle, log, repository, or support message.

The provider receives at most six bounded JPEG page images plus bounded text
for two separate calls; it does not receive the complete raw PDF. OpenRouter
states that it does not retain prompts unless prompt logging is explicitly
enabled, but the downstream model host has its own policy. WageShield sends
`data_collection: "deny"` by default so OpenRouter only selects endpoints that
do not collect the submitted content. Recheck the current endpoint policy and
keep the hackathon demo synthetic-only.

For a synthetic-only demo with no paid credits, an operator may deliberately
set a currently available free vision model that supports structured outputs,
for example `dots-studio/dots-3-note-preview:free`, and set
`AI_EVIDENCE_ALLOW_PROVIDER_DATA_COLLECTION=true`. Free model availability and
policies change. Never use that mode with a real employment record, and switch
back to the pinned Qwen model plus `false` before any private beta.

## 5. Create the Render Blueprint

1. Sign in to [Render](https://dashboard.render.com).
2. Choose the workspace that contains the promotional credit.
3. Select **New → Blueprint**.
4. Connect the Git provider and choose this repository.
5. Choose the release branch (normally `main`).
6. Confirm the Blueprint path is `render.yaml`.
7. Review the proposed resources before applying:

   | Resource | Expected configuration |
   | --- | --- |
   | `wageshield-demo` | Node web service, Ohio, Starter |
   | `wageshield-db` | PostgreSQL 18, Ohio, Basic 256 MB, 5 GB disk |
   | `wageshield-retention` | Node cron, Ohio, every 15 minutes |

8. Enter every value Render prompts for. These correspond to `sync: false` in
   the Blueprint:

   | Variable | Value |
   | --- | --- |
   | `OPENROUTER_API_KEY` | Dedicated OpenRouter key; server-side secret |
   | `RESEND_API_KEY` | Dedicated Resend key |
   | `EMAIL_FROM` | Verified sender string |
   | `EMAIL_REPLY_TO` | Monitored reply-capable address |
   | `INVESTOR_EMAIL_ALLOWLIST` | Comma-separated exact approved emails |
   | `NEXT_PUBLIC_COMPANY_LEGAL_NAME` | Real operating entity |
   | `NEXT_PUBLIC_COMPANY_JURISDICTION` | Counsel-approved jurisdiction/venue |
   | `NEXT_PUBLIC_SUPPORT_EMAIL` | Monitored support address |
   | `NEXT_PUBLIC_PRIVACY_EMAIL` | Monitored privacy address |
   | `NEXT_PUBLIC_SECURITY_EMAIL` | Monitored security address |

9. Apply the Blueprint and watch all three resource logs.

The Blueprint automatically supplies `DATABASE_URL` from the private Render
PostgreSQL connection to both services. It keeps `ENABLE_SANDBOX=false` and
`TRUST_FORWARDED_IDENTITY=false` for the real-record investor deployment. It
also keeps `ALLOW_PUBLIC_SIGNUP=false`, so registration fails closed unless the
normalized email exactly matches `INVESTOR_EMAIL_ALLOWLIST`. Never leave the
allowlist blank for the demo.

Render automatically supplies `RENDER_EXTERNAL_URL`, so the first deployment
can create safe password-reset links without knowing the `onrender.com` hostname
in advance. If you later attach a custom domain, set `PUBLIC_APP_URL` on the web
service to that exact HTTPS origin and redeploy.

The Blueprint pins the non-secret AI base URL, extraction model, verifier model,
and timeout shown above. If you change one in the Render dashboard, update the
repository configuration and evaluation record so the deployed behavior stays
auditable.

## 6. What Render runs

The Web Service uses:

```text
Build:      npm ci --include=dev && npm run build
Pre-deploy: npm run db:migrate
Start:      npm start
Health:     /api/v1/live
```

`npm start` binds Next.js to `0.0.0.0` and Render's `$PORT`. The pre-deploy
command applies the append-only PostgreSQL migrations before the new application
version receives traffic.

The Cron Job uses:

```text
Schedule: */15 * * * *
Command:  npm run retention:sweep
```

Render cron schedules use UTC. The command deletes expired sessions,
password-reset state, idempotency records, cases, source files, and reports. It
exits nonzero when verified case deletion fails so the failed run is visible.

## 7. First-deployment checks

Wait for the database migration, web deploy, and first liveness check to finish.
Render's `/api/v1/live` probe performs only a process-liveness response. Then perform
the operator-facing deep readiness check by opening:

```text
https://<service>.onrender.com/api/v1/health
```

The deep endpoint checks PostgreSQL schema, queries, and private-byte storage. It
must return HTTP 200 with:

- `status: "ok"`;
- database and object dependencies healthy;
- `password_email_configured: true`;
- `public_app_url_configured: true`;
- `company_details_configured: true`;
- `signup_access_configured: true`; and
- `launch_ready: true`.

If it does not, inspect the web-service log and correct the configuration before
sharing the URL. Never print or paste secret values into logs or support chats.

The deep health endpoint is not an inference call and must never expose or spend
the provider key. Independently perform a synthetic consented upload and check
that it records the expected provider/model provenance. A green database health
response alone does not prove that AI inference works.

## 8. Production smoke test

Use two allowlisted accounts and generated synthetic documents for the public
hackathon demo. Do not demonstrate with real sensitive payroll or immigration
records.

1. Load the homepage, methodology, privacy, terms, and security pages.
2. Verify an allowlisted address can register and a non-allowlisted address
   cannot.
3. Sign out, sign in, request password recovery, and complete one reset. Confirm
   the old password and reused reset link fail and existing sessions are revoked.
4. Create a blank case and upload a previously unseen synthetic searchable PDF.
   Verify invalid type, size, and structure paths are rejected safely.
5. First decline AI consent and verify local/manual review remains available.
   Upload a second synthetic PDF with consent and show the extraction pass,
   grounding verifier, exact page citations, provenance, and at least one
   deliberate abstention or rejected unsupported candidate.
6. Confirm every local and AI candidate remains `NEEDS_REVIEW`; then review its
   exact evidence and run the deterministic analysis.
7. Correct a fact, rerun analysis, select findings, apply redactions, generate a
   report, download it, fetch its manifest, and verify the SHA-256 value.
8. From the second account, request the first account's case, document, report,
   manifest, corrections, and deletion routes. Every request must receive the
   same missing-resource response used for a nonexistent case.
9. Export the account and verify it contains no password hash, token, private
   object URL/key, or another account's content.
10. Delete a document and a case; prove their original and generated files are no
   longer downloadable.
11. In Render, open `wageshield-retention`, select **Trigger Run**, and confirm a
    successful `retention_sweep_complete` event without private identifiers.
12. Restart/redeploy the Web Service and confirm the account, remaining case,
    documents, and reports persist.
13. Inspect Render, OpenRouter usage metadata, and Resend logs/events. Render
    and application logs must not contain raw
    documents, evidence excerpts, passwords, reset tokens, session cookies, or
    API tokens.

Do not present the deployment to investors until this entire test passes on the
exact public URL.

## 9. During and after the demo

Before each meeting, check:

- the Render Web Service and database are healthy;
- the latest retention run succeeded;
- Render credit and unbilled usage remain within the promotion;
- PostgreSQL disk usage is below its limit;
- the AI provider key/model remains configured and synthetic test inference
  succeeds without exposing source content in application logs; and
- Resend shows no delivery failure for the invited addresses.

Keep preview environments disabled, run one web instance, and do not add paid
services without reviewing the cost. The Blueprint already disables previews.
Because uploaded documents and reports share the 5 GB PostgreSQL disk with
application data and write-ahead logs, investigate growth early rather than
waiting for the disk to fill.

After the one-to-two-week demonstration:

1. Delete all cases and accounts through the application.
2. Manually run the retention job and verify private document/report rows are gone.
3. Delete the Render cron and web service.
4. Delete the Render database only after completing any legally required export
   and confirming deletion.
5. Revoke the OpenRouter and Resend API keys.
6. Confirm no active Render resource, provider key, or unbilled usage remains.

## 10. Launch boundary

The code is designed for a short, access-controlled investor beta, not an
unrestricted public repository for immigration and payroll records. Before a
general release, complete the independent penetration test, privacy/legal
review, malware-scanning boundary, incident response, monitoring, recovery, and
operator-account hardening listed in [`SECURITY.md`](SECURITY.md).
