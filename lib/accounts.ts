import { execute, queryOne, transaction } from "@/db";
import { isIP } from "node:net";
import type { AuthenticatedUser } from "./identity";

const AUTH_COOKIE = "wageshield_auth";
const SESSION_DAYS = 30;
const SESSION_MAX_AGE_SECONDS = SESSION_DAYS * 24 * 60 * 60;
const PBKDF2_ITERATIONS = 210_000;
const encoder = new TextEncoder();

export const AUTH_COOKIE_NAME = AUTH_COOKIE;

function hex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let index = 0; index < left.byteLength; index += 1) diff |= left[index] ^ right[index];
  return diff === 0;
}

async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${hex(salt)}$${hex(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return false;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 1_000_000) return false;
  if (!/^[a-f0-9]{32}$/i.test(parts[3]) || !/^[a-f0-9]{64}$/i.test(parts[4])) return false;
  const salt = fromHex(parts[3]);
  const expected = fromHex(parts[4]);
  if (salt.byteLength !== 16 || expected.byteLength !== 32) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return timingSafeEqual(new Uint8Array(bits), expected);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

export function validPassword(password: string): boolean {
  return password.length >= 8 && password.length <= 128;
}

function investorEmailAllowlist(): Set<string> {
  const configured = process.env.INVESTOR_EMAIL_ALLOWLIST?.trim();
  if (!configured) return new Set();
  return new Set(configured.split(",").map(normalizeEmail).filter(validEmail));
}

function publicSignupIsExplicitlyEnabled(): boolean {
  const declared = process.env.ALLOW_PUBLIC_SIGNUP;
  return declared === "1" || declared === "true";
}

/**
 * Registration fails closed unless an address is explicitly invited or the
 * operator deliberately enables public signup. This prevents an omitted
 * private-beta environment value from silently becoming an open registration
 * and storage-abuse path.
 */
export function signupEmailIsAllowed(email: string): boolean {
  const allowed = investorEmailAllowlist();
  if (allowed.size > 0) return allowed.has(normalizeEmail(email));
  return publicSignupIsExplicitlyEnabled();
}

export function signupAccessIsConfigured(): boolean {
  return investorEmailAllowlist().size > 0 || publicSignupIsExplicitlyEnabled();
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

export interface StoredAccount {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
}

function toUser(account: Pick<StoredAccount, "id" | "email" | "displayName">): AuthenticatedUser {
  return {
    userId: account.id,
    displayName: account.displayName,
    email: account.email,
    fullName: account.displayName,
    source: "account",
  };
}

export async function createAccount(
  email: string,
  password: string,
  displayName: string,
  policyVersion: string,
): Promise<{ ok: true; user: AuthenticatedUser } | { ok: false; reason: "exists" | "invalid" }> {
  const normalizedEmail = normalizeEmail(email);
  const name = displayName.trim().slice(0, 100);
  const acceptedPolicy = policyVersion.trim();
  if (
    !validEmail(normalizedEmail) ||
    !signupEmailIsAllowed(normalizedEmail) ||
    !validPassword(password) ||
    !name ||
    !/^[A-Za-z0-9._-]{1,32}$/.test(acceptedPolicy)
  ) {
    return { ok: false, reason: "invalid" };
  }
  const id = `user_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(password);
  try {
    await execute(
      `INSERT INTO accounts (
        id, email, display_name, password_hash,
        policy_accepted_at, policy_version, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, normalizedEmail, name, passwordHash, now, acceptedPolicy, now, now],
    );
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, reason: "exists" };
    throw error;
  }
  return { ok: true, user: toUser({ id, email: normalizedEmail, displayName: name }) };
}

export async function authenticateAccount(
  email: string,
  password: string,
): Promise<AuthenticatedUser | null> {
  const normalizedEmail = normalizeEmail(email);
  if (!validEmail(normalizedEmail) || !password) return null;
  const row = await queryOne<{
    id: string;
    email: string;
    display_name: string;
    password_hash: string;
  }>("SELECT id, email, display_name, password_hash FROM accounts WHERE email = $1 LIMIT 1", [
    normalizedEmail,
  ]);
  if (!row) {
    await hashPassword("wageshield-dummy-password");
    return null;
  }
  if (!(await verifyPassword(password, row.password_hash))) return null;
  return toUser({ id: row.id, email: row.email, displayName: row.display_name });
}

