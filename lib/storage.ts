import {
  execute,
  query,
  queryOne,
  transaction,
} from "@/db";
import {
  getPrivateObjectStorage,
  PrivateObjectStorageQuotaError,
  type PrivateStoredObject,
} from "./object-storage";
import { API_POLICY, UPLOAD_POLICY } from "./product-config";
import type {
  AuditEvent,
  CasePayload,
  CaseSummary,
  DocumentRecord,
  ReportRecord,
} from "./types";

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

export class ActiveCaseQuotaError extends Error {
  constructor() {
    super(`An account can keep at most ${API_POLICY.maximumActiveCases} active reviews.`);
    this.name = "ActiveCaseQuotaError";
  }
}

export class CaseStorageQuotaError extends Error {
  constructor(message = "This review has reached its private document-storage limit.") {
    super(message);
    this.name = "CaseStorageQuotaError";
  }
}

export class ReportQuotaError extends Error {
  constructor() {
    super(`A review can retain at most ${API_POLICY.maximumReportsPerCase} generated reports.`);
    this.name = "ReportQuotaError";
  }
}

export class CaseDeletionPendingError extends Error {
  constructor() {
    super("This review is locked for verified deletion.");
    this.name = "CaseDeletionPendingError";
  }
}

export class AccountDeletionPendingError extends Error {
  constructor() {
    super("This account is locked for verified deletion and cannot create new reviews.");
    this.name = "AccountDeletionPendingError";
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

export type IdempotencyReference =
  | { kind: "case"; caseId: string }
  | { kind: "analysis"; caseId: string; analysisId: string }
  | { kind: "report"; caseId: string; reportId: string };

export interface IdempotentReplay {
  status: number;
  reference: IdempotencyReference;
}

type StoredCaseRow = {
  payload_json: string;
  owner_user_id: string;
};

let initialization: Promise<void> | null = null;

/**
 * Render applies the checked-in PostgreSQL migrations before starting the web
 * service. Runtime code verifies that the migrated schema and the configured
 * private object-store driver are available; it never mutates schema on a web
 * request.
 */
export async function ensureStorage(): Promise<void> {
  if (!initialization) {
    initialization = (async () => {
      const ready = await queryOne<{ cases: string | null }>(
        "SELECT to_regclass('public.cases')::text AS cases",
      );
      if (!ready?.cases) {
        throw new Error("PostgreSQL migrations have not created the application schema");
      }
      getPrivateObjectStorage();
    })().catch((error) => {
      initialization = null;
      throw error;
    });
  }
  await initialization;
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
  return transaction(async (database) => {
    const rows = await database.query<StoredCaseRow>(
      `SELECT payload_json, owner_user_id FROM cases
        WHERE owner_user_id = $1 FOR UPDATE`,
      [legacyOwnerSession],
    );
    let claimed = 0;
    for (const row of rows.rows) {
      const caseData = parseStoredCase(row);
      caseData.ownerUserId = ownerUserId;
      claimed += await database.execute(
        `UPDATE cases SET owner_user_id = $1, payload_json = $2
          WHERE id = $3 AND owner_user_id = $4`,
        [ownerUserId, JSON.stringify(caseData), caseData.id, legacyOwnerSession],
      );
    }
    return claimed;
  });
}

export async function createCase(caseData: CasePayload): Promise<CasePayload> {
  await ensureStorage();
  await transaction(async (database) => {
    await database.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      caseData.ownerUserId,
    ]);
    const deletionLock = await database.queryOne<{ locked: number }>(
      `SELECT 1 AS locked FROM idempotency_keys
        WHERE owner_user_id = $1 AND operation_scope = 'account:deletion' LIMIT 1`,
      [caseData.ownerUserId],
    );
    if (deletionLock) throw new AccountDeletionPendingError();
    const active = await database.queryOne<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM cases
        WHERE owner_user_id = $1 AND retention_expires_at > $2`,
      [caseData.ownerUserId, new Date().toISOString()],
    );
    if (Number(active?.count ?? 0) >= API_POLICY.maximumActiveCases) {
      throw new ActiveCaseQuotaError();
    }
    await database.execute(
      `INSERT INTO cases (
        id, owner_user_id, scenario, title, state, state_version, worker_name, employer_name,
        review_start, review_end, payload_json, retention_expires_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
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
      ],
    );
  });
  await appendAudit(caseData.id, "CASE_CREATED", {
    scenario: caseData.scenario,
    retentionHours: caseData.retentionHours,
  });
  return caseData;
}

