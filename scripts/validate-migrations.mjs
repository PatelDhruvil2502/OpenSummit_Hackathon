import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const drizzleDirectory = join(projectRoot, "drizzle");
const metadataDirectory = join(drizzleDirectory, "meta");
const journal = JSON.parse(readFileSync(join(metadataDirectory, "_journal.json"), "utf8"));

assert.equal(journal.dialect, "sqlite", "The Drizzle journal must target SQLite/D1");
assert.ok(journal.entries.length > 0, "The Drizzle journal is empty");

const migrations = journal.entries.map((entry, index) => {
  assert.equal(entry.idx, index, `Migration journal index ${entry.idx} is out of sequence`);
  assert.match(entry.tag, /^\d{4}_[a-z0-9_]+$/, `Unsafe migration tag: ${entry.tag}`);

  const sqlFile = `${entry.tag}.sql`;
  const snapshotFile = `${entry.tag.slice(0, 4)}_snapshot.json`;
  assert.ok(
    readdirSync(metadataDirectory).includes(snapshotFile),
    `Missing Drizzle snapshot ${snapshotFile}`,
  );

  return {
    entry,
    file: sqlFile,
    sql: readFileSync(join(drizzleDirectory, sqlFile), "utf8"),
  };
});

const journaledSqlFiles = migrations.map(({ file }) => file).sort();
const checkedInSqlFiles = readdirSync(drizzleDirectory)
  .filter((file) => file.endsWith(".sql"))
  .sort();
assert.deepEqual(
  checkedInSqlFiles,
  journaledSqlFiles,
  "Every checked-in migration must appear exactly once in the Drizzle journal",
);

function statements(sql) {
  return sql
    .split(/-->\s*statement-breakpoint/g)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function newDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

function applyMigration(database, migration) {
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const statement of statements(migration.sql)) database.exec(statement);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw new Error(`Migration ${migration.entry.tag} failed: ${error.message}`, {
      cause: error,
    });
  }
}

function applyMigrations(database, selectedMigrations) {
  for (const migration of selectedMigrations) applyMigration(database, migration);
}

const expectedColumns = {
  accounts: [
    "id",
    "email",
    "display_name",
    "password_hash",
    "created_at",
    "updated_at",
    "policy_accepted_at",
    "policy_version",
  ],
  audit_events: ["id", "case_id", "event_type", "safe_metadata_json", "created_at"],
  auth_rate_limits: ["bucket", "attempt_count", "window_started_at", "locked_until"],
  auth_sessions: ["id", "account_id", "token_hash", "created_at", "expires_at"],
  cases: [
    "id",
    "owner_user_id",
    "scenario",
    "title",
    "state",
    "worker_name",
    "employer_name",
    "review_start",
    "review_end",
    "payload_json",
    "retention_expires_at",
    "created_at",
    "updated_at",
    "state_version",
  ],
  deletion_tombstones: ["case_id_hash", "requested_at", "completed_at", "policy_version"],
  document_objects: [
    "id",
    "case_id",
    "object_key",
    "original_name",
    "content_type",
    "byte_size",
    "sha256",
    "created_at",
  ],
  idempotency_keys: [
    "owner_user_id",
    "operation_scope",
    "idempotency_key",
    "response_json",
    "response_status",
    "created_at",
    "expires_at",
  ],
  password_resets: [
    "id",
    "account_id",
    "token_hash",
    "created_at",
    "expires_at",
    "used_at",
  ],
  reports: [
    "id",
    "case_id",
    "object_key",
    "sha256",
    "included_finding_ids_json",
    "created_at",
    "manifest_json",
    "case_snapshot_version",
  ],
};

const expectedIndexes = [
  "accounts_email_unique",
  "auth_sessions_token_hash_unique",
  "document_objects_object_key_unique",
  "idx_accounts_email",
  "idx_audit_case_created",
  "idx_auth_rate_limits_window",
  "idx_auth_sessions_account",
  "idx_auth_sessions_expiry",
  "idx_cases_owner_updated",
  "idx_cases_retention",
  "idx_documents_case",
  "idx_idempotency_expiry",
  "idx_password_resets_account",
  "idx_password_resets_expiry",
  "idx_reports_case",
  "password_resets_token_hash_unique",
  "reports_object_key_unique",
];

function assertCurrentSchema(database, label) {
  const actualTables = database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map(({ name }) => name);
  assert.deepEqual(actualTables, Object.keys(expectedColumns).sort(), `${label}: table set drifted`);

  for (const [table, columns] of Object.entries(expectedColumns)) {
    const actualColumns = database.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => name);
    assert.deepEqual(actualColumns, columns, `${label}: ${table} columns drifted`);
  }

  const actualIndexes = database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map(({ name }) => name);
  assert.deepEqual(actualIndexes, expectedIndexes, `${label}: index set drifted`);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), [], `${label}: FK failure`);
}

// A brand-new D1 database must accept the entire append-only migration chain.
const fresh = newDatabase();
applyMigrations(fresh, migrations);
assertCurrentSchema(fresh, "fresh database");
fresh.close();

