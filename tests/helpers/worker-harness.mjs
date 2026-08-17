import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { Pool } from "pg";

const exec = promisify(execFile);
const DEFAULT_ORIGIN = "https://wageshield.test";
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function buildMinimalPdf() {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([320, 180]);
  page.drawText("Synthetic WageShield test record", {
    x: 28,
    y: 128,
    size: 12,
    font,
  });
  return document.save({ useObjectStreams: false });
}

const MINIMAL_PDF_BYTES = await buildMinimalPdf();

export async function textPdf(lines) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([612, 792]);
  lines.forEach((line, index) => {
    page.drawText(String(line), {
      x: 48,
      y: 730 - index * 24,
      size: 12,
      font,
    });
  });
  return document.save({ useObjectStreams: false });
}

function findBytes(bytes, needle) {
  outer: for (let index = 0; index <= bytes.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function mergeHeaders(...sources) {
  const headers = new Headers();
  for (const source of sources) {
    if (!source) continue;
    new Headers(source).forEach((value, key) => headers.set(key, value));
  }
  return headers;
}

export function identityHeaders(id, email = `${id}@example.test`, fullName = id) {
  return {
    "oai-authenticated-user-id": id,
    "oai-authenticated-user-email": email,
    "oai-authenticated-user-full-name": encodeURIComponent(fullName),
    "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
  };
}

export class WorkerClient {
  constructor(harness, options = {}) {
    this.harness = harness;
    this.origin = options.origin ?? DEFAULT_ORIGIN;
    this.headers = new Headers(options.headers);
    this.cookie = options.cookie ?? "";
  }

  async request(pathname, options = {}) {
    const headers = mergeHeaders(this.headers, options.headers);
    if (this.cookie && !headers.has("cookie")) headers.set("cookie", this.cookie);
    let body = options.body;
    if (options.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.json);
    }
    const response = await this.harness.fetch(
      new Request(new URL(pathname, this.origin), {
        method: options.method ?? (body === undefined ? "GET" : "POST"),
        headers,
        body,
        redirect: options.redirect ?? "manual",
      }),
    );
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";", 1)[0];
    return response;
  }

  async json(pathname, options = {}) {
    const response = await this.request(pathname, options);
    const body = await response.text();
    let payload;
    try {
      payload = body ? JSON.parse(body) : null;
    } catch {
      throw new Error(
        `${options.method ?? "GET"} ${pathname} returned non-JSON ${response.status}: ${body.slice(0, 240)}`,
      );
    }
    return { response, payload };
  }
}

function postgresParameters(sql) {
  let output = "";
  let parameter = 0;
  let singleQuoted = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (character === "'") {
      output += character;
      if (singleQuoted && sql[index + 1] === "'") {
        output += sql[index + 1];
        index += 1;
      } else {
        singleQuoted = !singleQuoted;
      }
    } else if (character === "?" && !singleQuoted) {
      output += `$${++parameter}`;
    } else {
      output += character;
    }
  }
  return output;
}

class TestStatement {
  constructor(pool, sql, parameters = []) {
    this.pool = pool;
    this.sql = postgresParameters(sql);
    this.parameters = parameters;
  }
  bind(...parameters) {
    return new TestStatement(this.pool, this.sql, parameters);
  }
  async all() {
    const result = await this.pool.query(this.sql, this.parameters);
    return { results: result.rows };
  }
  async first() {
    const result = await this.pool.query(this.sql, this.parameters);
    return result.rows[0] ?? null;
  }
  async run() {
    const result = await this.pool.query(this.sql, this.parameters);
    return { meta: { changes: result.rowCount ?? 0 } };
  }
}

class TestDatabase {
  constructor(pool) {
    this.pool = pool;
  }
  prepare(sql) {
    return new TestStatement(this.pool, sql);
  }
  async batch(statements) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const results = [];
      for (const statement of statements) {
        const result = await client.query(statement.sql, statement.parameters);
        results.push({ meta: { changes: result.rowCount ?? 0 }, results: result.rows });
      }
      await client.query("COMMIT");
      return results;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

class TestBucket {
  constructor(pool) {
    this.pool = pool;
  }
  async get(key) {
    const result = await this.pool.query(
      "SELECT byte_size, body FROM private_objects WHERE object_key = $1 LIMIT 1",
      [key],
    );
    const row = result.rows[0];
    if (!row) return null;
    const bytes = Buffer.from(row.body);
    return {
      size: Number(row.byte_size),
      body: bytes,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  }
  async list() {
    const result = await this.pool.query(
      "SELECT object_key, byte_size FROM private_objects ORDER BY object_key ASC",
    );
    return {
      objects: result.rows.map((row) => ({ key: row.object_key, size: Number(row.byte_size) })),
    };
  }
}

async function openPort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
  if (!port) throw new Error("Could not allocate a Next.js test port");
  return port;
}

async function waitForServer(origin, server, logs) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Next.js exited before becoming ready:\n${logs.join("").slice(-4_000)}`);
    }
    try {
      const response = await fetch(`${origin}/api/v1/health`, { redirect: "manual" });
      if (response.status === 200) return;
    } catch {
      // The listener is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Next.js did not become ready:\n${logs.join("").slice(-4_000)}`);
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolvePromise) => child.once("exit", () => resolvePromise(true))),
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 5_000)),
  ]);
  if (!exited) child.kill("SIGKILL");
}