export async function saveCase(caseData: CasePayload): Promise<CasePayload> {
  await ensureStorage();
  const expectedVersion = caseData.stateVersion;
  const nextVersion = expectedVersion + 1;
  const nextUpdatedAt = new Date().toISOString();
  const nextCase = {
    ...caseData,
    updatedAt: nextUpdatedAt,
    stateVersion: nextVersion,
  };
  const changed = await execute(
    `UPDATE cases SET title = $1, state = $2, state_version = $3, worker_name = $4,
      employer_name = $5, review_start = $6, review_end = $7, payload_json = $8,
      retention_expires_at = $9, updated_at = $10
      WHERE id = $11 AND owner_user_id = $12 AND state_version = $13
        AND state != 'DELETION_PENDING'`,
    [
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
    ],
  );
  if (!changed) throw new CaseVersionConflictError(caseData.id, expectedVersion);
  caseData.updatedAt = nextUpdatedAt;
  caseData.stateVersion = nextVersion;
  return caseData;
}

export async function getCase(caseId: string, ownerUserId: string): Promise<CasePayload | null> {
  await ensureStorage();
  const row = await queryOne<StoredCaseRow>(
    `SELECT payload_json, owner_user_id FROM cases
      WHERE id = $1 AND owner_user_id = $2 AND retention_expires_at > $3 LIMIT 1`,
    [caseId, ownerUserId, new Date().toISOString()],
  );
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
  const parsedLimit = Math.trunc(options.limit ?? API_POLICY.defaultCasePageSize);
  const limit = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(API_POLICY.maximumCasePageSize, parsedLimit))
    : API_POLICY.defaultCasePageSize;
  const cursor = decodeCaseCursor(options.cursor ?? null);
  const result = await query<StoredCaseRow & { id: string; updated_at: string }>(
    `SELECT id, updated_at, payload_json, owner_user_id FROM cases
      WHERE owner_user_id = $1 AND retention_expires_at > $2
        AND ($3::text IS NULL OR updated_at < $3 OR (updated_at = $3 AND id < $4))
      ORDER BY updated_at DESC, id DESC LIMIT $5`,
    [
      ownerUserId,
      new Date().toISOString(),
      cursor?.updatedAt ?? null,
      cursor?.id ?? null,
      limit + 1,
    ],
  );
  const pageRows = result.rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    cases: pageRows.map((row) => toSummary(parseStoredCase(row))),
    nextCursor:
      result.rows.length > limit && last ? encodeCaseCursor(last.updated_at, last.id) : null,
  };
}

export async function countActiveCases(ownerUserId: string): Promise<number> {
  await ensureStorage();
  const row = await queryOne<{ count: string | number }>(
    "SELECT COUNT(*) AS count FROM cases WHERE owner_user_id = $1 AND retention_expires_at > $2",
    [ownerUserId, new Date().toISOString()],
  );
  return Number(row?.count ?? 0);
}

export async function listOwnedCases(ownerUserId: string): Promise<CasePayload[]> {
  await ensureStorage();
  const rows = await query<StoredCaseRow>(
    `SELECT payload_json, owner_user_id FROM cases
      WHERE owner_user_id = $1 AND retention_expires_at > $2
      ORDER BY created_at ASC, id ASC`,
    [ownerUserId, new Date().toISOString()],
  );
  return rows.rows.map(parseStoredCase);
}

export async function listOwnedCaseIds(ownerUserId: string): Promise<string[]> {
  await ensureStorage();
  const rows = await query<{ id: string }>(
    "SELECT id FROM cases WHERE owner_user_id = $1 ORDER BY created_at ASC, id ASC",
    [ownerUserId],
  );
  return rows.rows.map((row) => row.id);
}