export async function createSession(userId: string, secure: boolean): Promise<string> {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256Hex(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  await transaction(async (database) => {
    // Serialize session creation for this account so the 20-session cap also
    // holds when multiple sign-ins complete at the same time.
    await database.queryOne("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [userId]);
    await database.execute(
      `INSERT INTO auth_sessions (id, account_id, token_hash, created_at, expires_at)
        VALUES ($1, $2, $3, $4, $5)`,
      [`sess_${crypto.randomUUID()}`, userId, tokenHash, now.toISOString(), expiresAt],
    );
    await database.execute(
      "DELETE FROM auth_sessions WHERE account_id = $1 AND expires_at <= $2",
      [userId, now.toISOString()],
    );
    await database.execute(
      `DELETE FROM auth_sessions
        WHERE account_id = $1 AND id IN (
          SELECT id FROM auth_sessions
          WHERE account_id = $1
          ORDER BY created_at DESC, id DESC
          OFFSET 20
        )`,
      [userId],
    );
  });
  return authCookie(token, secure, SESSION_MAX_AGE_SECONDS);
}

export type AuthAction = "signin" | "signup" | "reset";

function clientIp(request: Request): string {
  // Render replaces the first X-Forwarded-For entry with the real client IP.
  // Ignore later proxy-chain values and reject malformed input before hashing
  // it into an abuse-control bucket.
  const forwarded = request.headers.get("x-forwarded-for");
  const client = forwarded?.split(",", 1)[0]?.trim();
  return client && isIP(client) ? client : "unknown";
}

async function authBuckets(
  request: Request,
  action: AuthAction,
  email: string,
): Promise<string[]> {
  const materials = [`${action}:ip:${clientIp(request)}`];
  const normalizedEmail = normalizeEmail(email).slice(0, 254);
  if (normalizedEmail) materials.push(`${action}:email:${normalizedEmail}`);
  return Promise.all(materials.map(async (value) => `rl_${await sha256Hex(value)}`));
}

export async function isAuthLocked(
  request: Request,
  action: AuthAction,
  email: string,
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const now = Date.now();
  const buckets = await authBuckets(request, action, email);
  for (const bucket of buckets) {
    const row = await queryOne<{ locked_until: string | null }>(
      "SELECT locked_until FROM auth_rate_limits WHERE bucket = $1 LIMIT 1",
      [bucket],
    );
    const lockedUntil = row?.locked_until ? Date.parse(row.locked_until) : 0;
    if (lockedUntil > now) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil - now) / 1000)) };
    }
  }
  return { ok: true };
}

export async function recordAuthAttempt(
  request: Request,
  action: AuthAction,
  email: string,
): Promise<void> {
  const now = Date.now();
  const windowMs = action === "signin" ? 15 * 60 * 1000 : 60 * 60 * 1000;
  const maxAttempts = action === "signin" ? 10 : action === "signup" ? 12 : 6;
  const nowIso = new Date(now).toISOString();
  const cutoff = new Date(now - windowMs).toISOString();
  const nextLock = new Date(now + windowMs).toISOString();
  const buckets = await authBuckets(request, action, email);
  await transaction(async (database) => {
    for (const bucket of buckets) {
      await database.execute(
        `INSERT INTO auth_rate_limits (bucket, attempt_count, window_started_at, locked_until)
          VALUES ($1, 1, $2, NULL)
          ON CONFLICT(bucket) DO UPDATE SET
            locked_until = CASE
              WHEN auth_rate_limits.window_started_at > $3
                AND auth_rate_limits.attempt_count + 1 >= $4 THEN $5
              ELSE NULL
            END,
            attempt_count = CASE
              WHEN auth_rate_limits.window_started_at > $3
                THEN auth_rate_limits.attempt_count + 1
              ELSE 1
            END,
            window_started_at = CASE
              WHEN auth_rate_limits.window_started_at > $3
                THEN auth_rate_limits.window_started_at
              ELSE excluded.window_started_at
            END`,
        [bucket, nowIso, cutoff, maxAttempts, nextLock],
      );
    }
  });
}

