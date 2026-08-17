import { closePool } from "../db/index";
import { purgeExpiredSessions } from "../lib/accounts";
import {
  purgeExpiredCases,
  purgeExpiredIdempotencyKeys,
} from "../lib/storage";

async function sweep(): Promise<void> {
  await purgeExpiredSessions();
  const idempotencyKeysDeleted = await purgeExpiredIdempotencyKeys();
  const cases = await purgeExpiredCases(100);

  console.log(
    JSON.stringify({
      event: "retention_sweep_complete",
      cases_deleted: cases.deleted,
      idempotency_keys_deleted: idempotencyKeysDeleted,
      deletion_failures: cases.failed.length,
    }),
  );

  if (cases.failed.length > 0) {
    throw new Error(
      `Retention deletion failed for ${cases.failed.length} hashed case identifiers.`,
    );
  }
}

let exitCode = 0;
try {
  await sweep();
} catch {
  exitCode = 1;
  console.error(JSON.stringify({ event: "retention_sweep_failed" }));
} finally {
  try {
    await closePool();
  } catch {
    exitCode = 1;
    console.error(JSON.stringify({ event: "retention_database_close_failed" }));
  }
}

process.exitCode = exitCode;
