import assert from "node:assert/strict";
import test from "node:test";

import { emailIsConfigured, passwordResetMessage, sendEmail } from "./email";

function preserveEnvironment(names: string[]): () => void {
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

test("email configuration ignores blank provider values", () => {
  const restore = preserveEnvironment(["RESEND_API_KEY", "EMAIL_FROM"]);
  try {
    process.env.RESEND_API_KEY = "   ";
    process.env.EMAIL_FROM = "WageShield <account@example.test>";
    assert.equal(emailIsConfigured(), false);
    process.env.RESEND_API_KEY = "re_123456789012";
    assert.equal(emailIsConfigured(), true);
  } finally {
    restore();
  }
});

test("Resend requests use the configured sender and monitored reply address", async () => {
  const restore = preserveEnvironment(["RESEND_API_KEY", "EMAIL_FROM", "EMAIL_REPLY_TO"]);
  const originalFetch = globalThis.fetch;
  try {
    process.env.RESEND_API_KEY = " re_123456789012 ";
    process.env.EMAIL_FROM = " WageShield <account@example.test> ";
    process.env.EMAIL_REPLY_TO = " support@example.test ";
    let request: { input: string; init?: RequestInit } | undefined;
    globalThis.fetch = async (input, init) => {
      request = { input: String(input), init };
      return new Response(null, { status: 202 });
    };

    const result = await sendEmail(
      passwordResetMessage(
        "investor@example.test",
        "https://demo.example.test/reset-password?token=secret",
        30,
      ),
    );
    assert.deepEqual(result, { ok: true, delivered: true });
    assert.equal(request?.input, "https://api.resend.com/emails");
    assert.equal(
      request?.init?.headers &&
        (request.init.headers as Record<string, string>).Authorization,
      "Bearer re_123456789012",
    );
    const payload = JSON.parse(String(request?.init?.body)) as Record<string, unknown>;
    assert.equal(payload.from, "WageShield <account@example.test>");
    assert.equal(payload.reply_to, "support@example.test");
    assert.deepEqual(payload.to, ["investor@example.test"]);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("password reset HTML escapes a supplied URL", () => {
  const message = passwordResetMessage(
    "investor@example.test",
    'https://demo.example.test/reset-password?token=<unsafe>&next="quoted"',
    30,
  );
  assert.equal(message.html.includes("<unsafe>"), false);
  assert.equal(message.html.includes("&lt;unsafe&gt;"), true);
  assert.equal(message.text.includes("token=<unsafe>"), true);
});