export async function clearAuthRateLimit(_request: Request, email: string): Promise<void> {
  const normalizedEmail = normalizeEmail(email).slice(0, 254);
  if (!normalizedEmail) return;
  const emailBucket = `rl_${await sha256Hex(`signin:email:${normalizedEmail}`)}`;
  await execute("DELETE FROM auth_rate_limits WHERE bucket = $1", [emailBucket]);
}

export async function getAccountById(userId: string): Promise<AuthenticatedUser | null> {
  const row = await queryOne<{ id: string; email: string; display_name: string }>(
    "SELECT id, email, display_name FROM accounts WHERE id = $1 LIMIT 1",
    [userId],
  );
  return row ? toUser({ id: row.id, email: row.email, displayName: row.display_name }) : null;
}

export async function getAccountPolicyAcceptance(
  userId: string,
): Promise<{ acceptedAt: string; version: string } | null> {
  const row = await queryOne<{ policy_accepted_at: string; policy_version: string }>(
    `SELECT policy_accepted_at, policy_version FROM accounts
      WHERE id = $1 AND policy_accepted_at IS NOT NULL AND policy_version IS NOT NULL LIMIT 1`,
    [userId],
  );
  return row
    ? { acceptedAt: row.policy_accepted_at, version: row.policy_version }
    : null;
}

export async function updateAccount(
  userId: string,
  input: {
    currentPassword: string;
    displayName: string;
    email: string;
    newPassword?: string;
  },
): Promise<
  { ok: true; user: AuthenticatedUser } | { ok: false; reason: "invalid" | "password" | "exists" | "missing" }
> {
  const name = input.displayName.trim().slice(0, 100);
  const email = normalizeEmail(input.email);
  const newPassword = input.newPassword?.trim() ? input.newPassword : undefined;
  if (!name || !validEmail(email) || !input.currentPassword) return { ok: false, reason: "invalid" };
  if (newPassword !== undefined && !validPassword(newPassword)) return { ok: false, reason: "invalid" };

  const row = await queryOne<{
    id: string;
    email: string;
    display_name: string;
    password_hash: string;
  }>("SELECT id, email, display_name, password_hash FROM accounts WHERE id = $1 LIMIT 1", [
    userId,
  ]);
  if (!row) return { ok: false, reason: "missing" };
  if (!(await verifyPassword(input.currentPassword, row.password_hash))) {
    return { ok: false, reason: "password" };
  }
  if (email !== row.email && !signupEmailIsAllowed(email)) {
    return { ok: false, reason: "invalid" };
  }

  const passwordHash = newPassword ? await hashPassword(newPassword) : row.password_hash;
  try {
    const updated = await execute(
      `UPDATE accounts
        SET email = $1, display_name = $2, password_hash = $3, updated_at = $4
        WHERE id = $5 AND password_hash = $6`,
      [email, name, passwordHash, new Date().toISOString(), userId, row.password_hash],
    );
    if (!updated) {
      const exists = await queryOne<{ present: number }>(
        "SELECT 1 AS present FROM accounts WHERE id = $1",
        [userId],
      );
      return { ok: false, reason: exists ? "password" : "missing" };
    }
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, reason: "exists" };
    throw error;
  }
  return { ok: true, user: toUser({ id: userId, email, displayName: name }) };
}

/**
 * Re-authenticates a local account before a destructive account-wide action.
 * The lookup is by the authenticated account ID rather than a submitted email,
 * so changing an email address cannot redirect the check to another account.
 */
export async function verifyAccountPasswordById(
  userId: string,
  password: string,
): Promise<"verified" | "password" | "missing"> {
  if (!password || password.length > 128) return "password";
  const row = await queryOne<{ password_hash: string }>(
    "SELECT password_hash FROM accounts WHERE id = $1 LIMIT 1",
    [userId],
  );
  if (!row) {
    // Keep the missing-account path computationally similar to a bad password.
    await hashPassword("wageshield-dummy-password");
    return "missing";
  }
  return (await verifyPassword(password, row.password_hash)) ? "verified" : "password";
}