export async function lockAccountDeletion(ownerUserId: string): Promise<void> {
  await ensureStorage();
  const now = new Date().toISOString();
  await transaction(async (database) => {
    // Serialize with createCase so an account cannot gain a new review after
    // its permanent-deletion inventory has begun.
    await database.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [ownerUserId]);
    await database.execute(
      `INSERT INTO idempotency_keys (
        owner_user_id, operation_scope, idempotency_key,
        response_json, response_status, created_at, expires_at
      ) VALUES ($1, 'account:deletion', 'permanent-delete-lock', NULL, NULL, $2,
        '9999-12-31T23:59:59.999Z')
      ON CONFLICT (owner_user_id, operation_scope, idempotency_key) DO NOTHING`,
      [ownerUserId, now],
    );
  });
}

async function cleanupRejectedObject(
  objects: ReturnType<typeof getPrivateObjectStorage>,
  objectKey: string,
  operationError: unknown,
): Promise<never> {
  try {
    await objects.delete(objectKey);
    if (await objects.exists(objectKey)) {
      throw new Error("Rejected private object deletion was not confirmed");
    }
  } catch (cleanupError) {
    throw new AggregateError(
      [operationError, cleanupError],
      "The database operation failed and private-object cleanup could not be verified",
    );
  }
  throw operationError;
}

async function putCaseObject(
  objects: ReturnType<typeof getPrivateObjectStorage>,
  caseId: string,
  objectKey: string,
  bytes: ArrayBuffer | Uint8Array,
  contentType: string,
): Promise<void> {
  try {
    await objects.put(caseId, objectKey, bytes, contentType);
  } catch (error) {
    if (error instanceof PrivateObjectStorageQuotaError) {
      throw new CaseStorageQuotaError(
        "Private storage capacity is unavailable for additional files. Remove unneeded evidence or contact support.",
      );
    }
    throw error;
  }
}

