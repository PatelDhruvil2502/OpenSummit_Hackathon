/**
 * Server-only deployment flags read from Render's Node environment.
 */
interface RuntimeFlags {
  TRUST_FORWARDED_IDENTITY?: string;
  PUBLIC_APP_URL?: string;
  RENDER_EXTERNAL_URL?: string;
  ENABLE_SANDBOX?: string;
}

function flags(): RuntimeFlags {
  return {
    TRUST_FORWARDED_IDENTITY: process.env.TRUST_FORWARDED_IDENTITY,
    PUBLIC_APP_URL: process.env.PUBLIC_APP_URL,
    RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL,
    ENABLE_SANDBOX: process.env.ENABLE_SANDBOX,
  };
}

/**
 * True only when the deployment declares that a gateway in front of this service
 * strips client-supplied identity headers and injects its own. Default false:
 * on a directly-addressable Render service those headers are attacker-controlled.
 */
export function trustsForwardedIdentity(): boolean {
  const declared = flags().TRUST_FORWARDED_IDENTITY;
  return declared === "1" || declared === "true";
}

/**
 * Fictional fixtures are an explicit development/evaluation capability. They
 * stay unreachable in a real-record private beta unless an operator opts in.
 */
export function sandboxIsEnabled(): boolean {
  const declared = flags().ENABLE_SANDBOX;
  return declared === "1" || declared === "true";
}

/**
 * Canonical public origin used in security-sensitive emails. An explicit value
 * wins for custom domains; otherwise Render's platform-provided external URL is
 * trusted. We never derive a production reset link from the request Host header.
 * Local development may use its request origin.
 */
export function publicAppOrigin(request?: Request): string | null {
  const runtime = flags();
  const declared = runtime.PUBLIC_APP_URL?.trim() || runtime.RENDER_EXTERNAL_URL?.trim();
  if (declared) {
    try {
      const url = new URL(declared);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.pathname !== "/" && url.pathname !== "")
      ) {
        return null;
      }
      return url.origin;
    } catch {
      return null;
    }
  }

  if (!request) return null;
  const requested = new URL(request.url);
  if (
    requested.hostname === "localhost" ||
    requested.hostname === "127.0.0.1" ||
    requested.hostname === "[::1]"
  ) {
    return requested.origin;
  }
  return null;
}