/**
 * Revokes every browser session before account deletion begins. A failed
 * storage cleanup therefore cannot leave a destructive request authenticated;
 * the owner can still sign in again and retry.
 */
export async function revokeAllSessions(userId: string): Promise<void> {
  await execute("DELETE FROM auth_sessions WHERE account_id = $1", [userId]);
}

/**
 * Removes the local identity record after all owned cases have been verified
 * deleted. The conditional delete prevents intentionally retained case data
 * from becoming orphaned if cleanup was incomplete or a concurrent write won.
 */
export async function deleteAccountRecord(userId: string): Promise<boolean> {
  return transaction(async (database) => {
    const account = await database.queryOne<{ id: string }>(
      "SELECT id FROM accounts WHERE id = $1 FOR UPDATE",
      [userId],
    );
    if (!account) return false;

    const ownedCase = await database.queryOne<{ id: string }>(
      "SELECT id FROM cases WHERE owner_user_id = $1 LIMIT 1",
      [userId],
    );
    if (ownedCase) return false;

    await database.execute("DELETE FROM auth_sessions WHERE account_id = $1", [userId]);
    await database.execute("DELETE FROM password_resets WHERE account_id = $1", [userId]);
    await database.execute(
      `DELETE FROM idempotency_keys
        WHERE owner_user_id = $1 AND operation_scope != 'account:deletion'`,
      [userId],
    );
    return Boolean(await database.execute("DELETE FROM accounts WHERE id = $1", [userId]));
  });
}

export async function revokeOtherSessions(cookieHeader: string | null, userId: string): Promise<void> {
  const token = readAuthToken(cookieHeader);
  if (!token) {
    await execute("DELETE FROM auth_sessions WHERE account_id = $1", [userId]);
    return;
  }
  await execute("DELETE FROM auth_sessions WHERE account_id = $1 AND token_hash != $2", [
    userId,
    await sha256Hex(token),
  ]);
}

export async function getAccountFromCookie(cookieHeader: string | null): Promise<AuthenticatedUser | null> {
  const token = readAuthToken(cookieHeader);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await queryOne<{ id: string; email: string; display_name: string }>(
    `SELECT a.id, a.email, a.display_name
      FROM auth_sessions s
      INNER JOIN accounts a ON a.id = s.account_id
      WHERE s.token_hash = $1 AND s.expires_at > $2
      LIMIT 1`,
    [tokenHash, new Date().toISOString()],
  );
  return row ? toUser({ id: row.id, email: row.email, displayName: row.display_name }) : null;
}

export async function revokeSession(cookieHeader: string | null): Promise<void> {
  const token = readAuthToken(cookieHeader);
  if (!token) return;
  await execute("DELETE FROM auth_sessions WHERE token_hash = $1", [await sha256Hex(token)]);
}

export async function purgeExpiredSessions(): Promise<void> {
  const now = new Date().toISOString();
  await transaction(async (database) => {
    await database.execute("DELETE FROM auth_sessions WHERE expires_at <= $1", [now]);
    await database.execute("DELETE FROM password_resets WHERE expires_at <= $1", [now]);
    await database.execute(
      `DELETE FROM auth_rate_limits
        WHERE window_started_at <= $1 AND (locked_until IS NULL OR locked_until <= $2)`,
      [new Date(Date.now() - 60 * 60 * 1000).toISOString(), now],
    );
  });
}

export const PASSWORD_RESET_MINUTES = 30;

/**
 * Issues a single-use reset token. Returns null when no account matches, so the
 * caller can respond identically either way and avoid account enumeration.
 */
