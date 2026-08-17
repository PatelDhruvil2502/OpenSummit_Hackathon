import assert from "node:assert/strict";
import test from "node:test";

import {
  authCookie,
  clearAuthCookie,
  hashPassword,
  normalizeEmail,
  readAuthToken,
  signupAccessIsConfigured,
  signupEmailIsAllowed,
  validEmail,
  validPassword,
  verifyPassword,
} from "./accounts";

test("account input normalization and validation retain their public behavior", () => {
  assert.equal(normalizeEmail("  Investor@Example.COM "), "investor@example.com");
  assert.equal(validEmail("investor@example.com"), true);
  assert.equal(validEmail("missing-domain@example"), false);
  assert.equal(validPassword("12345678"), true);
  assert.equal(validPassword("1234567"), false);
});

test("investor signup fails closed unless an allowlist or explicit public policy exists", () => {
  const previousAllowlist = process.env.INVESTOR_EMAIL_ALLOWLIST;
  const previousPublic = process.env.ALLOW_PUBLIC_SIGNUP;
  try {
    delete process.env.INVESTOR_EMAIL_ALLOWLIST;
    delete process.env.ALLOW_PUBLIC_SIGNUP;
    assert.equal(signupAccessIsConfigured(), false);
    assert.equal(signupEmailIsAllowed("anyone@example.com"), false);

    process.env.ALLOW_PUBLIC_SIGNUP = "true";
    assert.equal(signupAccessIsConfigured(), true);
    assert.equal(signupEmailIsAllowed("anyone@example.com"), true);
    process.env.ALLOW_PUBLIC_SIGNUP = "false";

    process.env.INVESTOR_EMAIL_ALLOWLIST =
      " Investor@One.Example,second@example.com,not-an-email ";
    assert.equal(signupAccessIsConfigured(), true);
    assert.equal(signupEmailIsAllowed("investor@one.example"), true);
    assert.equal(signupEmailIsAllowed("SECOND@EXAMPLE.COM"), true);
    assert.equal(signupEmailIsAllowed("other@example.com"), false);

    process.env.INVESTOR_EMAIL_ALLOWLIST = "not-an-email";
    assert.equal(signupAccessIsConfigured(), false);
    assert.equal(signupEmailIsAllowed("anyone@example.com"), false);
  } finally {
    if (previousAllowlist === undefined) delete process.env.INVESTOR_EMAIL_ALLOWLIST;
    else process.env.INVESTOR_EMAIL_ALLOWLIST = previousAllowlist;
    if (previousPublic === undefined) delete process.env.ALLOW_PUBLIC_SIGNUP;
    else process.env.ALLOW_PUBLIC_SIGNUP = previousPublic;
  }
});

test("PBKDF2 password records verify without exposing the password", async () => {
  const stored = await hashPassword("correct horse battery staple");
  assert.match(stored, /^pbkdf2\$sha256\$210000\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  assert.equal(await verifyPassword("correct horse battery staple", stored), true);
  assert.equal(await verifyPassword("wrong password", stored), false);
  assert.equal(await verifyPassword("correct horse battery staple", "invalid-record"), false);
});

test("authentication cookies are HTTP-only and reject malformed tokens", () => {
  const token = "a".repeat(64);
  const cookie = authCookie(token, true, 60);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Max-Age=60/);
  assert.equal(readAuthToken(`another=value; ${cookie}`), token);
  assert.equal(readAuthToken("wageshield_auth=not-a-token"), null);
  assert.match(clearAuthCookie(true), /Max-Age=0/);
});
