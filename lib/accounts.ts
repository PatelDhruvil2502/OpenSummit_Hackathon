import { env } from "cloudflare:workers";
import type { AuthenticatedUser } from "./identity";
import { ensureStorage } from "./storage";

const AUTH_COOKIE = "wageshield_auth";
const SESSION_DAYS = 30;
const SESSION_MAX_AGE_SECONDS = SESSION_DAYS * 24 * 60 * 60;
const PBKDF2_ITERATIONS = 210_000;
const encoder = new TextEncoder();

export const AUTH_COOKIE_NAME = AUTH_COOKIE;

function database(): D1Database {
  const runtime = env as unknown as { DB?: D1Database };
  if (!runtime.DB) throw new Error("Database binding is unavailable");
  return runtime.DB;
}

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
): Promise<{ ok: true; user: AuthenticatedUser } | { ok: false; reason: "exists" | "invalid" }> {
  const normalizedEmail = normalizeEmail(email);
  const name = displayName.trim().slice(0, 100);
  if (!validEmail(normalizedEmail) || !validPassword(password) || !name) {
    return { ok: false, reason: "invalid" };
  }
  await ensureStorage();
  const id = `user_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(password);
  try {
    await database()
      .prepare(
        `INSERT INTO accounts (id, email, display_name, password_hash, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, normalizedEmail, name, passwordHash, now, now)
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/unique|constraint/i.test(message)) return { ok: false, reason: "exists" };
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
  await ensureStorage();
  const row = await database()
    .prepare(
      "SELECT id, email, display_name, password_hash FROM accounts WHERE email = ? LIMIT 1",
    )
    .bind(normalizedEmail)
    .first<{ id: string; email: string; display_name: string; password_hash: string }>();
  if (!row) {
    await hashPassword("wageshield-dummy-password");
    return null;
  }
  if (!(await verifyPassword(password, row.password_hash))) return null;
  return toUser({ id: row.id, email: row.email, displayName: row.display_name });
}

