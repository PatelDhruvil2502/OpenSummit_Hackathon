/**
 * Transactional email.
 *
 * WageShield needs outbound email for exactly one thing: account recovery.
 * The provider is behind this module so the rest of the app never learns an API
 * shape, and so a deployment that has not configured a provider fails loudly and
 * safely instead of silently dropping reset links.
 *
 * Configure with these server-only Render environment variables:
 *   RESEND_API_KEY   a Resend API key (https://resend.com)
 *   EMAIL_FROM       a verified sender, e.g. "WageShield <no-reply@yourdomain>"
 *   EMAIL_REPLY_TO   an optional monitored address for replies
 */

interface EmailEnv {
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type EmailResult =
  | { ok: true; delivered: true }
  | { ok: true; delivered: false; reason: "NOT_CONFIGURED" }
  | { ok: false; reason: "PROVIDER_ERROR" };

function emailEnv(): EmailEnv {
  return {
    RESEND_API_KEY: process.env.RESEND_API_KEY?.trim() || undefined,
    EMAIL_FROM: process.env.EMAIL_FROM?.trim() || undefined,
    EMAIL_REPLY_TO: process.env.EMAIL_REPLY_TO?.trim() || undefined,
  };
}

export function emailIsConfigured(): boolean {
  const { RESEND_API_KEY, EMAIL_FROM } = emailEnv();
  if (!RESEND_API_KEY || !/^re_[^\s]{12,}$/.test(RESEND_API_KEY) || !EMAIL_FROM) return false;

  const bracketed = EMAIL_FROM.match(/^[^<>\r\n]+<([^<>\s]+)>$/);
  const address = (bracketed?.[1] ?? EMAIL_FROM).trim().toLowerCase();
  return (
    address.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) &&
    !address.endsWith(".example")
  );
}

export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  const { RESEND_API_KEY, EMAIL_FROM, EMAIL_REPLY_TO } = emailEnv();
  if (!RESEND_API_KEY || !EMAIL_FROM) {
    return { ok: true, delivered: false, reason: "NOT_CONFIGURED" };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
        ...(EMAIL_REPLY_TO ? { reply_to: EMAIL_REPLY_TO } : {}),
      }),
    });
    if (!response.ok) {
      // The body can echo the recipient address, so only the status is logged.
      console.error(
        JSON.stringify({ event: "email_provider_error", status: response.status }),
      );
      return { ok: false, reason: "PROVIDER_ERROR" };
    }
    return { ok: true, delivered: true };
  } catch {
    console.error(JSON.stringify({ event: "email_transport_error" }));
    return { ok: false, reason: "PROVIDER_ERROR" };
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function passwordResetMessage(to: string, resetUrl: string, minutes: number): EmailMessage {
  const safeUrl = escapeHtml(resetUrl);
  return {
    to,
    subject: "Reset your WageShield password",
    text: [
      "Someone asked to reset the password for this WageShield account.",
      "",
      `Open this link within ${minutes} minutes to choose a new password:`,
      resetUrl,
      "",
      "If you did not request this, you can ignore this email. Your password stays the same and no one can access your reviews without it.",
      "",
      "WageShield organizes employment evidence for human review. It is not legal advice.",
    ].join("\n"),
    html: `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f4ee;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#0d2933">
<div style="max-width:520px;margin:0 auto;padding:32px;background:#fffefb;border:1px solid #dbe3df;border-radius:16px">
<p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#137a70">WageShield H-1B</p>
<h1 style="margin:0 0 14px;font-size:22px;line-height:1.25">Reset your password</h1>
<p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#586c72">Someone asked to reset the password for this WageShield account. Choose a new password within ${minutes} minutes.</p>
<p style="margin:0 0 22px"><a href="${safeUrl}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#137a70;color:#fffefb;font-size:14px;font-weight:600;text-decoration:none">Choose a new password</a></p>
<p style="margin:0 0 18px;font-size:12px;line-height:1.6;color:#7d8e91;word-break:break-all">Or paste this link into your browser:<br>${safeUrl}</p>
<p style="margin:0;padding-top:18px;border-top:1px solid #dbe3df;font-size:12px;line-height:1.6;color:#7d8e91">If you did not request this, ignore this email. Your password stays the same and no one can open your reviews without it.<br><br>WageShield organizes employment evidence for human review. It is not legal advice.</p>
</div></body></html>`,
  };
}
