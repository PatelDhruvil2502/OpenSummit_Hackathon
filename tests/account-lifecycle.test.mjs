import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  createWorkerHarness,
  expectJsonError,
  minimalPdf,
} from "./helpers/worker-harness.mjs";

let harness;

before(async () => {
  harness = await createWorkerHarness("account-lifecycle");
});

after(async () => {
  await harness?.dispose();
});

async function createLocalAccount(email = "export-owner@example.test") {
  const client = harness.client(null, { origin: "http://localhost" });
  const response = await client.request("/api/auth/signup", {
    method: "POST",
    body: new URLSearchParams({
      email,
      full_name: "Export Owner",
      password: "correct-horse-battery",
      password_confirm: "correct-horse-battery",
      terms_accepted: "1",
      return_to: "/account",
    }),
  });
  assert.equal(response.status, 303);
  return client;
}

async function createReview(client) {
  const result = await client.json("/api/v1/cases", {
    method: "POST",
    headers: { "idempotency-key": `account-export:${crypto.randomUUID()}` },
    json: {
      mode: "standard",
      title: "Account export review",
      worker_name: "Synthetic Worker",
      employer_name: "Synthetic Employer LLC",
      position: "Engineer",
      review_start: "2026-01-01",
      review_end: "2026-12-31",
      retention_hours: 24,
      authorized_use_confirmed: true,
    },
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.payload));
  return result.payload.case;
}

async function authBucket(material) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `rl_${hex}`;
}

test("data export is authenticated, portable, and omits storage-only fields", async () => {
  const anonymous = await harness.anonymous.request("/api/auth/export");
  await expectJsonError(anonymous, 401, "AUTHENTICATION_REQUIRED");

  const client = await createLocalAccount();
  const review = await createReview(client);
  const form = new FormData();
  form.set("file", new File([minimalPdf()], "synthetic.pdf", { type: "application/pdf" }));
  form.set("document_type", "PAYSTUB");
  form.set("is_synthetic", "true");
  const upload = await client.request(`/api/v1/cases/${review.id}/uploads`, {
    method: "POST",
    body: form,
  });
  assert.equal(upload.status, 201, await upload.text());

  const response = await client.request("/api/auth/export");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition") ?? "", /wageshield-export-.*\.json/i);
  assert.match(response.headers.get("cache-control") ?? "", /private.*no-store/i);
  const text = await response.text();
  const payload = JSON.parse(text);
  assert.equal(payload.exportVersion, "1.0");
  assert.equal(payload.account.email, "export-owner@example.test");
  assert.equal(payload.account.policyAcceptance.version, "1.1");
  assert.match(payload.account.policyAcceptance.acceptedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(payload.cases.some((item) => item.id === review.id));
  assert.doesNotMatch(text, /ownerUserId|objectKey|passwordHash|tokenHash/);
});

test("successful signin clears the email limiter without clearing the shared network limiter", async () => {
  const email = "rate-limit-owner@example.test";
  const client = await createLocalAccount(email);
  const before = await harness.DB.prepare("SELECT bucket FROM auth_rate_limits").all();
  const beforeBuckets = new Set(before.results.map((row) => row.bucket));

  const failed = await client.request("/api/auth/signin", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.44, 198.51.100.7" },
    body: new URLSearchParams({
      email,
      password: "incorrect-password",
      return_to: "/account",
    }),
  });
  assert.equal(failed.status, 303);
  assert.match(failed.headers.get("location") ?? "", /error=invalid/);

  const afterFailure = await harness.DB.prepare(
    "SELECT bucket, attempt_count FROM auth_rate_limits",
  ).all();
  const newBuckets = afterFailure.results.filter((row) => !beforeBuckets.has(row.bucket));
  const emailBucket = await authBucket(`signin:email:${email}`);
  assert.ok(newBuckets.some((row) => row.bucket === emailBucket));
  const networkBuckets = newBuckets.filter((row) => row.bucket !== emailBucket);
  assert.equal(networkBuckets.length, 1);
  assert.equal(networkBuckets[0].bucket, await authBucket("signin:ip:203.0.113.44"));

  const signedIn = await client.request("/api/auth/signin", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.44, 198.51.100.7" },
    body: new URLSearchParams({
      email,
      password: "correct-horse-battery",
      return_to: "/account",
    }),
  });
  assert.equal(signedIn.status, 303);
  assert.equal(signedIn.headers.get("location"), "/account");

  const clearedEmail = await harness.DB.prepare(
    "SELECT bucket FROM auth_rate_limits WHERE bucket = ?",
  )
    .bind(emailBucket)
    .first();
  const retainedNetwork = await harness.DB.prepare(
    "SELECT attempt_count FROM auth_rate_limits WHERE bucket = ?",
  )
    .bind(networkBuckets[0].bucket)
    .first();
  assert.equal(clearedEmail, null);
  assert.equal(Number(retainedNetwork.attempt_count), 1);
});

