import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    policyAcceptedAt: text("policy_accepted_at"),
    policyVersion: text("policy_version"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_accounts_email").on(table.email)],
);

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    index("idx_auth_sessions_account").on(table.accountId),
    index("idx_auth_sessions_expiry").on(table.expiresAt),
  ],
);

/**
 * Single-use password reset tokens. Only the SHA-256 hash of the emailed token
 * is stored, so a database read cannot be replayed into an account takeover.
 */
export const passwordResets = sqliteTable(
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

/**
 * Sign-in and sign-up throttling. Keyed by an opaque bucket string that already
 * encodes the action and either the client IP or the normalized email, so no
 * raw credential material is stored.
 */
export const authRateLimits = sqliteTable(
  "auth_rate_limits",
  {
    bucket: text("bucket").primaryKey(),
    attemptCount: integer("attempt_count").notNull().default(0),
    windowStartedAt: text("window_started_at").notNull(),
    lockedUntil: text("locked_until"),
  },
  (table) => [index("idx_auth_rate_limits_window").on(table.windowStartedAt)],
);

export const cases = sqliteTable(
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
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_cases_owner_updated").on(table.ownerUserId, table.updatedAt),
    index("idx_cases_retention").on(table.retentionExpiresAt),
  ],
);

export const documentObjects = sqliteTable(
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
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_documents_case").on(table.caseId)],
);

export const reports = sqliteTable(
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
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_reports_case").on(table.caseId)],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id").notNull(),
    eventType: text("event_type").notNull(),
    safeMetadataJson: text("safe_metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_audit_case_created").on(table.caseId, table.createdAt)],
);

export const deletionTombstones = sqliteTable("deletion_tombstones", {
  caseIdHash: text("case_id_hash").primaryKey(),
  requestedAt: text("requested_at").notNull(),
  completedAt: text("completed_at").notNull(),
  policyVersion: text("policy_version").notNull(),
});

export const idempotencyKeys = sqliteTable(
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
      columns: [
      table.ownerUserId,
      table.operationScope,
      table.idempotencyKey,
      ],
    }),
    index("idx_idempotency_expiry").on(table.expiresAt),
  ],
);
