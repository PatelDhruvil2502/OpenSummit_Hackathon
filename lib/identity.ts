export type IdentitySource = "chatgpt" | "account";

export interface AuthenticatedUser {
  userId: string;
  displayName: string;
  email: string;
  fullName: string | null;
  source: IdentitySource;
}

export interface RequestIdentity {
  user: AuthenticatedUser;
  legacyOwnerSession: string | null;
}

type HeaderReader = Pick<Headers, "get">;

export const USER_ID_HEADER = "oai-authenticated-user-id";
export const USER_EMAIL_HEADER = "oai-authenticated-user-email";
const USER_FULL_NAME_HEADER = "oai-authenticated-user-full-name";
const USER_FULL_NAME_ENCODING_HEADER = "oai-authenticated-user-full-name-encoding";
const PERCENT_ENCODED_UTF8 = "percent-encoded-utf-8";
const LEGACY_SESSION_COOKIE = "wageshield_session";

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function parseCookies(value: string | null): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(
    value
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        const key = index < 0 ? part : part.slice(0, index);
        const encodedValue = index < 0 ? "" : part.slice(index + 1);
        return [key, safeDecodeURIComponent(encodedValue) ?? ""];
      }),
  );
}

function safeFullName(headers: HeaderReader): string | null {
  const encoded = headers.get(USER_FULL_NAME_HEADER);
  if (
    !encoded ||
    headers.get(USER_FULL_NAME_ENCODING_HEADER) !== PERCENT_ENCODED_UTF8
  ) {
    return null;
  }
  return safeDecodeURIComponent(encoded);
}

/**
 * Forwarded identity headers are only meaningful behind a gateway that strips
 * client-supplied copies and injects its own (OpenAI Sites does this). On a
 * directly-addressable Worker they are attacker-controlled, and trusting them
 * would let anyone authenticate as any user by setting a request header.
 *
 * So the path is opt-in: it stays off unless the deployment sets
 * TRUST_FORWARDED_IDENTITY, declaring that such a gateway is in front of it.
 * See DEPLOYMENT.md.
 */
export async function forwardedIdentityIsTrusted(): Promise<boolean> {
  try {
    const { trustsForwardedIdentity } = await import("./runtime-flags");
    return trustsForwardedIdentity();
  } catch {
    return false;
  }
}

function forwardedUser(headers: HeaderReader, trusted: boolean): AuthenticatedUser | null {
  if (!trusted) return null;
  const userId = headers.get(USER_ID_HEADER)?.trim();
  const email = headers.get(USER_EMAIL_HEADER)?.trim();
  if (!userId || !email) return null;

  const fullName = safeFullName(headers);
  return {
    userId,
    displayName: fullName ?? email,
    email,
    fullName,
    source: "chatgpt",
  };
}

function hostnameFromHeaders(headers: HeaderReader): string {
  const rawHost = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "")
    .split(",")[0]
    .trim();
  if (!rawHost) return "";
  try {
    return new URL(`http://${rawHost}`).hostname;
  } catch {
    return "";
  }
}

export function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function isLocalRequest(request: Request): boolean {
  try {
    return isLocalHostname(new URL(request.url).hostname);
  } catch {
    return false;
  }
}

export function isLocalHeaders(headers: HeaderReader): boolean {
  return isLocalHostname(hostnameFromHeaders(headers));
}

export async function getUserFromHeaders(headers: HeaderReader): Promise<AuthenticatedUser | null> {
  return forwardedUser(headers, await forwardedIdentityIsTrusted());
}

export async function getRequestIdentity(request: Request): Promise<RequestIdentity | null> {
  const { getAccountFromCookie } = await import("./accounts");
  const user =
    forwardedUser(request.headers, await forwardedIdentityIsTrusted()) ??
    (await getAccountFromCookie(request.headers.get("cookie")));
  if (!user) return null;
  const legacyOwnerSession = parseCookies(request.headers.get("cookie"))[LEGACY_SESSION_COOKIE];
  return {
    user,
    legacyOwnerSession:
      legacyOwnerSession && /^[a-f0-9-]{36}$/i.test(legacyOwnerSession)
        ? legacyOwnerSession
        : null,
  };
}

export function requestUsesHttps(request: Request): boolean {
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function safeRelativeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  let url: URL;
  try {
    url = new URL(value, "https://app.local");
  } catch {
    return "/";
  }
  if (url.origin !== "https://app.local") return "/";
  if (
    url.pathname === "/signin-with-chatgpt" ||
    url.pathname === "/signout-with-chatgpt" ||
    url.pathname === "/callback" ||
    url.pathname === "/signin" ||
    url.pathname === "/signup" ||
    url.pathname === "/signout" ||
    url.pathname === "/forgot-password" ||
    url.pathname === "/reset-password" ||
    url.pathname === "/dev-login" ||
    url.pathname === "/dev-signout"
  ) {
    return "/";
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function accountSignInPath(returnTo: string): string {
  return `/signin?return_to=${encodeURIComponent(safeRelativeReturnPath(returnTo))}`;
}

export function accountSignUpPath(returnTo: string): string {
  return `/signup?return_to=${encodeURIComponent(safeRelativeReturnPath(returnTo))}`;
}

export function accountSignOutPath(returnTo = "/"): string {
  return `/signout?return_to=${encodeURIComponent(safeRelativeReturnPath(returnTo))}`;
}

export function chatGPTSignInPath(returnTo: string): string {
  return `/signin-with-chatgpt?return_to=${encodeURIComponent(safeRelativeReturnPath(returnTo))}`;
}

export function chatGPTSignOutPath(returnTo = "/"): string {
  return `/signout-with-chatgpt?return_to=${encodeURIComponent(safeRelativeReturnPath(returnTo))}`;
}

export function signInPath(_headers: HeaderReader, returnTo: string): string {
  return accountSignInPath(returnTo);
}

export function signInPathForRequest(_request: Request, returnTo: string): string {
  return accountSignInPath(returnTo);
}

export function signOutPath(user: AuthenticatedUser, returnTo = "/"): string {
  return user.source === "chatgpt" ? chatGPTSignOutPath(returnTo) : accountSignOutPath(returnTo);
}
