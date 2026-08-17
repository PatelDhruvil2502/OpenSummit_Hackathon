import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import {
  execute,
  query,
  queryOne,
  transaction,
  type DatabaseExecutor,
} from "@/db";
import { UPLOAD_POLICY } from "./product-config";

const LOCAL_METADATA_DIRECTORY = ".wageshield-metadata";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_GLOBAL_MAX_BYTES = 3 * 1024 * 1024 * 1024;
const DEFAULT_ACCOUNT_MAX_BYTES = Math.floor(1.5 * 1024 * 1024 * 1024);
const OBJECT_PUT_ADVISORY_LOCK = "6292455195598152276";

export interface PrivateStoredObject {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  etag: string;
  size: number;
}

export interface PrivateObjectStorage {
  put(
    caseId: string,
    key: string,
    body: ArrayBuffer | Uint8Array,
    contentType: string,
  ): Promise<void>;
  get(key: string): Promise<PrivateStoredObject | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
}

type PrivateObjectRow = {
  content_type: string;
  byte_size: number;
  sha256: string;
  body: Buffer;
};

export interface ObjectStorageDatabase {
  execute(sql: string, parameters?: readonly unknown[]): Promise<number>;
  queryOne<Row extends Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<Row | null>;
  queryRows<Row extends Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<Row[]>;
  transaction<Result>(
    callback: (database: ObjectStorageDatabase) => Promise<Result>,
  ): Promise<Result>;
}

function executorDatabase(database: DatabaseExecutor): ObjectStorageDatabase {
  return {
    execute: database.execute,
    queryOne: database.queryOne,
    async queryRows<Row extends Record<string, unknown>>(
      sql: string,
      parameters?: readonly unknown[],
    ): Promise<Row[]> {
      return (await database.query<Row>(sql, parameters)).rows;
    },
    async transaction<Result>(
      callback: (database: ObjectStorageDatabase) => Promise<Result>,
    ): Promise<Result> {
      return callback(executorDatabase(database));
    },
  };
}

const postgresDatabase: ObjectStorageDatabase = {
  execute,
  queryOne,
  async queryRows<Row extends Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<Row[]> {
    return (await query<Row>(sql, parameters)).rows;
  },
  transaction(callback) {
    return transaction((database) => callback(executorDatabase(database)));
  },
};

export class PrivateObjectStorageQuotaError extends Error {
  constructor(readonly scope: "account" | "global") {
    super("Private storage capacity is unavailable for additional files.");
    this.name = "PrivateObjectStorageQuotaError";
  }
}