export async function createWorkerHarness(label = "hardening", options = {}) {
  const adminUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!adminUrl) throw new Error("TEST_DATABASE_URL is required by the Render integration harness");
  const shortLabel = label.replace(/[^a-z0-9_]/gi, "_").toLowerCase().slice(0, 16);
  const databaseName = `wageshield_${shortLabel}_${process.pid}_${Math.random().toString(16).slice(2, 10)}`;
  const admin = new Pool({ connectionString: adminUrl });
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const databaseEnvironment = databaseUrl.toString();
  const port = await openPort();
  const origin = `http://127.0.0.1:${port}`;
  const environment = {
    ...process.env,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    PORT: String(port),
    DATABASE_URL: databaseEnvironment,
    DATABASE_POOL_MAX: "4",
    OBJECT_STORAGE_DRIVER: "postgres",
    OBJECT_STORAGE_LOCAL_DIR: "",
    RESEND_API_KEY: "",
    EMAIL_FROM: "",
    PUBLIC_APP_URL: "",
    RENDER_EXTERNAL_URL: "",
    TRUST_FORWARDED_IDENTITY: options.trustForwardedIdentity === false ? "false" : "true",
    ENABLE_SANDBOX: options.enableSandbox === false ? "false" : "true",
    INVESTOR_EMAIL_ALLOWLIST: options.investorEmailAllowlist ?? "",
    ALLOW_PUBLIC_SIGNUP: options.allowPublicSignup === false ? "false" : "true",
    NEXT_PUBLIC_COMPANY_LEGAL_NAME: "WageShield Test LLC",
    NEXT_PUBLIC_COMPANY_JURISDICTION: "Indiana, United States",
    NEXT_PUBLIC_SUPPORT_EMAIL: "support@example.test",
    NEXT_PUBLIC_PRIVACY_EMAIL: "privacy@example.test",
    NEXT_PUBLIC_SECURITY_EMAIL: "security@example.test",
  };
  try {
    await exec(process.execPath, ["--import", "tsx", "db/migrate.ts"], {
      cwd: PROJECT_ROOT,
      env: environment,
    });
  } catch (error) {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
    throw error;
  }

  const logs = [];
  const next = spawn(
    process.execPath,
    [join(PROJECT_ROOT, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: PROJECT_ROOT, env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  next.stdout.on("data", (chunk) => logs.push(String(chunk)));
  next.stderr.on("data", (chunk) => logs.push(String(chunk)));
  await waitForServer(origin, next, logs);

  const pool = new Pool({ connectionString: databaseEnvironment });
  const harness = {
    DB: new TestDatabase(pool),
    BUCKET: new TestBucket(pool),
    client(identity, clientOptions = {}) {
      return new WorkerClient(this, {
        ...clientOptions,
        headers: mergeHeaders(
          identity ? identityHeaders(identity.id, identity.email, identity.name) : undefined,
          clientOptions.headers,
        ),
      });
    },
    async fetch(request) {
      const requested = new URL(request.url);
      const headers = new Headers(request.headers);
      headers.set("host", requested.host);
      headers.set("x-forwarded-host", requested.host);
      headers.set("x-forwarded-proto", requested.protocol.slice(0, -1));
      const body = request.method === "GET" || request.method === "HEAD"
        ? undefined
        : Buffer.from(await request.arrayBuffer());
      return fetch(`${origin}${requested.pathname}${requested.search}`, {
        method: request.method,
        headers,
        body,
        redirect: request.redirect,
      });
    },
    async scheduled() {
      try {
        await exec(process.execPath, ["--import", "tsx", "scripts/retention-sweep.ts"], {
          cwd: PROJECT_ROOT,
          env: environment,
        });
        return Response.json({ outcome: "ok" });
      } catch (error) {
        return Response.json(
          { outcome: "error", message: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        );
      }
    },
    async dispose() {
      await stopProcess(next);
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.end();
    },
  };
  harness.anonymous = new WorkerClient(harness);
  return harness;
}

export async function expectJsonError(response, status, code) {
  const body = await response.text();
  const payload = JSON.parse(body);
  if (response.status !== status || payload?.error?.code !== code) {
    throw new Error(
      `Expected ${status}/${code}, received ${response.status}/${payload?.error?.code}: ${body.slice(0, 300)}`,
    );
  }
  return payload.error;
}

export function minimalPdf(extra = "") {
  if (!extra) return MINIMAL_PDF_BYTES.slice();
  const marker = new TextEncoder().encode("%%EOF");
  let markerIndex = -1;
  outer: for (let index = MINIMAL_PDF_BYTES.length - marker.length; index >= 0; index -= 1) {
    for (let offset = 0; offset < marker.length; offset += 1) {
      if (MINIMAL_PDF_BYTES[index + offset] !== marker[offset]) continue outer;
    }
    markerIndex = index;
    break;
  }
  if (markerIndex < 0) throw new Error("Generated PDF is missing its EOF marker");
  const insertion = new TextEncoder().encode(`${extra}\n`);
  const output = new Uint8Array(MINIMAL_PDF_BYTES.length + insertion.length);
  output.set(MINIMAL_PDF_BYTES.slice(0, markerIndex));
  output.set(insertion, markerIndex);
  output.set(MINIMAL_PDF_BYTES.slice(markerIndex), markerIndex + insertion.length);
  return output;
}

export function minimalPdfVariant(variant) {
  const output = MINIMAL_PDF_BYTES.slice();
  const marker = new TextEncoder().encode("/ModDate (D:");
  const markerIndex = findBytes(output, marker);
  if (markerIndex < 0) throw new Error("Generated PDF is missing its modification date");
  const digits = String(Math.abs(Number(variant)) % 1_000_000)
    .padStart(6, "0")
    .slice(-6);
  output.set(new TextEncoder().encode(digits), markerIndex + marker.length + 8);
  return output;
}