export async function createPasswordReset(
  email: string,
): Promise<{ token: string; email: string } | null> {
  const normalizedEmail = normalizeEmail(email);
  if (!validEmail(normalizedEmail)) return null;
  const now = new Date();
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const resetId = `reset_${crypto.randomUUID()}`;
  const tokenHash = await sha256Hex(token);
  return transaction(async (database) => {
    const row = await database.queryOne<{ id: string; email: string }>(
      "SELECT id, email FROM accounts WHERE email = $1 LIMIT 1 FOR KEY SHARE",
      [normalizedEmail],
    );
    if (!row) return null;
    await database.execute(
      `INSERT INTO password_resets (id, account_id, token_hash, created_at, expires_at, used_at)
        VALUES ($1, $2, $3, $4, $5, NULL)
        ON CONFLICT(account_id) DO UPDATE SET
          id = excluded.id,
          token_hash = excluded.token_hash,
          created_at = excluded.created_at,
          expires_at = excluded.expires_at,
          used_at = NULL`,
      [
        resetId,
        row.id,
        tokenHash,
        now.toISOString(),
        new Date(now.getTime() + PASSWORD_RESET_MINUTES * 60 * 1000).toISOString(),
      ],
    );
    return { token, email: row.email };
  });
}

export function validResetToken(token: string): boolean {
  return /^[a-f0-9]{64}$/i.test(token);
}

/** Avoid rendering a password form for an already used or expired token. */
export async function passwordResetTokenIsUsable(token: string): Promise<boolean> {
  if (!validResetToken(token)) return false;
  const row = await queryOne<{ usable: number }>(
    `SELECT 1 AS usable FROM password_resets
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2 LIMIT 1`,
    [await sha256Hex(token), new Date().toISOString()],
  );
  return Boolean(row?.usable);
}

/**
 * Consumes a reset token and rotates the password. Every existing session for
 * the account is revoked so a thief who already holds a cookie is logged out.
 */
export async function completePasswordReset(
  token: string,
  newPassword: string,
): Promise<{ ok: true } | { ok: false; reason: "invalid" | "expired" | "weak" }> {
  if (!validResetToken(token)) return { ok: false, reason: "invalid" };
  if (!validPassword(newPassword)) return { ok: false, reason: "weak" };
  const tokenHash = await sha256Hex(token);
  const row = await queryOne<{
    id: string;
    account_id: string;
    expires_at: string;
    used_at: string | null;
  }>(
    `SELECT id, account_id, expires_at, used_at FROM password_resets
      WHERE token_hash = $1 LIMIT 1`,
    [tokenHash],
  );
  if (!row || row.used_at) return { ok: false, reason: "invalid" };
  if (Date.parse(row.expires_at) <= Date.now()) return { ok: false, reason: "expired" };

  const passwordHash = await hashPassword(newPassword);
  const now = new Date().toISOString();
  return transaction(async (database) => {
    const current = await database.queryOne<{
      id: string;
      account_id: string;
      expires_at: string;
      used_at: string | null;
    }>(
      `SELECT id, account_id, expires_at, used_at FROM password_resets
        WHERE token_hash = $1 FOR UPDATE`,
      [tokenHash],
    );
    if (!current || current.used_at) return { ok: false, reason: "invalid" };
    if (current.expires_at <= now) return { ok: false, reason: "expired" };

    const accountUpdated = await database.execute(
      "UPDATE accounts SET password_hash = $1, updated_at = $2 WHERE id = $3",
      [passwordHash, now, current.account_id],
    );
    if (!accountUpdated) return { ok: false, reason: "invalid" };

    await database.execute("DELETE FROM auth_sessions WHERE account_id = $1", [
      current.account_id,
    ]);
    await database.execute("DELETE FROM password_resets WHERE id = $1", [current.id]);
    return { ok: true };
  });
}

export function readAuthToken(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    const key = (index < 0 ? part : part.slice(0, index)).trim();
    if (key !== AUTH_COOKIE) continue;
    const value = (index < 0 ? "" : part.slice(index + 1)).trim();
    try {
      const token = decodeURIComponent(value);
      return /^[a-f0-9]{64}$/i.test(token) ? token : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function authCookie(token: string, secure: boolean, maxAge = SESSION_MAX_AGE_SECONDS): string {
  const flags = [
    `${AUTH_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) flags.push("Secure");
  return flags.join("; ");
}

export function clearAuthCookie(secure: boolean): string {
  return authCookie("", secure, 0);
}