function exactBytes(body: ArrayBuffer | Uint8Array): Uint8Array {
  if (body instanceof Uint8Array) return Uint8Array.from(body);
  return new Uint8Array(body.slice(0));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function singleChunkStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function validateCaseId(caseId: string): string {
  if (!/^case_[A-Za-z0-9_-]{1,160}$/.test(caseId)) {
    throw new Error("Invalid private object case identifier");
  }
  return caseId;
}

function validateObjectKey(key: string, allowTrailingSlash = false): string {
  if (
    !key ||
    key.length > 1_024 ||
    key.includes("\0") ||
    key.includes("\\") ||
    key.startsWith("/") ||
    isAbsolute(key)
  ) {
    throw new Error("Invalid private object key");
  }
  const segments = key.split("/");
  if (allowTrailingSlash && segments.at(-1) === "") segments.pop();
  if (!segments.length || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Invalid private object key");
  }
  return key;
}

function validateCaseObjectKey(caseId: string, key: string): void {
  validateCaseId(caseId);
  validateObjectKey(key);
  if (
    !key.startsWith(`private/cases/${caseId}/`) &&
    !key.startsWith(`private/demo/${caseId}/`)
  ) {
    throw new Error("Private object key does not belong to the supplied case");
  }
}

function validateContentType(contentType: string): string {
  const value = contentType.trim().toLowerCase();
  if (!value || value.length > 255 || /[\r\n]/.test(value)) {
    throw new Error("Invalid private object content type");
  }
  return value;
}

function validateObjectSize(bytes: Uint8Array): void {
  if (bytes.byteLength > UPLOAD_POLICY.maximumFileBytes) {
    throw new Error(
      `Private objects cannot exceed ${UPLOAD_POLICY.maximumFileBytes} bytes`,
    );
  }
}

function storageByteLimit(
  environmentName: "OBJECT_STORAGE_GLOBAL_MAX_BYTES" | "OBJECT_STORAGE_ACCOUNT_MAX_BYTES",
  fallback: number,
): number {
  const configured = process.env[environmentName]?.trim();
  if (!configured) return fallback;
  if (!/^\d+$/.test(configured)) {
    throw new Error(`${environmentName} must be a positive integer`);
  }
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${environmentName} must be a positive safe integer`);
  }
  // Demo deployments can lower a ceiling, but cannot accidentally exceed the
  // capacity budget that reserves space for PostgreSQL metadata and indexes.
  return Math.min(value, fallback);
}

function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * Render-only production object storage. PostgreSQL returns BYTEA as a Buffer;
 * objects are capped at 12 MB, so converting that buffer into one web-stream
 * chunk has a bounded memory cost and requires no public file URL.
 */
export class PostgresPrivateObjectStorage implements PrivateObjectStorage {
  constructor(private readonly database: ObjectStorageDatabase = postgresDatabase) {}

  async put(
    caseId: string,
    key: string,
    body: ArrayBuffer | Uint8Array,
    contentType: string,
  ): Promise<void> {
    validateCaseObjectKey(caseId, key);
    const bytes = exactBytes(body);
    validateObjectSize(bytes);
    const digest = sha256(bytes);
    const normalizedContentType = validateContentType(contentType);
    const globalLimit = storageByteLimit(
      "OBJECT_STORAGE_GLOBAL_MAX_BYTES",
      DEFAULT_GLOBAL_MAX_BYTES,
    );
    const accountLimit = storageByteLimit(
      "OBJECT_STORAGE_ACCOUNT_MAX_BYTES",
      DEFAULT_ACCOUNT_MAX_BYTES,
    );

    await this.database.transaction(async (database) => {
      // One transaction-scoped lock serializes capacity checks across every
      // web instance and cron/deletion race without holding a session lock.
      await database.queryOne<{ locked: null }>(
        "SELECT pg_advisory_xact_lock($1::bigint) AS locked",
        [OBJECT_PUT_ADVISORY_LOCK],
      );
      if (
        await database.queryOne<{ present: number }>(
          "SELECT 1 AS present FROM private_objects WHERE object_key = $1 LIMIT 1",
          [key],
        )
      ) {
        throw new Error("Private object already exists");
      }
      const owner = await database.queryOne<{ owner_user_id: string }>(
        `SELECT owner_user_id FROM cases
          WHERE id = $1 AND state != 'DELETION_PENDING' FOR SHARE`,
        [caseId],
      );
      if (!owner) throw new Error("Private object case is unavailable");

      const usage = await database.queryOne<{
        global_bytes: string | number;
        account_bytes: string | number;
      }>(
        `SELECT
          (SELECT COALESCE(SUM(byte_size), 0) FROM private_objects) AS global_bytes,
          (SELECT COALESCE(SUM(private_objects.byte_size), 0)
            FROM private_objects
            INNER JOIN cases ON cases.id = private_objects.case_id
            WHERE cases.owner_user_id = $1) AS account_bytes`,
        [owner.owner_user_id],
      );
      const globalBytes = Number(usage?.global_bytes ?? 0);
      const accountBytes = Number(usage?.account_bytes ?? 0);
      if (globalBytes + bytes.byteLength > globalLimit) {
        throw new PrivateObjectStorageQuotaError("global");
      }
      if (accountBytes + bytes.byteLength > accountLimit) {
        throw new PrivateObjectStorageQuotaError("account");
      }

      const inserted = await database.execute(
        `INSERT INTO private_objects (
          object_key, case_id, content_type, byte_size, sha256, body, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6,
          to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        ON CONFLICT (object_key) DO NOTHING`,
        [key, caseId, normalizedContentType, bytes.byteLength, digest, Buffer.from(bytes)],
      );
      if (!inserted) throw new Error("Private object already exists");
    });
  }

  async get(key: string): Promise<PrivateStoredObject | null> {
    validateObjectKey(key);
    const row = await this.database.queryOne<PrivateObjectRow>(
      `SELECT content_type, byte_size, sha256, body
        FROM private_objects WHERE object_key = $1 LIMIT 1`,
      [key],
    );
    if (!row) return null;
    const bytes = Uint8Array.from(row.body);
    if (
      row.byte_size !== bytes.byteLength ||
      !SHA256_PATTERN.test(row.sha256) ||
      sha256(bytes) !== row.sha256
    ) {
      throw new Error("Private object integrity check failed");
    }
    return {
      body: singleChunkStream(bytes),
      contentType: row.content_type,
      etag: `"${row.sha256}"`,
      size: row.byte_size,
    };
  }

  async delete(key: string): Promise<void> {
    validateObjectKey(key);
    await this.database.execute("DELETE FROM private_objects WHERE object_key = $1", [key]);
  }

  async exists(key: string): Promise<boolean> {
    validateObjectKey(key);
    return Boolean(
      await this.database.queryOne<{ present: number }>(
        "SELECT 1 AS present FROM private_objects WHERE object_key = $1 LIMIT 1",
        [key],
      ),
    );
  }

  async list(prefix: string): Promise<string[]> {
    validateObjectKey(prefix, true);
    const rows = await this.database.queryRows<{ object_key: string }>(
      `SELECT object_key FROM private_objects
        WHERE object_key LIKE $1 ESCAPE E'\\\\'
        ORDER BY object_key ASC`,
      [`${escapeLikePrefix(prefix)}%`],
    );
    return rows.map((row) => row.object_key);
  }
}

function requiredLocalRoot(): string {
  const configured = process.env.OBJECT_STORAGE_LOCAL_DIR?.trim();
  if (!configured) {
    throw new Error(
      "OBJECT_STORAGE_LOCAL_DIR is required when OBJECT_STORAGE_DRIVER=filesystem",
    );
  }
  const root = resolve(configured);
  if (root === parse(root).root) throw new Error("Object storage directory cannot be a filesystem root");
  return root;
}

/**
 * Resolve the deterministic on-disk location used by the explicit test driver.
 * Keeping this exported lets the integration harness inspect persistence from
 * a process separate from the Next.js server without adding a test-only API.
 */
export function resolveLocalObjectPath(key: string, baseDirectory?: string): string {
  validateObjectKey(key);
  const root = resolve(baseDirectory ?? requiredLocalRoot());
  const target = resolve(root, key);
  const withinRoot = relative(root, target);
  if (!withinRoot || withinRoot.startsWith(`..${sep}`) || withinRoot === "..") {
    throw new Error("Private object key escaped the configured storage directory");
  }
  return target;
}

function localMetadataPath(root: string, key: string): string {
  return resolveLocalObjectPath(`${LOCAL_METADATA_DIRECTORY}/${key}.json`, root);
}

type LocalMetadata = { contentType: string; etag: string; size: number };

async function walkFiles(directory: string, root: string, output: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (directory === root && entry.name === LOCAL_METADATA_DIRECTORY) continue;
    const location = join(directory, entry.name);
    if (entry.isDirectory()) await walkFiles(location, root, output);
    else if (entry.isFile()) output.push(relative(root, location).split(sep).join("/"));
  }
}

class LocalFilesystemObjectStorage implements PrivateObjectStorage {
  private readonly root = requiredLocalRoot();

  async put(
    caseId: string,
    key: string,
    body: ArrayBuffer | Uint8Array,
    contentType: string,
  ): Promise<void> {
    validateCaseObjectKey(caseId, key);
    const location = resolveLocalObjectPath(key, this.root);
    const metadataLocation = localMetadataPath(this.root, key);
    const bytes = exactBytes(body);
    validateObjectSize(bytes);
    const temporary = `${location}.${crypto.randomUUID()}.tmp`;
    await mkdir(dirname(location), { recursive: true });
    await mkdir(dirname(metadataLocation), { recursive: true });
    await writeFile(temporary, bytes);
    let created = false;
    try {
      await copyFile(temporary, location, fsConstants.COPYFILE_EXCL);
      created = true;
      const metadata: LocalMetadata = {
        contentType: validateContentType(contentType),
        etag: `"${sha256(bytes)}"`,
        size: bytes.byteLength,
      };
      await writeFile(metadataLocation, JSON.stringify(metadata), { flag: "wx" });
    } catch (error) {
      // A collision must never delete the object that won the race. Only undo
      // files created by this invocation.
      if (created) {
        await rm(location, { force: true }).catch(() => undefined);
        await rm(metadataLocation, { force: true }).catch(() => undefined);
      }
      throw error;
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async get(key: string): Promise<PrivateStoredObject | null> {
    const location = resolveLocalObjectPath(key, this.root);
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(await readFile(location));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let metadata: LocalMetadata | null = null;
    try {
      metadata = JSON.parse(
        await readFile(localMetadataPath(this.root, key), "utf8"),
      ) as LocalMetadata;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return {
      body: singleChunkStream(bytes),
      contentType: metadata?.contentType ?? "application/octet-stream",
      etag: metadata?.etag ?? `"${sha256(bytes)}"`,
      size: metadata?.size ?? bytes.byteLength,
    };
  }

  async delete(key: string): Promise<void> {
    await Promise.all([
      rm(resolveLocalObjectPath(key, this.root), { force: true }),
      rm(localMetadataPath(this.root, key), { force: true }),
    ]);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(resolveLocalObjectPath(key, this.root));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    validateObjectKey(prefix, true);
    const files: string[] = [];
    await mkdir(this.root, { recursive: true });
    await walkFiles(this.root, this.root, files);
    return files.filter((key) => key.startsWith(prefix)).sort();
  }
}

let cachedDriver: { key: string; storage: PrivateObjectStorage } | null = null;

export function getPrivateObjectStorage(): PrivateObjectStorage {
  const driver = process.env.OBJECT_STORAGE_DRIVER?.trim() || "postgres";
  const cacheKey = `${driver}:${
    driver === "filesystem" ? process.env.OBJECT_STORAGE_LOCAL_DIR ?? "" : "shared-pool"
  }`;
  if (cachedDriver?.key === cacheKey) return cachedDriver.storage;

  let storage: PrivateObjectStorage;
  if (driver === "postgres") storage = new PostgresPrivateObjectStorage();
  else if (driver === "filesystem") storage = new LocalFilesystemObjectStorage();
  else throw new Error(`Unsupported private object-storage driver: ${driver}`);

  cachedDriver = { key: cacheKey, storage };
  return storage;
}