test("password reset pages never cache or send reset-token referrers", async () => {
  const reset = await harness.anonymous.request(`/reset-password?token=${"a".repeat(64)}`);
  assert.equal(reset.status, 200);
  assert.equal(reset.headers.get("referrer-policy"), "no-referrer");
  assert.match(reset.headers.get("cache-control") ?? "", /no-store/i);
  assert.equal(reset.headers.get("pragma"), "no-cache");

  const ordinary = await harness.anonymous.request("/signin");
  assert.equal(ordinary.status, 200);
  assert.equal(ordinary.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
});

test("local account deletion requires reauthentication and removes cases and objects", async () => {
  const objectCountBefore = (await harness.BUCKET.list()).objects.length;
  const client = await createLocalAccount("delete-owner@example.test");
  const review = await createReview(client);
  const form = new FormData();
  form.set("file", new File([minimalPdf()], "delete-me.pdf", { type: "application/pdf" }));
  form.set("document_type", "PAYSTUB");
  form.set("is_synthetic", "true");
  assert.equal(
    (await client.request(`/api/v1/cases/${review.id}/uploads`, { method: "POST", body: form }))
      .status,
    201,
  );
  assert.equal((await harness.BUCKET.list()).objects.length, objectCountBefore + 1);

  const badConfirmation = await client.request("/api/auth/account", {
    method: "POST",
    body: new URLSearchParams({
      current_password: "correct-horse-battery",
      confirmation: "delete",
    }),
  });
  await expectJsonError(badConfirmation, 400, "INVALID_REQUEST");

  const badPassword = await client.request("/api/auth/account", {
    method: "POST",
    body: new URLSearchParams({ current_password: "wrong-password", confirmation: "DELETE" }),
  });
  await expectJsonError(badPassword, 403, "INVALID_REQUEST");
  assert.equal((await client.request(`/api/v1/cases/${review.id}`)).status, 200);

  const deleted = await client.request("/api/auth/account", {
    method: "POST",
    body: new URLSearchParams({
      current_password: "correct-horse-battery",
      confirmation: "DELETE",
    }),
  });
  assert.equal(deleted.status, 200, await deleted.text());
  assert.match(deleted.headers.get("set-cookie") ?? "", /wageshield_auth=.*Max-Age=0/i);
  assert.equal((await harness.BUCKET.list()).objects.length, objectCountBefore);
  const account = await harness.DB.prepare("SELECT id FROM accounts WHERE email = ?")
    .bind("delete-owner@example.test")
    .first();
  const deletedCase = await harness.DB.prepare("SELECT id FROM cases WHERE id = ?")
    .bind(review.id)
    .first();
  assert.equal(account, null);
  assert.equal(deletedCase, null);
  await assert.rejects(
    harness.DB.prepare(
      "INSERT INTO audit_events (id, case_id, event_type, safe_metadata_json, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(crypto.randomUUID(), review.id, "LATE_EVENT", "{}", new Date().toISOString())
      .run(),
    (error) => error?.code === "23503",
  );
  assert.equal((await client.request("/api/v1/cases")).status, 401);
});

test("trusted-gateway identities receive a clear provider-managed response", async () => {
  const gateway = harness.client({
    id: "gateway-user",
    email: "gateway@example.test",
    name: "Gateway User",
  });
  const response = await gateway.request("/api/auth/account", {
    method: "POST",
    body: new URLSearchParams({ current_password: "irrelevant", confirmation: "DELETE" }),
  });
  const error = await expectJsonError(response, 409, "INVALID_REQUEST");
  assert.match(error.message, /managed by the trusted sign-in provider|re-authenticate/i);
});

test("private-beta accounts cannot change to an uninvited email address", async () => {
  const privateHarness = await createWorkerHarness("account-allowlist", {
    investorEmailAllowlist: "invited@example.test",
    allowPublicSignup: false,
  });
  try {
    const client = privateHarness.client(null, { origin: "http://localhost" });
    const deniedSignup = await client.request("/api/auth/signup", {
      method: "POST",
      body: new URLSearchParams({
        email: "outsider@example.test",
        full_name: "Uninvited Reviewer",
        password: "correct-horse-battery",
        password_confirm: "correct-horse-battery",
        terms_accepted: "1",
      }),
    });
    assert.equal(deniedSignup.status, 303);
    assert.match(deniedSignup.headers.get("location") ?? "", /error=not_invited/);

    const signup = await client.request("/api/auth/signup", {
      method: "POST",
      body: new URLSearchParams({
        email: "invited@example.test",
        full_name: "Invited Investor",
        password: "correct-horse-battery",
        password_confirm: "correct-horse-battery",
        terms_accepted: "1",
        return_to: "/account",
      }),
    });
    assert.equal(signup.status, 303);

    const update = await client.request("/api/auth/profile", {
      method: "POST",
      body: new URLSearchParams({
        email: "outsider@example.test",
        full_name: "Invited Investor",
        current_password: "correct-horse-battery",
        new_password: "",
        new_password_confirm: "",
      }),
    });
    assert.equal(update.status, 303);
    assert.equal(update.headers.get("location"), "/account?error=invalid");

    const row = await privateHarness.DB.prepare("SELECT email FROM accounts LIMIT 1").first();
    assert.equal(row.email, "invited@example.test");
  } finally {
    await privateHarness.dispose();
  }
});