export async function createSession(userId: string, secure: boolean): Promise<string> {
  await ensureStorage();
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256Hex(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  await database()
    .prepare(
      `INSERT INTO auth_sessions (id, account_id, token_hash, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(`sess_${crypto.randomUUID()}`, userId, tokenHash, now.toISOString(), expiresAt)
    .run();
  await database()
    .prepare("DELETE FROM auth_sessions WHERE account_id = ? AND expires_at <= ?")
    .bind(userId, now.toISOString())
    .run();
  await database()
    .prepare(
      `DELETE FROM auth_sessions
        WHERE account_id = ?
          AND created_at < COALESCE((
            SELECT created_at FROM auth_sessions
            WHERE account_id = ?
            ORDER BY created_at DESC
            LIMIT 1 OFFSET 19
          ), '0000-01-01')`,
    )
    .bind(userId, userId)
    .run();
  return authCookie(token, secure, SESSION_MAX_AGE_SECONDS);
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0];
  return (forwarded ?? "local").trim().slice(0, 128) || "local";
}

export async function isAuthLocked(
  request: Request,
  action: "signin" | "signup",
  email: string,
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  await ensureStorage();
  const now = Date.now();
  const buckets = authBuckets(request, action, email);
  for (const bucket of buckets) {
    const row = await database()
      .prepare("SELECT locked_until FROM auth_rate_limits WHERE bucket = ? LIMIT 1")
      .bind(bucket)
      .first<{ locked_until: string | null }>();
    const lockedUntil = row?.locked_until ? Date.parse(row.locked_until) : 0;
    if (lockedUntil > now) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil - now) / 1000)) };
    }
  }
  return { ok: true };
}

export async function recordAuthAttempt(
  request: Request,
  action: "signin" | "signup",
  email: string,
): Promise<void> {
  await ensureStorage();
  const now = Date.now();
  const windowMs = action === "signup" ? 60 * 60 * 1000 : 15 * 60 * 1000;
  const maxAttempts = action === "signup" ? 12 : 10;
  for (const bucket of authBuckets(request, action, email)) {
    const row = await database()
      .prepare(
        "SELECT attempt_count, window_started_at FROM auth_rate_limits WHERE bucket = ? LIMIT 1",
      )
      .bind(bucket)
      .first<{ attempt_count: number; window_started_at: string }>();
    const windowStart = row ? Date.parse(row.window_started_at) : now;
    const inWindow = Number.isFinite(windowStart) && now - windowStart < windowMs;
    const count = inWindow ? (row?.attempt_count ?? 0) + 1 : 1;
    const nextLock = count >= maxAttempts ? new Date(now + windowMs).toISOString() : null;
    await database()
      .prepare(
        `INSERT INTO auth_rate_limits (bucket, attempt_count, window_started_at, locked_until)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(bucket) DO UPDATE SET
            attempt_count = excluded.attempt_count,
            window_started_at = excluded.window_started_at,
            locked_until = excluded.locked_until`,
      )
      .bind(
        bucket,
        count,
        inWindow && row ? row.window_started_at : new Date(now).toISOString(),
        nextLock,
      )
      .run();
  }
}

function authBuckets(request: Request, action: "signin" | "signup", email: string): string[] {
  const buckets = [`${action}:ip:${clientIp(request)}`];
  if (email) buckets.push(`${action}:email:${normalizeEmail(email)}`);
  return buckets;
}

export async function clearAuthRateLimit(request: Request, email: string): Promise<void> {
  await ensureStorage();
  await database()
    .prepare("DELETE FROM auth_rate_limits WHERE bucket IN (?, ?)")
    .bind(`signin:ip:${clientIp(request)}`, `signin:email:${normalizeEmail(email)}`)
    .run();
}

export async function getAccountById(userId: string): Promise<AuthenticatedUser | null> {
  await ensureStorage();
  const row = await database()
    .prepare("SELECT id, email, display_name FROM accounts WHERE id = ? LIMIT 1")
    .bind(userId)
    .first<{ id: string; email: string; display_name: string }>();
  return row ? toUser({ id: row.id, email: row.email, displayName: row.display_name }) : null;
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

  await ensureStorage();
  const row = await database()
    .prepare(
      "SELECT id, email, display_name, password_hash FROM accounts WHERE id = ? LIMIT 1",
    )
    .bind(userId)
    .first<{ id: string; email: string; display_name: string; password_hash: string }>();
  if (!row) return { ok: false, reason: "missing" };
  if (!(await verifyPassword(input.currentPassword, row.password_hash))) {
    return { ok: false, reason: "password" };
  }

  const passwordHash = newPassword ? await hashPassword(newPassword) : row.password_hash;
  try {
    await database()
      .prepare(
        `UPDATE accounts
          SET email = ?, display_name = ?, password_hash = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(email, name, passwordHash, new Date().toISOString(), userId)
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/unique|constraint/i.test(message)) return { ok: false, reason: "exists" };
    throw error;
  }
  return { ok: true, user: toUser({ id: userId, email, displayName: name }) };
}

export async function revokeOtherSessions(cookieHeader: string | null, userId: string): Promise<void> {
  const token = readAuthToken(cookieHeader);
  await ensureStorage();
  if (!token) {
    await database().prepare("DELETE FROM auth_sessions WHERE account_id = ?").bind(userId).run();
    return;
  }
  await database()
    .prepare("DELETE FROM auth_sessions WHERE account_id = ? AND token_hash != ?")
    .bind(userId, await sha256Hex(token))
    .run();
}

export async function getAccountFromCookie(cookieHeader: string | null): Promise<AuthenticatedUser | null> {
  const token = readAuthToken(cookieHeader);
  if (!token) return null;
  await ensureStorage();
  const tokenHash = await sha256Hex(token);
  const row = await database()
    .prepare(
      `SELECT a.id, a.email, a.display_name
        FROM auth_sessions s
        INNER JOIN accounts a ON a.id = s.account_id
        WHERE s.token_hash = ? AND s.expires_at > ?
        LIMIT 1`,
    )
    .bind(tokenHash, new Date().toISOString())
    .first<{ id: string; email: string; display_name: string }>();
  return row ? toUser({ id: row.id, email: row.email, displayName: row.display_name }) : null;
}

export async function revokeSession(cookieHeader: string | null): Promise<void> {
  const token = readAuthToken(cookieHeader);
  if (!token) return;
  await ensureStorage();
  await database()
    .prepare("DELETE FROM auth_sessions WHERE token_hash = ?")
    .bind(await sha256Hex(token))
    .run();
}

export async function purgeExpiredSessions(): Promise<void> {
  await ensureStorage();
  await database()
    .prepare("DELETE FROM auth_sessions WHERE expires_at <= ?")
    .bind(new Date().toISOString())
    .run();
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
