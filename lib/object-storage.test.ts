import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getPrivateObjectStorage,
  PostgresPrivateObjectStorage,
  PrivateObjectStorageQuotaError,
  resolveLocalObjectPath,
  type ObjectStorageDatabase,
} from "./object-storage";

type FakeObject = {
  caseId: string;
  contentType: string;
  size: number;
  sha256: string;
  body: Buffer;
};

class FakeObjectDatabase implements ObjectStorageDatabase {
  readonly cases = new Map<string, string>();
  readonly objects = new Map<string, FakeObject>();
  lastListPattern = "";

  async transaction<Result>(
    callback: (database: ObjectStorageDatabase) => Promise<Result>,
  ): Promise<Result> {
    return callback(this);
  }

  async execute(sql: string, parameters: readonly unknown[] = []): Promise<number> {
    if (/^\s*INSERT INTO private_objects/.test(sql)) {
      const [key, caseId, contentType, size, digest, body] = parameters as [
        string,
        string,
        string,
        number,
        string,
        Buffer,
      ];
      if (this.objects.has(key)) return 0;
      this.objects.set(key, { caseId, contentType, size, sha256: digest, body: Buffer.from(body) });
      return 1;
    }
    if (/^DELETE FROM private_objects/.test(sql)) {
      return this.objects.delete(String(parameters[0])) ? 1 : 0;
    }
    throw new Error(`Unexpected fake execute query: ${sql}`);
  }

  async queryOne<Row extends Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<Row | null> {
    if (sql.includes("pg_advisory_xact_lock")) return { locked: null } as unknown as Row;
    if (sql.includes("SELECT 1 AS present")) {
      return (this.objects.has(String(parameters[0])) ? { present: 1 } : null) as Row | null;
    }
    if (sql.includes("SELECT owner_user_id FROM cases")) {
      const owner = this.cases.get(String(parameters[0]));
      return (owner ? { owner_user_id: owner } : null) as Row | null;
    }
    if (sql.includes("AS global_bytes")) {
      const owner = String(parameters[0]);
      let globalBytes = 0;
      let accountBytes = 0;
      for (const object of this.objects.values()) {
        globalBytes += object.size;
        if (this.cases.get(object.caseId) === owner) accountBytes += object.size;
      }
      return { global_bytes: globalBytes, account_bytes: accountBytes } as unknown as Row;
    }
    if (sql.includes("SELECT content_type, byte_size, sha256, body")) {
      const object = this.objects.get(String(parameters[0]));
      return (
        object
          ? {
              content_type: object.contentType,
              byte_size: object.size,
              sha256: object.sha256,
              body: Buffer.from(object.body),
            }
          : null
      ) as Row | null;
    }
    throw new Error(`Unexpected fake queryOne query: ${sql}`);
  }

