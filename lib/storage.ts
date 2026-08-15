import { env } from "cloudflare:workers";
import type {
  AuditEvent,
  CasePayload,
  CaseSummary,
  DocumentRecord,
  ReportRecord,
} from "./types";

interface Bindings {
  DB: D1Database;
  BUCKET: R2Bucket;
}

export class CaseVersionConflictError extends Error {
  constructor(
    readonly caseId: string,
    readonly expectedVersion: number,
  ) {
    super("The case changed in another request. Refresh and retry this update.");
    this.name = "CaseVersionConflictError";
  }
}

export class DeletionVerificationError extends Error {
  constructor(readonly caseId: string) {
    super("Case deletion could not be verified.");
    this.name = "DeletionVerificationError";
  }
}

export interface StoredReportManifest {
  report_id: string;
  pdf_sha256: string;
  generated_at: string;
  case_snapshot_version: number;
  rule_set_version: string;
  source_corpus_version: string;
  included_finding_ids: string[];
  redactions: string[];
  redaction_method: string;
}

export interface IdempotentResponse {
  status: number;
  body: unknown;
}

type StoredCaseRow = {
  payload_json: string;
  owner_user_id: string;
};

function bindings(): Bindings {
  const runtime = env as unknown as Partial<Bindings>;
  if (!runtime.DB) throw new Error("Database binding is unavailable");
  if (!runtime.BUCKET) throw new Error("Private object storage binding is unavailable");
  return runtime as Bindings;
}

let initialized = false;

async function tableColumns(DB: D1Database, table: string): Promise<Set<string>> {
  if (!/^[a-z_]+$/i.test(table)) throw new Error("Invalid table identifier");
  const columns = await DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return new Set(columns.results.map((column) => column.name));
}

async function migrateColumn(
  DB: D1Database,
  table: string,
  column: string,
  statement: string,
): Promise<boolean> {
  if ((await tableColumns(DB, table)).has(column)) return false;
  try {
    await DB.prepare(statement).run();
  } catch (error) {
    // Two cold isolates can observe the same legacy schema. Treat a column
    // another isolate just added as success; rethrow every other failure.
    if (!(await tableColumns(DB, table)).has(column)) throw error;
  }
  return true;
}

/**
 * Runtime initialization is deliberately migration-aware. Sites applies the
 * checked-in Drizzle migrations when hosting, while this compatibility step
 * keeps existing local Miniflare databases usable after the ownership rename.
 */
