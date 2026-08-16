import { env } from "cloudflare:workers";

/**
 * Deployment flags read from the Worker environment.
 *
 * Kept in its own module so `lib/identity.ts` can stay free of a static
 * `cloudflare:workers` import and be loaded from any bundling context.
 */
interface RuntimeFlags {
  TRUST_FORWARDED_IDENTITY?: string;
  PUBLIC_APP_URL?: string;
  ENABLE_SANDBOX?: string;
}

function flags(): RuntimeFlags {
  return env as unknown as RuntimeFlags;
}

/**
 * True only when the deployment declares that a gateway in front of this Worker
 * strips client-supplied identity headers and injects its own. Default false:
 * on a directly-addressable Worker those headers are attacker-controlled.
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
 * Canonical public origin used in security-sensitive emails. Requiring an
 * explicit production value prevents a forged Host header from being turned
 * into an account-recovery link. Local development may use its request origin.
 */
export function publicAppOrigin(request?: Request): string | null {
  const declared = flags().PUBLIC_APP_URL?.trim();
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