  async queryRows<Row extends Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<Row[]> {
    if (!sql.includes("FROM private_objects")) {
      throw new Error(`Unexpected fake queryRows query: ${sql}`);
    }
    this.lastListPattern = String(parameters[0]);
    const prefix = this.lastListPattern
      .slice(0, -1)
      .replace(/\\([\\%_])/g, "$1");
    return [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .map((object_key) => ({ object_key }) as unknown as Row);
  }
}

test("the explicit filesystem driver persists, lists, streams, and deletes private objects", async () => {
  const root = await mkdtemp(join(tmpdir(), "wageshield-objects-"));
  const previousDriver = process.env.OBJECT_STORAGE_DRIVER;
  const previousRoot = process.env.OBJECT_STORAGE_LOCAL_DIR;
  process.env.OBJECT_STORAGE_DRIVER = "filesystem";
  process.env.OBJECT_STORAGE_LOCAL_DIR = root;
  try {
    const storage = getPrivateObjectStorage();
    const key = "private/cases/case_test/original/doc_test/v1/source.pdf";
    await storage.put("case_test", key, new TextEncoder().encode("private evidence"), "application/pdf");

    assert.equal(await readFile(resolveLocalObjectPath(key), "utf8"), "private evidence");
    assert.deepEqual(await storage.list("private/cases/case_test/"), [key]);
    const object = await storage.get(key);
    assert.ok(object);
    assert.equal(object.contentType, "application/pdf");
    assert.equal(
      new TextDecoder().decode(await new Response(object.body).arrayBuffer()),
      "private evidence",
    );

    await storage.delete(key);
    assert.equal(await storage.exists(key), false);
  } finally {
    if (previousDriver === undefined) delete process.env.OBJECT_STORAGE_DRIVER;
    else process.env.OBJECT_STORAGE_DRIVER = previousDriver;
    if (previousRoot === undefined) delete process.env.OBJECT_STORAGE_LOCAL_DIR;
    else process.env.OBJECT_STORAGE_LOCAL_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("the filesystem driver rejects traversal and never overwrites a winning object", async () => {
  const root = await mkdtemp(join(tmpdir(), "wageshield-objects-"));
  const previousDriver = process.env.OBJECT_STORAGE_DRIVER;
  const previousRoot = process.env.OBJECT_STORAGE_LOCAL_DIR;
  process.env.OBJECT_STORAGE_DRIVER = "filesystem";
  process.env.OBJECT_STORAGE_LOCAL_DIR = root;
  try {
    assert.throws(() => resolveLocalObjectPath("../outside"), /Invalid private object key/);
    const storage = getPrivateObjectStorage();
    const key = "private/cases/case_test/reports/report_test/v1/report.pdf";
    await storage.put("case_test", key, new TextEncoder().encode("first"), "application/pdf");
    await assert.rejects(
      storage.put("case_test", key, new TextEncoder().encode("second"), "application/pdf"),
    );
    assert.equal(await readFile(resolveLocalObjectPath(key), "utf8"), "first");
  } finally {
    if (previousDriver === undefined) delete process.env.OBJECT_STORAGE_DRIVER;
    else process.env.OBJECT_STORAGE_DRIVER = previousDriver;
    if (previousRoot === undefined) delete process.env.OBJECT_STORAGE_LOCAL_DIR;
    else process.env.OBJECT_STORAGE_LOCAL_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("the PostgreSQL driver privately stores, streams, inventories, and deletes case-bound bytes", async () => {
  const database = new FakeObjectDatabase();
  database.cases.set("case_test", "user_test");
  const storage = new PostgresPrivateObjectStorage(database);
  const key = "private/cases/case_test/original/doc_%_/v1/source.pdf";
  const bytes = new TextEncoder().encode("postgres private evidence");

  await storage.put("case_test", key, bytes, "Application/PDF");
  assert.equal(await storage.exists(key), true);
  assert.deepEqual(await storage.list("private/cases/case_test/original/doc_%_/"), [key]);
  assert.equal(
    database.lastListPattern,
    "private/cases/case\\_test/original/doc\\_\\%\\_/%",
  );

  const object = await storage.get(key);
  assert.ok(object);
  assert.equal(object.contentType, "application/pdf");
  assert.equal(object.size, bytes.byteLength);
  assert.match(object.etag, /^"[a-f0-9]{64}"$/);
  assert.equal(
    new TextDecoder().decode(await new Response(object.body).arrayBuffer()),
    "postgres private evidence",
  );

  await assert.rejects(storage.put("case_test", key, bytes, "application/pdf"), /already exists/);
  await assert.rejects(
    storage.put("case_other", key, bytes, "application/pdf"),
    /does not belong|case identifier/,
  );

  await storage.delete(key);
  assert.equal(await storage.exists(key), false);
});

test("the PostgreSQL driver enforces global and per-account capacity before inserting", async () => {
  const previousGlobal = process.env.OBJECT_STORAGE_GLOBAL_MAX_BYTES;
  const previousAccount = process.env.OBJECT_STORAGE_ACCOUNT_MAX_BYTES;
  const database = new FakeObjectDatabase();
  database.cases.set("case_test", "user_test");
  const storage = new PostgresPrivateObjectStorage(database);
  const bytes = new TextEncoder().encode("four");
  try {
    process.env.OBJECT_STORAGE_GLOBAL_MAX_BYTES = "3";
    process.env.OBJECT_STORAGE_ACCOUNT_MAX_BYTES = "100";
    await assert.rejects(
      storage.put(
        "case_test",
        "private/cases/case_test/original/doc_global/v1/source.pdf",
        bytes,
        "application/pdf",
      ),
      (error: unknown) =>
        error instanceof PrivateObjectStorageQuotaError && error.scope === "global",
    );

    process.env.OBJECT_STORAGE_GLOBAL_MAX_BYTES = "100";
    process.env.OBJECT_STORAGE_ACCOUNT_MAX_BYTES = "3";
    await assert.rejects(
      storage.put(
        "case_test",
        "private/cases/case_test/original/doc_account/v1/source.pdf",
        bytes,
        "application/pdf",
      ),
      (error: unknown) =>
        error instanceof PrivateObjectStorageQuotaError && error.scope === "account",
    );
    assert.equal(database.objects.size, 0);
  } finally {
    if (previousGlobal === undefined) delete process.env.OBJECT_STORAGE_GLOBAL_MAX_BYTES;
    else process.env.OBJECT_STORAGE_GLOBAL_MAX_BYTES = previousGlobal;
    if (previousAccount === undefined) delete process.env.OBJECT_STORAGE_ACCOUNT_MAX_BYTES;
    else process.env.OBJECT_STORAGE_ACCOUNT_MAX_BYTES = previousAccount;
  }
});

test("the production-default PostgreSQL driver fails closed without a database URL", async () => {
  const previousDriver = process.env.OBJECT_STORAGE_DRIVER;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.OBJECT_STORAGE_DRIVER;
  delete process.env.DATABASE_URL;
  try {
    await assert.rejects(
      getPrivateObjectStorage().exists("private/cases/case_test/original/doc_test/v1/source.pdf"),
      /DATABASE_URL is required/,
    );
  } finally {
    if (previousDriver === undefined) delete process.env.OBJECT_STORAGE_DRIVER;
    else process.env.OBJECT_STORAGE_DRIVER = previousDriver;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});
