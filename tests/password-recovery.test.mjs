import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";

import { createWorkerHarness } from "./helpers/worker-harness.mjs";

let harness;

before(async () => {
  harness = await createWorkerHarness("password-recovery");
});

after(async () => {
  await harness?.dispose();
});

async function signup(email) {
  const client = harness.client(null, { origin: "http://localhost" });
  const response = await client.request("/api/auth/signup", {
    method: "POST",
    body: new URLSearchParams({
      email,
      full_name: "Recovery Tester",
      password: "old-correct-horse",
      password_confirm: "old-correct-horse",
      terms_accepted: "1",
      return_to: "/cases",
    }),
  });
  assert.equal(response.status, 303);
  return client;
}

async function signin(email, password) {
  const client = harness.client(null, { origin: "http://localhost" });
  const response = await client.request("/api/auth/signin", {
    method: "POST",
    body: new URLSearchParams({ email, password, return_to: "/cases" }),
  });
  return { client, response };
}

test("password reset is single-use, revokes sessions, and rotates the password", async () => {
  const email = "recovery@example.test";
  const signedIn = await signup(email);
  const account = await harness.DB.prepare("SELECT id FROM accounts WHERE email = ?")
    .bind(email)
    .first();
  assert.ok(account?.id);

  const token = "a".repeat(64);
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const now = new Date();
  await harness.DB.prepare(
    `INSERT INTO password_resets
      (id, account_id, token_hash, created_at, expires_at, used_at)
      VALUES (?, ?, ?, ?, ?, NULL)`,
  )
    .bind(
      "reset_test",
      account.id,
      tokenHash,
      now.toISOString(),
      new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
    )
    .run();

  const anonymous = harness.client(null, { origin: "http://localhost" });
  const reset = await anonymous.request("/api/auth/reset-password", {
    method: "POST",
    body: new URLSearchParams({
      token,
      password: "new-correct-horse",
      password_confirm: "new-correct-horse",
      return_to: "/account",
    }),
  });
  assert.equal(reset.status, 303);
  assert.equal(reset.headers.get("location"), "/signin?reset=1&return_to=%2Faccount");
  assert.match(reset.headers.get("set-cookie") ?? "", /Max-Age=0/i);
  assert.equal((await signedIn.request("/api/v1/cases")).status, 401);

  const oldPassword = await signin(email, "old-correct-horse");
  assert.match(oldPassword.response.headers.get("location") ?? "", /error=invalid/);
  const newPassword = await signin(email, "new-correct-horse");
  assert.equal(newPassword.response.headers.get("location"), "/cases");
  assert.equal((await newPassword.client.request("/api/v1/cases")).status, 200);

  const replay = await anonymous.request("/api/auth/reset-password", {
    method: "POST",
    body: new URLSearchParams({
      token,
      password: "another-password",
      password_confirm: "another-password",
      return_to: "/",
    }),
  });
  assert.match(replay.headers.get("location") ?? "", /error=token/);
});

test("production forgot-password responses do not enumerate accounts when email is absent", async () => {
  // The harness runs a production Next server. Even a localhost-shaped request
  // must not activate the development reset-link path or reveal whether the
  // address exists when outbound email is unavailable.
  const localShapedRequest = harness.client(null, { origin: "http://localhost" });
  for (const email of ["recovery@example.test", "missing@example.test"]) {
    const response = await localShapedRequest.request("/api/auth/forgot-password", {
      method: "POST",
      body: new URLSearchParams({ email, return_to: "/account" }),
    });
    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get("location"),
      "/forgot-password?error=unavailable&return_to=%2Faccount",
    );
  }

  const production = harness.client(null, { origin: "https://wageshield.test" });
  const unavailable = await production.request("/api/auth/forgot-password", {
    method: "POST",
    body: new URLSearchParams({
      email: "missing@example.test",
      return_to: "https://attacker.example/steal",
    }),
  });
  assert.equal(unavailable.status, 303);
  assert.equal(
    unavailable.headers.get("location"),
    "/forgot-password?error=unavailable&return_to=%2F",
  );
});

test("reset pages suppress referrers and caching when a token is in the URL", async () => {
  const response = await harness.anonymous.request(`/reset-password?token=${"b".repeat(64)}`, {
    headers: { accept: "text/html" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
});
