/** Cloudflare Worker entry point for WageShield H-1B. */
import handler from "vinext/server/app-router-entry";
import { purgeExpiredSessions } from "../lib/accounts";
import { purgeExpiredCases, purgeExpiredIdempotencyKeys } from "../lib/storage";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  BUCKET: R2Bucket;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const response = await handler.fetch(request, env, ctx);
    const headers = new Headers(response.headers);
    if (!headers.has("Content-Security-Policy")) {
      headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    }
    const containsResetToken =
      url.pathname === "/reset-password" || url.pathname === "/reset-password/";
    headers.set(
      "Referrer-Policy",
      containsResetToken ? "no-referrer" : "strict-origin-when-cross-origin",
    );
    if (containsResetToken) {
      headers.set("Cache-Control", "private, no-store, max-age=0");
      headers.set("Pragma", "no-cache");
    }
    headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
    if (url.protocol === "https:") {
      headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },

  async scheduled(): Promise<void> {
    await purgeExpiredSessions();
    await purgeExpiredIdempotencyKeys();
    const result = await purgeExpiredCases(100);
    if (result.failed.length) {
      throw new Error(`Retention deletion failed for ${result.failed.length} hashed case identifiers`);
    }
  },
};

export default worker;
