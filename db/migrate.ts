import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closePool, getDb } from "./index";

try {
  await migrate(getDb(), { migrationsFolder: "./drizzle-render" });
  console.log("PostgreSQL migrations applied successfully.");
} finally {
  await closePool();
}