// Reproduce a deployed database that stopped at the last pre-recovery migration,
// retain representative rows, and prove the append-only upgrades preserve them.
const legacyBoundary = migrations.findIndex(
  ({ entry }) => entry.tag === "0005_auth_rate_limits",
);
assert.notEqual(legacyBoundary, -1, "Legacy upgrade boundary 0005_auth_rate_limits is missing");

const upgraded = newDatabase();
applyMigrations(upgraded, migrations.slice(0, legacyBoundary + 1));

const createdAt = "2026-08-16T12:00:00.000Z";
upgraded.prepare(
  `INSERT INTO accounts (id, email, display_name, password_hash, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?)`,
).run("user_upgrade", "upgrade@example.test", "Upgrade Test", "not-a-real-hash", createdAt, createdAt);
upgraded.prepare(
  `INSERT INTO auth_sessions (id, account_id, token_hash, created_at, expires_at)
   VALUES (?, ?, ?, ?, ?)`,
).run("session_upgrade", "user_upgrade", "session-hash", createdAt, "2026-08-17T12:00:00.000Z");
upgraded.prepare(
  `INSERT INTO cases (
     id, owner_user_id, scenario, title, state, state_version, worker_name, employer_name,
     review_start, review_end, payload_json, retention_expires_at, created_at, updated_at
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  "case_upgrade",
  "user_upgrade",
  "custom",
  "Migration preservation test",
  "DRAFT",
  3,
  "Synthetic Worker",
  "Synthetic Employer",
  "2026-01-01",
  "2026-01-31",
  '{"stateVersion":3}',
  "2026-08-17T12:00:00.000Z",
  createdAt,
  createdAt,
);
upgraded.prepare(
  `INSERT INTO document_objects
   (id, case_id, object_key, original_name, content_type, byte_size, sha256, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  "document_upgrade",
  "case_upgrade",
  "cases/case_upgrade/document.pdf",
  "synthetic.pdf",
  "application/pdf",
  128,
  "document-sha",
  createdAt,
);
upgraded.prepare(
  `INSERT INTO reports
   (id, case_id, object_key, sha256, included_finding_ids_json, manifest_json,
    case_snapshot_version, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  "report_upgrade",
  "case_upgrade",
  "cases/case_upgrade/report.pdf",
  "report-sha",
  "[]",
  "{}",
  3,
  createdAt,
);
upgraded.prepare(
  `INSERT INTO idempotency_keys
   (owner_user_id, operation_scope, idempotency_key, response_json, response_status, created_at, expires_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
).run(
  "user_upgrade",
  "cases:create",
  "migration-upgrade-key",
  '{"kind":"case","caseId":"case_upgrade"}',
  201,
  createdAt,
  "2026-08-17T12:00:00.000Z",
);
upgraded.prepare(
  `INSERT INTO auth_rate_limits (bucket, attempt_count, window_started_at, locked_until)
   VALUES (?, ?, ?, ?)`,
).run("rl_upgrade", 2, createdAt, null);

applyMigrations(upgraded, migrations.slice(legacyBoundary + 1));
assertCurrentSchema(upgraded, "upgraded database");

assert.equal(
  upgraded.prepare("SELECT COUNT(*) AS count FROM accounts WHERE id = ?").get("user_upgrade").count,
  1,
  "Account row was lost during upgrade",
);
assert.equal(
  upgraded.prepare("SELECT COUNT(*) AS count FROM cases WHERE id = ?").get("case_upgrade").count,
  1,
  "Case row was lost during upgrade",
);
assert.equal(
  upgraded.prepare("SELECT COUNT(*) AS count FROM document_objects WHERE id = ?").get("document_upgrade").count,
  1,
  "Document inventory was lost during upgrade",
);
assert.equal(
  upgraded.prepare("SELECT COUNT(*) AS count FROM reports WHERE id = ?").get("report_upgrade").count,
  1,
  "Report inventory was lost during upgrade",
);
const consent = upgraded
  .prepare("SELECT policy_accepted_at, policy_version FROM accounts WHERE id = ?")
  .get("user_upgrade");
assert.deepEqual(
  { ...consent },
  { policy_accepted_at: null, policy_version: null },
  "Existing accounts must upgrade without fabricated policy consent",
);

upgraded.prepare(
  `INSERT INTO password_resets (id, account_id, token_hash, created_at, expires_at, used_at)
   VALUES (?, ?, ?, ?, ?, NULL)`,
).run(
  "reset_upgrade",
  "user_upgrade",
  "reset-hash",
  createdAt,
  "2026-08-16T12:30:00.000Z",
);
assert.equal(
  upgraded.prepare("SELECT COUNT(*) AS count FROM password_resets").get().count,
  1,
  "Password-reset table is not writable after upgrade",
);
assert.deepEqual(upgraded.prepare("PRAGMA foreign_key_check").all(), [], "Upgrade introduced FK errors");
upgraded.close();

console.log(
  `Validated ${migrations.length} append-only migrations on fresh and 0000-0005 upgrade paths.`,
);