export async function storeDocument(
  caseData: CasePayload,
  document: DocumentRecord,
  bytes: ArrayBuffer | Uint8Array,
): Promise<void> {
  await ensureStorage();
  const objects = getPrivateObjectStorage();
  if (!document.objectKey) throw new Error("Document object key is missing");
  await putCaseObject(objects, caseData.id, document.objectKey, bytes, document.contentType);
  try {
    await transaction(async (database) => {
      const owned = await database.queryOne<{ state: string }>(
        `SELECT state FROM cases WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
        [caseData.id, caseData.ownerUserId],
      );
      if (!owned) throw new Error("Document owner authorization failed");
      if (owned.state === "DELETION_PENDING") throw new CaseDeletionPendingError();
      const usage = await database.queryOne<{
        document_count: string | number;
        total_bytes: string | number;
      }>(
        `SELECT COUNT(*) AS document_count, COALESCE(SUM(byte_size), 0) AS total_bytes
          FROM document_objects WHERE case_id = $1`,
        [caseData.id],
      );
      if (
        Number(usage?.document_count ?? 0) >= UPLOAD_POLICY.maximumCaseDocuments ||
        Number(usage?.total_bytes ?? 0) + document.bytes > UPLOAD_POLICY.maximumCaseBytes
      ) {
        throw new CaseStorageQuotaError();
      }
      await database.execute(
        `INSERT INTO document_objects (
          id, case_id, object_key, original_name, content_type, byte_size, sha256, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          document.id,
          caseData.id,
          document.objectKey,
          document.name,
          document.contentType,
          document.bytes,
          document.hash,
          document.uploadedAt,
        ],
      );
    });
  } catch (error) {
    await cleanupRejectedObject(objects, document.objectKey, error);
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
): Promise<{ object: PrivateStoredObject; name: string } | null> {
  await ensureStorage();
  const row = await queryOne<{
    object_key: string;
    original_name: string;
    content_type: string;
    sha256: string;
  }>(
    `SELECT d.object_key, d.original_name, d.content_type, d.sha256 FROM document_objects d
      INNER JOIN cases c ON c.id = d.case_id
      WHERE d.id = $1 AND d.case_id = $2 AND c.owner_user_id = $3
        AND c.retention_expires_at > $4 LIMIT 1`,
    [documentId, caseId, ownerUserId, new Date().toISOString()],
  );
  if (!row) return null;
  const object = await getPrivateObjectStorage().get(row.object_key);
  if (object) {
    object.contentType = row.content_type;
    object.etag = `"${row.sha256}"`;
  }
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
  const objects = getPrivateObjectStorage();
  await putCaseObject(objects, caseData.id, objectKey, bytes, "application/pdf");
  try {
    await transaction(async (database) => {
      const owned = await database.queryOne<{ state: string }>(
        `SELECT state FROM cases WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
        [caseData.id, caseData.ownerUserId],
      );
      if (!owned) throw new Error("Report owner authorization failed");
      if (owned.state === "DELETION_PENDING") throw new CaseDeletionPendingError();
      const reportCount = await database.queryOne<{ count: string | number }>(
        "SELECT COUNT(*) AS count FROM reports WHERE case_id = $1",
        [caseData.id],
      );
      if (Number(reportCount?.count ?? 0) >= API_POLICY.maximumReportsPerCase) {
        throw new ReportQuotaError();
      }
      await database.execute(
        `INSERT INTO reports (
          id, case_id, object_key, sha256, included_finding_ids_json,
          manifest_json, case_snapshot_version, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          reportId,
          caseData.id,
          objectKey,
          sha256,
          JSON.stringify(includedFindingIds),
          JSON.stringify(manifest),
          manifest.case_snapshot_version,
          manifest.generated_at,
        ],
      );
    });
  } catch (error) {
    await cleanupRejectedObject(objects, objectKey, error);
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
): Promise<PrivateStoredObject | null> {
  await ensureStorage();
  const row = await queryOne<{ object_key: string; sha256: string }>(
    `SELECT r.object_key, r.sha256 FROM reports r INNER JOIN cases c ON c.id = r.case_id
      WHERE r.id = $1 AND r.case_id = $2 AND c.owner_user_id = $3
        AND c.retention_expires_at > $4 LIMIT 1`,
    [reportId, caseId, ownerUserId, new Date().toISOString()],
  );
  if (!row) return null;
  const object = await getPrivateObjectStorage().get(row.object_key);
  if (object) {
    object.contentType = "application/pdf";
    object.etag = `"${row.sha256}"`;
  }
  return object;
}

export async function getReportManifest(
  caseId: string,
  reportId: string,
  ownerUserId: string,
): Promise<StoredReportManifest | null> {
  await ensureStorage();
  const row = await queryOne<{ manifest_json: string }>(
    `SELECT r.manifest_json FROM reports r INNER JOIN cases c ON c.id = r.case_id
      WHERE r.id = $1 AND r.case_id = $2 AND c.owner_user_id = $3
        AND c.retention_expires_at > $4 LIMIT 1`,
    [reportId, caseId, ownerUserId, new Date().toISOString()],
  );
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
  const row = await queryOne<{ object_key: string }>(
    `SELECT r.object_key FROM reports r INNER JOIN cases c ON c.id = r.case_id
      WHERE r.id = $1 AND r.case_id = $2 AND c.owner_user_id = $3 LIMIT 1`,
    [reportId, caseId, ownerUserId],
  );
  if (!row) return false;
  const objects = getPrivateObjectStorage();
  await objects.delete(row.object_key);
  if (await objects.exists(row.object_key)) {
    throw new Error("Stored report deletion was not confirmed");
  }
  const changed = await execute(
    `DELETE FROM reports WHERE id = $1 AND case_id = $2
      AND EXISTS (SELECT 1 FROM cases WHERE id = $3 AND owner_user_id = $4)`,
    [reportId, caseId, caseId, ownerUserId],
  );
  return Boolean(changed);
}

export async function listReports(
  caseId: string,
  ownerUserId: string,
  snapshotReports?: ReadonlyArray<ReportRecord>,
): Promise<ReportRecord[]> {
  await ensureStorage();
  const rows = await query<{
    id: string;
    object_key: string;
    sha256: string;
    included_finding_ids_json: string;
    manifest_json: string;
    case_snapshot_version: number;
    created_at: string;
  }>(
    `SELECT r.id, r.object_key, r.sha256, r.included_finding_ids_json,
      r.manifest_json, r.case_snapshot_version, r.created_at
      FROM reports r INNER JOIN cases c ON c.id = r.case_id
      WHERE r.case_id = $1 AND c.owner_user_id = $2 AND c.retention_expires_at > $3
      ORDER BY r.created_at DESC`,
    [caseId, ownerUserId, new Date().toISOString()],
  );
  const snapshotStatus = snapshotReports
    ? new Map(snapshotReports.map((report) => [report.id, report.status]))
    : null;
  return rows.rows.map((row, index) => {
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
      status: snapshotStatus
        ? (snapshotStatus.get(row.id) ?? "SUPERSEDED")
        : index === 0
          ? "CURRENT"
          : "SUPERSEDED",
    };
  });
}

export async function deleteDocumentObject(
  caseId: string,
  documentId: string,
  ownerUserId: string,
): Promise<boolean> {
  await ensureStorage();
  const row = await queryOne<{ object_key: string }>(
    `SELECT d.object_key FROM document_objects d INNER JOIN cases c ON c.id = d.case_id
      WHERE d.id = $1 AND d.case_id = $2 AND c.owner_user_id = $3 LIMIT 1`,
    [documentId, caseId, ownerUserId],
  );
  if (!row) return false;
  const objects = getPrivateObjectStorage();
  await objects.delete(row.object_key);
  if (await objects.exists(row.object_key)) {
    throw new Error("Stored document deletion was not confirmed");
  }
  const changed = await execute(
    `DELETE FROM document_objects WHERE id = $1 AND case_id = $2
      AND EXISTS (SELECT 1 FROM cases WHERE id = $3 AND owner_user_id = $4)`,
    [documentId, caseId, caseId, ownerUserId],
  );
  return Boolean(changed);
}

export async function caseStorageUsage(
  caseId: string,
  ownerUserId: string,
): Promise<{ documentCount: number; totalBytes: number }> {
  await ensureStorage();
  const row = await queryOne<{
    document_count: string | number;
    total_bytes: string | number;
  }>(
    `SELECT COUNT(d.id) AS document_count, COALESCE(SUM(d.byte_size), 0) AS total_bytes
      FROM cases c LEFT JOIN document_objects d ON d.case_id = c.id
      WHERE c.id = $1 AND c.owner_user_id = $2`,
    [caseId, ownerUserId],
  );
  return {
    documentCount: Number(row?.document_count ?? 0),
    totalBytes: Number(row?.total_bytes ?? 0),
  };
}

async function inventoryCaseObjects(caseId: string): Promise<Set<string>> {
  const rows = await query<{ object_key: string }>(
    `SELECT object_key FROM document_objects WHERE case_id = $1
      UNION ALL SELECT object_key FROM reports WHERE case_id = $1`,
    [caseId],
  );
  const keys = new Set(rows.rows.map((row) => row.object_key));
  const objects = getPrivateObjectStorage();
  for (const prefix of [`private/cases/${caseId}/`, `private/demo/${caseId}/`]) {
    for (const key of await objects.list(prefix)) keys.add(key);
  }
  return keys;
}

async function deleteAndVerifyObjects(keys: Iterable<string>, caseId: string): Promise<void> {
  const objects = getPrivateObjectStorage();
  const unique = [...new Set(keys)];
  for (const key of unique) await objects.delete(key);
  for (const key of unique) {
    if (await objects.exists(key)) throw new DeletionVerificationError(caseId);
  }
}

export async function deleteCase(caseId: string, ownerUserId: string): Promise<boolean> {
  await ensureStorage();
  const requestedAt = new Date().toISOString();
  const locked = await transaction(async (database) => {
    const row = await database.queryOne<StoredCaseRow & { state_version: number }>(
      `SELECT payload_json, owner_user_id, state_version FROM cases
        WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [caseId, ownerUserId],
    );
    if (!row) return false;
    const caseData = parseStoredCase(row);
    caseData.state = "DELETION_PENDING";
    caseData.stateVersion = Number(row.state_version) + 1;
    caseData.updatedAt = requestedAt;
    await database.execute(
      `UPDATE cases SET state = 'DELETION_PENDING', state_version = $1,
        payload_json = $2, updated_at = $3
        WHERE id = $4 AND owner_user_id = $5`,
      [caseData.stateVersion, JSON.stringify(caseData), requestedAt, caseId, ownerUserId],
    );
    return true;
  });
  if (!locked) return false;

  const objectKeys = await inventoryCaseObjects(caseId);
  await deleteAndVerifyObjects(objectKeys, caseId);

  const caseHash = await sha256(caseId);
  const completedAt = new Date().toISOString();
  await transaction(async (database) => {
    await database.execute("DELETE FROM document_objects WHERE case_id = $1", [caseId]);
    await database.execute("DELETE FROM reports WHERE case_id = $1", [caseId]);
    await database.execute("DELETE FROM audit_events WHERE case_id = $1", [caseId]);
    await database.execute(
      `DELETE FROM idempotency_keys
        WHERE owner_user_id = $1 AND operation_scope != 'account:deletion'
          AND (
            operation_scope LIKE $2
            OR (response_json IS NOT NULL AND (response_json::jsonb)->>'caseId' = $3)
            OR (response_json IS NOT NULL AND (response_json::jsonb)#>>'{case,id}' = $3)
          )`,
      [ownerUserId, `cases:${caseId}:%`, caseId],
    );
    await database.execute("DELETE FROM cases WHERE id = $1 AND owner_user_id = $2", [
      caseId,
      ownerUserId,
    ]);
    await database.execute(
      `INSERT INTO deletion_tombstones
        (case_id_hash, requested_at, completed_at, policy_version) VALUES ($1, $2, $3, $4)
        ON CONFLICT (case_id_hash) DO UPDATE SET
          requested_at = EXCLUDED.requested_at,
          completed_at = EXCLUDED.completed_at,
          policy_version = EXCLUDED.policy_version`,
      [caseHash, requestedAt, completedAt, "deletion.v1"],
    );
  });
  const remaining = await queryOne<{ id: string }>(
    "SELECT id FROM cases WHERE id = $1 LIMIT 1",
    [caseId],
  );
  if (remaining) throw new DeletionVerificationError(caseId);

  // Catch an object write that began before the lock but became visible after
  // the first inventory. Object writers also re-check the locked case state
  // and clean their own object when their atomic DB insert is refused.
  const objects = getPrivateObjectStorage();
  const lateObjects = new Set<string>();
  for (const prefix of [`private/cases/${caseId}/`, `private/demo/${caseId}/`]) {
    for (const key of await objects.list(prefix)) lateObjects.add(key);
  }
  await deleteAndVerifyObjects(lateObjects, caseId);
  return true;
}

export async function purgeExpiredCases(limit = 25): Promise<{
  deleted: number;
  failed: string[];
}> {
  await ensureStorage();
  const rows = await query<{ id: string; owner_user_id: string }>(
    `SELECT id, owner_user_id FROM cases WHERE retention_expires_at <= $1
      ORDER BY retention_expires_at ASC LIMIT $2`,
    [new Date().toISOString(), Math.max(1, Math.min(100, limit))],
  );
  let deleted = 0;
  const failed: string[] = [];
  for (const row of rows.rows) {
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

function validResourceId(value: unknown, prefix: string): value is string {
  return typeof value === "string" && value.startsWith(prefix) && value.length <= 128;
}

function parseIdempotencyReference(value: string): IdempotencyReference | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || !validResourceId(parsed.caseId, "case_")) {
      return null;
    }
    if (parsed.kind === "case") return { kind: "case", caseId: parsed.caseId };
    if (parsed.kind === "analysis" && validResourceId(parsed.analysisId, "analysis_")) {
      return { kind: "analysis", caseId: parsed.caseId, analysisId: parsed.analysisId };
    }
    if (parsed.kind === "report" && validResourceId(parsed.reportId, "report_")) {
      return { kind: "report", caseId: parsed.caseId, reportId: parsed.reportId };
    }
    return null;
  } catch {
    return null;
  }
}

export async function purgeExpiredIdempotencyKeys(): Promise<number> {
  await ensureStorage();
  return execute("DELETE FROM idempotency_keys WHERE expires_at <= $1", [
    new Date().toISOString(),
  ]);
}

export async function reserveIdempotencyKey(
  ownerUserId: string,
  operationScope: string,
  key: string,
): Promise<"RESERVED" | "IN_PROGRESS" | IdempotentReplay> {
  if (!validIdempotencyKey(key)) throw new Error("INVALID_IDEMPOTENCY_KEY");
  await ensureStorage();
  const now = new Date();
  await execute("DELETE FROM idempotency_keys WHERE expires_at <= $1", [now.toISOString()]);
  const inserted = await execute(
    `INSERT INTO idempotency_keys (
      owner_user_id, operation_scope, idempotency_key, created_at, expires_at
    ) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (owner_user_id, operation_scope, idempotency_key) DO NOTHING`,
    [
      ownerUserId,
      operationScope,
      key,
      now.toISOString(),
      new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    ],
  );
  if (inserted) return "RESERVED";
  const row = await queryOne<{ response_json: string | null; response_status: number | null }>(
    `SELECT response_json, response_status FROM idempotency_keys
      WHERE owner_user_id = $1 AND operation_scope = $2 AND idempotency_key = $3 LIMIT 1`,
    [ownerUserId, operationScope, key],
  );
  if (!row?.response_json || !row.response_status) return "IN_PROGRESS";
  const reference = parseIdempotencyReference(row.response_json);
  return reference ? { status: row.response_status, reference } : "IN_PROGRESS";
}

export async function completeIdempotencyKey(
  ownerUserId: string,
  operationScope: string,
  key: string,
  replay: IdempotentReplay,
): Promise<void> {
  await ensureStorage();
  await execute(
    `UPDATE idempotency_keys SET response_json = $1, response_status = $2
      WHERE owner_user_id = $3 AND operation_scope = $4 AND idempotency_key = $5`,
    [
      JSON.stringify(replay.reference),
      replay.status,
      ownerUserId,
      operationScope,
      key,
    ],
  );
}

export async function releaseIdempotencyKey(
  ownerUserId: string,
  operationScope: string,
  key: string,
): Promise<void> {
  if (!validIdempotencyKey(key)) return;
  await ensureStorage();
  await execute(
    `DELETE FROM idempotency_keys WHERE owner_user_id = $1 AND operation_scope = $2
      AND idempotency_key = $3 AND response_json IS NULL`,
    [ownerUserId, operationScope, key],
  );
}

export async function appendAudit(
  caseId: string,
  eventType: string,
  safeMetadata: AuditEvent["safeMetadata"],
): Promise<void> {
  await ensureStorage();
  const now = new Date().toISOString();
  try {
    await transaction(async (database) => {
      const inserted = await database.execute(
        `INSERT INTO audit_events (id, case_id, event_type, safe_metadata_json, created_at)
          SELECT $1, c.id, $3, $4, $5 FROM cases c
          WHERE c.id = $2 AND c.state != 'DELETION_PENDING'`,
        [crypto.randomUUID(), caseId, eventType, JSON.stringify(safeMetadata), now],
      );
      if (!inserted) return;
      await database.execute(
        `DELETE FROM audit_events
          WHERE case_id = $1 AND id NOT IN (
            SELECT id FROM audit_events WHERE case_id = $1
            ORDER BY created_at DESC, id DESC LIMIT $2
          )`,
        [caseId, API_POLICY.maximumAuditEventsPerCase],
      );
    });
  } catch (error) {
    // A concurrent case deletion can win between the existence check and the
    // FK insert. The deletion is authoritative; a late audit event must never
    // recreate case-scoped state or turn a successful deletion into an error.
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "23503"
    ) {
      return;
    }
    throw error;
  }
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
  const database = await queryOne<{ ready: number }>("SELECT 1 AS ready");
  if (database?.ready !== 1) throw new Error("Database readiness probe failed");
  await getPrivateObjectStorage().list("__wageshield_health__/");
  return { database: true, objects: true };
}
