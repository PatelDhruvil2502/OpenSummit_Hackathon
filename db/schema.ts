import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { UPLOAD_POLICY } from "../lib/product-config";

// Timestamps and serialized payloads intentionally remain text. The existing
// application uses canonical ISO-8601 UTC values and JSON strings throughout;
// keeping those representations prevents driver-specific Date/JSON coercion
// and preserves deterministic case/report hashes during the Render port.
const utcNowText = sql`to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    policyAcceptedAt: text("policy_accepted_at"),
    policyVersion: text("policy_version"),
    createdAt: text("created_at").notNull().default(utcNowText),
    updatedAt: text("updated_at").notNull().default(utcNowText),
  },
  (table) => [index("idx_accounts_email").on(table.email)],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: text("created_at").notNull().default(utcNowText),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    index("idx_auth_sessions_account").on(table.accountId),
    index("idx_auth_sessions_expiry").on(table.expiresAt),
  ],
);

/** Only a SHA-256 hash of each single-use reset token is persisted. */
export const passwordResets = pgTable(
  "password_resets",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
  },
  (table) => [
    uniqueIndex("idx_password_resets_account").on(table.accountId),
    index("idx_password_resets_expiry").on(table.expiresAt),
  ],
);

export const authRateLimits = pgTable(
  "auth_rate_limits",
  {
    bucket: text("bucket").primaryKey(),
    attemptCount: integer("attempt_count").notNull().default(0),
    windowStartedAt: text("window_started_at").notNull(),
    lockedUntil: text("locked_until"),
  },
  (table) => [index("idx_auth_rate_limits_window").on(table.windowStartedAt)],
);

export const cases = pgTable(
  "cases",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    scenario: text("scenario").notNull(),
    title: text("title").notNull(),
    state: text("state").notNull(),
    stateVersion: integer("state_version").notNull().default(1),
    workerName: text("worker_name").notNull().default(""),
    employerName: text("employer_name").notNull().default(""),
    reviewStart: text("review_start").notNull(),
    reviewEnd: text("review_end").notNull(),
    payloadJson: text("payload_json").notNull(),
    retentionExpiresAt: text("retention_expires_at").notNull(),
    createdAt: text("created_at").notNull().default(utcNowText),
    updatedAt: text("updated_at").notNull().default(utcNowText),
  },
  (table) => [
    index("idx_cases_owner_updated").on(table.ownerUserId, table.updatedAt),
    index("idx_cases_retention").on(table.retentionExpiresAt),
  ],
);

export const documentObjects = pgTable(
  "document_objects",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    objectKey: text("object_key").notNull().unique(),
    originalName: text("original_name").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: text("created_at").notNull().default(utcNowText),
  },
  (table) => [index("idx_documents_case").on(table.caseId)],
);

/**
 * Private evidence bytes live in PostgreSQL for the Render-only deployment.
 * The case FK is a final cleanup net for a process crash between storing bytes
 * and recording the corresponding document/report metadata.
 */
export const privateObjects = pgTable(
  "private_objects",
  {
    objectKey: text("object_key").primaryKey(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    body: bytea("body").notNull(),
    createdAt: text("created_at").notNull().default(utcNowText),
  },
  (table) => [
    index("idx_private_objects_case").on(table.caseId),
    check(
      "private_objects_byte_size_check",
      sql`${table.byteSize} >= 0 AND ${table.byteSize} <= ${sql.raw(String(UPLOAD_POLICY.maximumFileBytes))}`,
    ),
    check("private_objects_body_size_check", sql`octet_length(${table.body}) = ${table.byteSize}`),
    check("private_objects_sha256_check", sql`char_length(${table.sha256}) = 64`),
  ],
);

export const reports = pgTable(
  "reports",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    objectKey: text("object_key").notNull().unique(),
    sha256: text("sha256").notNull(),
    includedFindingIdsJson: text("included_finding_ids_json").notNull(),
    manifestJson: text("manifest_json").notNull().default("{}"),
    caseSnapshotVersion: integer("case_snapshot_version").notNull().default(1),
    createdAt: text("created_at").notNull().default(utcNowText),
  },
  (table) => [index("idx_reports_case").on(table.caseId)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    safeMetadataJson: text("safe_metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(utcNowText),
  },
  (table) => [index("idx_audit_case_created").on(table.caseId, table.createdAt)],
);

export const deletionTombstones = pgTable("deletion_tombstones", {
  caseIdHash: text("case_id_hash").primaryKey(),
  requestedAt: text("requested_at").notNull(),
  completedAt: text("completed_at").notNull(),
  policyVersion: text("policy_version").notNull(),
});

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    ownerUserId: text("owner_user_id").notNull(),
    operationScope: text("operation_scope").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    responseJson: text("response_json"),
    responseStatus: integer("response_status"),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.ownerUserId, table.operationScope, table.idempotencyKey],
    }),
    index("idx_idempotency_expiry").on(table.expiresAt),
  ],
);