export async function ensureStorage(): Promise<void> {
  if (initialized) return;
  const { DB } = bindings();

  await DB.prepare(
    `CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      scenario TEXT NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      state_version INTEGER NOT NULL DEFAULT 1,
      worker_name TEXT NOT NULL DEFAULT '',
      employer_name TEXT NOT NULL DEFAULT '',
      review_start TEXT NOT NULL,
      review_end TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      retention_expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  ).run();

  const columnNames = await tableColumns(DB, "cases");
  if (!columnNames.has("owner_user_id") && columnNames.has("owner_session")) {
    await migrateColumn(
      DB,
      "cases",
      "owner_user_id",
      "ALTER TABLE cases RENAME COLUMN owner_session TO owner_user_id",
    );
  }
  if (
    await migrateColumn(
      DB,
      "cases",
      "state_version",
      "ALTER TABLE cases ADD COLUMN state_version INTEGER NOT NULL DEFAULT 1",
    )
  ) {
    await DB.prepare(
      `UPDATE cases SET state_version = COALESCE(
        CAST(json_extract(payload_json, '$.stateVersion') AS INTEGER), 1
      )`,
    ).run();
  }

  const statements = [
    `CREATE TABLE IF NOT EXISTS document_objects (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      object_key TEXT NOT NULL UNIQUE,
      original_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      object_key TEXT NOT NULL UNIQUE,
      sha256 TEXT NOT NULL,
      included_finding_ids_json TEXT NOT NULL,
      manifest_json TEXT NOT NULL DEFAULT '{}',
      case_snapshot_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      safe_metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS deletion_tombstones (
      case_id_hash TEXT PRIMARY KEY,
      requested_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      policy_version TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS idempotency_keys (
      owner_user_id TEXT NOT NULL,
      operation_scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      response_json TEXT,
      response_status INTEGER,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (owner_user_id, operation_scope, idempotency_key)
    )`,
    `CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS idx_cases_owner_updated ON cases(owner_user_id, updated_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_cases_retention ON cases(retention_expires_at)",
    "CREATE INDEX IF NOT EXISTS idx_documents_case ON document_objects(case_id)",
    "CREATE INDEX IF NOT EXISTS idx_reports_case ON reports(case_id)",
    "CREATE INDEX IF NOT EXISTS idx_audit_case_created ON audit_events(case_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_idempotency_expiry ON idempotency_keys(expires_at)",
    "CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email)",
    "CREATE INDEX IF NOT EXISTS idx_auth_sessions_account ON auth_sessions(account_id)",
    "CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at)",
    `CREATE TABLE IF NOT EXISTS auth_rate_limits (
      bucket TEXT PRIMARY KEY,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      window_started_at TEXT NOT NULL,
      locked_until TEXT
    )`,
  ];
  await DB.batch(statements.map((statement) => DB.prepare(statement)));
  await migrateColumn(
    DB,
    "reports",
    "manifest_json",
    "ALTER TABLE reports ADD COLUMN manifest_json TEXT NOT NULL DEFAULT '{}'",
  );
  await migrateColumn(
    DB,
    "reports",
    "case_snapshot_version",
    "ALTER TABLE reports ADD COLUMN case_snapshot_version INTEGER NOT NULL DEFAULT 1",
  );
  await DB.prepare("PRAGMA optimize").run();
  initialized = true;
}

function parseStoredCase(row: StoredCaseRow): CasePayload {
  const value = JSON.parse(row.payload_json) as CasePayload & { ownerSession?: string };
  value.ownerUserId = value.ownerUserId || row.owner_user_id;
  value.mode = value.mode ?? (value.scenario === "custom" ? "STANDARD" : "SANDBOX");
  value.reports = value.reports ?? (value.lastReport ? [value.lastReport] : []);
  delete value.ownerSession;
  return value;
}

function toSummary(caseData: CasePayload): CaseSummary {
  return {
    id: caseData.id,
    title: caseData.title,
    mode: caseData.mode,
    scenario: caseData.scenario,
    state: caseData.state,
    workerName: caseData.workerName,
    employerName: caseData.employerName,
    reviewStart: caseData.reviewStart,
    reviewEnd: caseData.reviewEnd,
    updatedAt: caseData.updatedAt,
    retentionExpiresAt: caseData.retentionExpiresAt,
    documentCount: caseData.documents.length,
    findingCount: caseData.findings.length,
  };
}

/**
 * Preserve pre-authentication work once: the legacy random browser session is
 * unguessable and must arrive in the same browser as the authenticated user.
 */
export async function claimLegacyCases(
  ownerUserId: string,
  legacyOwnerSession: string | null,
): Promise<number> {
  if (!legacyOwnerSession || legacyOwnerSession === ownerUserId) return 0;
  await ensureStorage();
  const { DB } = bindings();
  const rows = await DB.prepare(
    "SELECT payload_json, owner_user_id FROM cases WHERE owner_user_id = ?",
  )
    .bind(legacyOwnerSession)
    .all<StoredCaseRow>();
  if (!rows.results.length) return 0;

  const statements = rows.results.map((row) => {
    const caseData = parseStoredCase(row);
    caseData.ownerUserId = ownerUserId;
    return DB.prepare(
      "UPDATE cases SET owner_user_id = ?, payload_json = ? WHERE id = ? AND owner_user_id = ?",
    ).bind(ownerUserId, JSON.stringify(caseData), caseData.id, legacyOwnerSession);
  });
  const results = await DB.batch(statements);
  return results.reduce((total, result) => total + (result.meta.changes ?? 0), 0);
}

export async function createCase(caseData: CasePayload): Promise<CasePayload> {
  await ensureStorage();
  const { DB } = bindings();
  await DB.prepare(
    `INSERT INTO cases (
      id, owner_user_id, scenario, title, state, state_version, worker_name, employer_name,
      review_start, review_end, payload_json, retention_expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      caseData.id,
      caseData.ownerUserId,
      caseData.scenario,
      caseData.title,
      caseData.state,
      caseData.stateVersion,
      caseData.workerName,
      caseData.employerName,
      caseData.reviewStart,
      caseData.reviewEnd,
      JSON.stringify(caseData),
      caseData.retentionExpiresAt,
      caseData.createdAt,
      caseData.updatedAt,
    )
    .run();
  await appendAudit(caseData.id, "CASE_CREATED", {
    scenario: caseData.scenario,
    retentionHours: caseData.retentionHours,
  });
  return caseData;
}

export async function saveCase(caseData: CasePayload): Promise<CasePayload> {
  await ensureStorage();
  const { DB } = bindings();
  const expectedVersion = caseData.stateVersion;
  const nextVersion = expectedVersion + 1;
  const nextUpdatedAt = new Date().toISOString();
  const nextCase = {
    ...caseData,
    updatedAt: nextUpdatedAt,
    stateVersion: nextVersion,
  };
  const result = await DB.prepare(
    `UPDATE cases SET title = ?, state = ?, state_version = ?, worker_name = ?, employer_name = ?,
      review_start = ?, review_end = ?, payload_json = ?, retention_expires_at = ?, updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND state_version = ?`,
  )
    .bind(
      nextCase.title,
      nextCase.state,
      nextCase.stateVersion,
      nextCase.workerName,
      nextCase.employerName,
      nextCase.reviewStart,
      nextCase.reviewEnd,
      JSON.stringify(nextCase),
      nextCase.retentionExpiresAt,
      nextCase.updatedAt,
      nextCase.id,
      nextCase.ownerUserId,
      expectedVersion,
    )
    .run();
  if (!result.meta.changes) throw new CaseVersionConflictError(caseData.id, expectedVersion);
  caseData.updatedAt = nextUpdatedAt;
  caseData.stateVersion = nextVersion;
  return caseData;
}

export async function getCase(caseId: string, ownerUserId: string): Promise<CasePayload | null> {
  await ensureStorage();
  const { DB } = bindings();
  const row = await DB.prepare(
    `SELECT payload_json, owner_user_id FROM cases
      WHERE id = ? AND owner_user_id = ? AND retention_expires_at > ? LIMIT 1`,
  )
    .bind(caseId, ownerUserId, new Date().toISOString())
    .first<StoredCaseRow>();
  return row ? parseStoredCase(row) : null;
}

function encodeCaseCursor(updatedAt: string, id: string): string {
  return btoa(JSON.stringify([updatedAt, id]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function decodeCaseCursor(value: string | null): { updatedAt: string; id: string } | null {
  if (!value || !/^[A-Za-z0-9_-]{8,512}$/.test(value)) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
      Math.ceil(value.length / 4) * 4,
      "=",
    );
    const parsed = JSON.parse(atob(padded)) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T/.test(parsed[0]) ||
      !/^case_[A-Za-z0-9-]+$/.test(parsed[1])
    ) {
      return null;
    }
    return { updatedAt: parsed[0], id: parsed[1] };
  } catch {
    return null;
  }
}

export async function listCases(
  ownerUserId: string,
  options: { limit?: number; cursor?: string | null } = {},
): Promise<{ cases: CaseSummary[]; nextCursor: string | null }> {
  await ensureStorage();
  const { DB } = bindings();
  const parsedLimit = Math.trunc(options.limit ?? 25);
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(50, parsedLimit)) : 25;
  const cursor = decodeCaseCursor(options.cursor ?? null);
  const result = await DB.prepare(
    `SELECT id, updated_at, payload_json, owner_user_id FROM cases
      WHERE owner_user_id = ? AND retention_expires_at > ?
        AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND id < ?))
      ORDER BY updated_at DESC, id DESC LIMIT ?`,
  )
    .bind(
      ownerUserId,
      new Date().toISOString(),
      cursor?.updatedAt ?? null,
      cursor?.updatedAt ?? null,
      cursor?.updatedAt ?? null,
      cursor?.id ?? null,
      limit + 1,
    )
    .all<StoredCaseRow & { id: string; updated_at: string }>();
  const pageRows = result.results.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    cases: pageRows.map((row) => toSummary(parseStoredCase(row))),
    nextCursor:
      result.results.length > limit && last ? encodeCaseCursor(last.updated_at, last.id) : null,
  };
}

export async function storeDocument(
  caseData: CasePayload,
  document: DocumentRecord,
  bytes: ArrayBuffer | Uint8Array,
): Promise<void> {
  await ensureStorage();
  const { DB, BUCKET } = bindings();
  if (!document.objectKey) throw new Error("Document object key is missing");
  await BUCKET.put(document.objectKey, bytes, {
    httpMetadata: { contentType: document.contentType },
    customMetadata: {
      caseId: caseData.id,
      documentId: document.id,
      sha256: document.hash,
      synthetic: String(document.synthetic),
      retentionExpiresAt: caseData.retentionExpiresAt,
    },
  });
  const stored = await DB.prepare(
    `INSERT INTO document_objects (
      id, case_id, object_key, original_name, content_type, byte_size, sha256, created_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM cases WHERE id = ? AND owner_user_id = ?)`,
  )
    .bind(
      document.id,
      caseData.id,
      document.objectKey,
      document.name,
      document.contentType,
      document.bytes,
      document.hash,
      document.uploadedAt,
      caseData.id,
      caseData.ownerUserId,
    )
    .run();
  if (!stored.meta.changes) {
    await BUCKET.delete(document.objectKey);
    throw new Error("Document owner authorization failed");
  }
  await appendAudit(caseData.id, "DOCUMENT_STORED", {
    documentId: document.id,
    bytes: document.bytes,
    contentType: document.contentType,
  });
}

export async function getDocumentBytes(
  caseId: string,
  documentId: string,
  ownerUserId: string,
): Promise<{ object: R2ObjectBody; name: string } | null> {
  await ensureStorage();
  const { DB, BUCKET } = bindings();
  const row = await DB.prepare(
    `SELECT d.object_key, d.original_name FROM document_objects d
      INNER JOIN cases c ON c.id = d.case_id
      WHERE d.id = ? AND d.case_id = ? AND c.owner_user_id = ?
        AND c.retention_expires_at > ? LIMIT 1`,
  )
    .bind(documentId, caseId, ownerUserId, new Date().toISOString())
    .first<{ object_key: string; original_name: string }>();
  if (!row) return null;
  const object = await BUCKET.get(row.object_key);
  return object ? { object, name: row.original_name } : null;
}

export async function storeReport(
  caseData: CasePayload,
  reportId: string,
  objectKey: string,
  bytes: Uint8Array,
  sha256: string,
  includedFindingIds: string[],
  manifest: StoredReportManifest,
): Promise<void> {
  await ensureStorage();
  const { DB, BUCKET } = bindings();
  await BUCKET.put(objectKey, bytes, {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: {
      caseId: caseData.id,
      reportId,
      sha256,
      retentionExpiresAt: caseData.retentionExpiresAt,
    },
  });
  const stored = await DB.prepare(
    `INSERT INTO reports (
      id, case_id, object_key, sha256, included_finding_ids_json,
      manifest_json, case_snapshot_version, created_at
    )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM cases WHERE id = ? AND owner_user_id = ?)`,
  )
    .bind(
      reportId,
      caseData.id,
      objectKey,
      sha256,
      JSON.stringify(includedFindingIds),
      JSON.stringify(manifest),
      manifest.case_snapshot_version,
      manifest.generated_at,
      caseData.id,
      caseData.ownerUserId,
    )
    .run();
  if (!stored.meta.changes) {
    await BUCKET.delete(objectKey);
    throw new Error("Report owner authorization failed");
  }
  await appendAudit(caseData.id, "REPORT_GENERATED", {
    reportId,
    findingCount: includedFindingIds.length,
  });
}

export async function getReportBytes(
  caseId: string,
  reportId: string,
  ownerUserId: string,
): Promise<R2ObjectBody | null> {
  await ensureStorage();
  const { DB, BUCKET } = bindings();
  const row = await DB.prepare(
    `SELECT r.object_key FROM reports r INNER JOIN cases c ON c.id = r.case_id
      WHERE r.id = ? AND r.case_id = ? AND c.owner_user_id = ?
        AND c.retention_expires_at > ? LIMIT 1`,
  )
    .bind(reportId, caseId, ownerUserId, new Date().toISOString())
    .first<{ object_key: string }>();
  return row ? BUCKET.get(row.object_key) : null;
}

export async function getReportManifest(
  caseId: string,
  reportId: string,
  ownerUserId: string,
): Promise<StoredReportManifest | null> {
  await ensureStorage();
  const { DB } = bindings();
  const row = await DB.prepare(
    `SELECT r.manifest_json FROM reports r INNER JOIN cases c ON c.id = r.case_id
      WHERE r.id = ? AND r.case_id = ? AND c.owner_user_id = ?
        AND c.retention_expires_at > ? LIMIT 1`,
  )
    .bind(reportId, caseId, ownerUserId, new Date().toISOString())
    .first<{ manifest_json: string }>();
  if (!row) return null;
  try {
    const value = JSON.parse(row.manifest_json) as StoredReportManifest;
    return value.report_id ? value : null;
  } catch {
    return null;
  }
}

export async function deleteReportObject(
  caseId: string,
  reportId: string,
  ownerUserId: string,
): Promise<boolean> {
  await ensureStorage();
  const { DB, BUCKET } = bindings();
  const row = await DB.prepare(
    `SELECT r.object_key FROM reports r INNER JOIN cases c ON c.id = r.case_id
      WHERE r.id = ? AND r.case_id = ? AND c.owner_user_id = ? LIMIT 1`,
  )
    .bind(reportId, caseId, ownerUserId)
    .first<{ object_key: string }>();
  if (!row) return false;
  await BUCKET.delete(row.object_key);
  if (await BUCKET.head(row.object_key)) throw new Error("Stored report deletion was not confirmed");
  const result = await DB.prepare(
    `DELETE FROM reports WHERE id = ? AND case_id = ?
      AND EXISTS (SELECT 1 FROM cases WHERE id = ? AND owner_user_id = ?)`,
  )
    .bind(reportId, caseId, caseId, ownerUserId)
    .run();
  return Boolean(result.meta.changes);
}

export async function listReports(
  caseId: string,
  ownerUserId: string,
): Promise<ReportRecord[]> {
  await ensureStorage();
  const { DB } = bindings();
  const rows = await DB.prepare(
    `SELECT r.id, r.object_key, r.sha256, r.included_finding_ids_json,
      r.manifest_json, r.case_snapshot_version, r.created_at
      FROM reports r INNER JOIN cases c ON c.id = r.case_id
      WHERE r.case_id = ? AND c.owner_user_id = ? AND c.retention_expires_at > ?
      ORDER BY r.created_at DESC`,
  )
    .bind(caseId, ownerUserId, new Date().toISOString())
    .all<{
      id: string;
      object_key: string;
      sha256: string;
      included_finding_ids_json: string;
      manifest_json: string;
      case_snapshot_version: number;
      created_at: string;
    }>();
  return rows.results.map((row, index) => {
    let manifest: Partial<StoredReportManifest> = {};
    try {
      manifest = JSON.parse(row.manifest_json) as StoredReportManifest;
    } catch {
      // Legacy report rows did not persist a manifest.
    }
    return {
      id: row.id,
      generatedAt: manifest.generated_at ?? row.created_at,
      sha256: row.sha256,
      objectKey: row.object_key,
      caseSnapshotVersion: manifest.case_snapshot_version ?? row.case_snapshot_version,
      includedFindingIds: manifest.included_finding_ids ?? JSON.parse(row.included_finding_ids_json),
      redactions: manifest.redactions ?? [],
      status: index === 0 ? "CURRENT" : "SUPERSEDED",
    };
  });
}

export async function deleteDocumentObject(
  caseId: string,
  documentId: string,
  ownerUserId: string,
): Promise<boolean> {
  await ensureStorage();
  const { DB, BUCKET } = bindings();
  const row = await DB.prepare(
    `SELECT d.object_key FROM document_objects d INNER JOIN cases c ON c.id = d.case_id
      WHERE d.id = ? AND d.case_id = ? AND c.owner_user_id = ? LIMIT 1`,
  )
    .bind(documentId, caseId, ownerUserId)
    .first<{ object_key: string }>();
  if (!row) return false;
  await BUCKET.delete(row.object_key);
  if (await BUCKET.head(row.object_key)) throw new Error("Stored document deletion was not confirmed");
  const result = await DB.prepare(
    `DELETE FROM document_objects WHERE id = ? AND case_id = ?
      AND EXISTS (SELECT 1 FROM cases WHERE id = ? AND owner_user_id = ?)`,
  )
    .bind(documentId, caseId, caseId, ownerUserId)
    .run();
  return Boolean(result.meta.changes);
}

export async function caseStorageUsage(
  caseId: string,
  ownerUserId: string,
): Promise<{ documentCount: number; totalBytes: number }> {
  await ensureStorage();
  const { DB } = bindings();
  const row = await DB.prepare(
    `SELECT COUNT(d.id) AS document_count, COALESCE(SUM(d.byte_size), 0) AS total_bytes
      FROM cases c LEFT JOIN document_objects d ON d.case_id = c.id
      WHERE c.id = ? AND c.owner_user_id = ?`,
  )
    .bind(caseId, ownerUserId)
    .first<{ document_count: number; total_bytes: number }>();
  return { documentCount: row?.document_count ?? 0, totalBytes: row?.total_bytes ?? 0 };
}

export async function deleteCase(caseId: string, ownerUserId: string): Promise<boolean> {
  await ensureStorage();
  const { DB, BUCKET } = bindings();
  const owned = await DB.prepare(
    "SELECT id FROM cases WHERE id = ? AND owner_user_id = ? LIMIT 1",
  )
    .bind(caseId, ownerUserId)
    .first<{ id: string }>();
  if (!owned) return false;

  const requestedAt = new Date().toISOString();
  const inventoriedObjects = await DB.prepare(
    `SELECT object_key FROM document_objects WHERE case_id = ?
      UNION ALL SELECT object_key FROM reports WHERE case_id = ?`,
  )
    .bind(caseId, caseId)
    .all<{ object_key: string }>();
  const objectKeys = new Set(inventoriedObjects.results.map((row) => row.object_key));
  for (const prefix of [`private/cases/${caseId}/`, `private/demo/${caseId}/`]) {
    let cursor: string | undefined;
    do {
      const page = await BUCKET.list({ prefix, cursor, limit: 1000 });
      page.objects.forEach((object) => objectKeys.add(object.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  for (const key of objectKeys) await BUCKET.delete(key);
  for (const key of objectKeys) {
    if (await BUCKET.head(key)) throw new DeletionVerificationError(caseId);
  }

  const caseHash = await sha256(caseId);
  const completedAt = new Date().toISOString();
  await DB.batch([
    DB.prepare("DELETE FROM document_objects WHERE case_id = ?").bind(caseId),
    DB.prepare("DELETE FROM reports WHERE case_id = ?").bind(caseId),
    DB.prepare("DELETE FROM audit_events WHERE case_id = ?").bind(caseId),
    DB.prepare("DELETE FROM cases WHERE id = ? AND owner_user_id = ?").bind(
      caseId,
      ownerUserId,
    ),
    DB.prepare(
      `INSERT OR REPLACE INTO deletion_tombstones
        (case_id_hash, requested_at, completed_at, policy_version) VALUES (?, ?, ?, ?)`,
    ).bind(caseHash, requestedAt, completedAt, "deletion.v1"),
  ]);
  const remaining = await DB.prepare("SELECT id FROM cases WHERE id = ? LIMIT 1")
    .bind(caseId)
    .first<{ id: string }>();
  if (remaining) throw new DeletionVerificationError(caseId);
  return true;
}

export async function purgeExpiredCases(limit = 25): Promise<{
  deleted: number;
  failed: string[];
}> {
  await ensureStorage();
  const { DB } = bindings();
  const rows = await DB.prepare(
    `SELECT id, owner_user_id FROM cases WHERE retention_expires_at <= ?
      ORDER BY retention_expires_at ASC LIMIT ?`,
  )
    .bind(new Date().toISOString(), Math.max(1, Math.min(100, limit)))
    .all<{ id: string; owner_user_id: string }>();
  let deleted = 0;
  const failed: string[] = [];
  for (const row of rows.results) {
    try {
      if (await deleteCase(row.id, row.owner_user_id)) deleted += 1;
    } catch {
      failed.push(await sha256(row.id));
    }
  }
  return { deleted, failed };
}

function validIdempotencyKey(value: string): boolean {
  return /^[A-Za-z0-9._:-]{16,128}$/.test(value);
}

export async function reserveIdempotencyKey(
  ownerUserId: string,
  operationScope: string,
  key: string,
): Promise<"RESERVED" | "IN_PROGRESS" | IdempotentResponse> {
  if (!validIdempotencyKey(key)) throw new Error("INVALID_IDEMPOTENCY_KEY");
  await ensureStorage();
  const { DB } = bindings();
  const now = new Date();
  await DB.prepare("DELETE FROM idempotency_keys WHERE expires_at <= ?").bind(now.toISOString()).run();
  const inserted = await DB.prepare(
    `INSERT OR IGNORE INTO idempotency_keys (
      owner_user_id, operation_scope, idempotency_key, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      ownerUserId,
      operationScope,
      key,
      now.toISOString(),
      new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    )
    .run();
  if (inserted.meta.changes) return "RESERVED";
  const row = await DB.prepare(
    `SELECT response_json, response_status FROM idempotency_keys
      WHERE owner_user_id = ? AND operation_scope = ? AND idempotency_key = ? LIMIT 1`,
  )
    .bind(ownerUserId, operationScope, key)
    .first<{ response_json: string | null; response_status: number | null }>();
  if (!row?.response_json || !row.response_status) return "IN_PROGRESS";
  return { status: row.response_status, body: JSON.parse(row.response_json) as unknown };
}

export async function completeIdempotencyKey(
  ownerUserId: string,
  operationScope: string,
  key: string,
  response: IdempotentResponse,
): Promise<void> {
  await ensureStorage();
  const { DB } = bindings();
  await DB.prepare(
    `UPDATE idempotency_keys SET response_json = ?, response_status = ?
      WHERE owner_user_id = ? AND operation_scope = ? AND idempotency_key = ?`,
  )
    .bind(
      JSON.stringify(response.body),
      response.status,
      ownerUserId,
      operationScope,
      key,
    )
    .run();
}

export async function releaseIdempotencyKey(
  ownerUserId: string,
  operationScope: string,
  key: string,
): Promise<void> {
  if (!validIdempotencyKey(key)) return;
  await ensureStorage();
  const { DB } = bindings();
  await DB.prepare(
    `DELETE FROM idempotency_keys WHERE owner_user_id = ? AND operation_scope = ?
      AND idempotency_key = ? AND response_json IS NULL`,
  )
    .bind(ownerUserId, operationScope, key)
    .run();
}

export async function appendAudit(
  caseId: string,
  eventType: string,
  safeMetadata: AuditEvent["safeMetadata"],
): Promise<void> {
  await ensureStorage();
  const { DB } = bindings();
  await DB.prepare(
    `INSERT INTO audit_events (id, case_id, event_type, safe_metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      caseId,
      eventType,
      JSON.stringify(safeMetadata),
      new Date().toISOString(),
    )
    .run();
}

export async function sha256(value: string | ArrayBuffer | Uint8Array): Promise<string> {
  const source =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : value instanceof Uint8Array
        ? value
        : new Uint8Array(value);
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function storageHealthCheck(): Promise<{ database: true; objects: true }> {
  await ensureStorage();
  const { DB, BUCKET } = bindings();
  const database = await DB.prepare("SELECT 1 AS ready").first<{ ready: number }>();
  if (database?.ready !== 1) throw new Error("Database readiness probe failed");
  await BUCKET.list({ prefix: "__wageshield_health__/", limit: 1 });
  return { database: true, objects: true };
}
