import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle-render",
  schema: "./db/schema.ts",
  dialect: "postgresql",
});
