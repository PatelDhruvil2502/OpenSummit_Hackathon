import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json" with { type: "json" };
import { sites } from "./build/sites-vite-plugin.js";

/**
 * Local development and OpenAI Sites hosting both inject their own binding
 * values, so a placeholder identifier is correct there. A self-hosted
 * Cloudflare deployment must supply the real D1 database id, which is why every
 * binding value below is overridable from the environment. See DEPLOYMENT.md.
 */
const PLACEHOLDER_DATABASE_ID = "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

const workerName = process.env.CLOUDFLARE_WORKER_NAME ?? "wageshield-h1b";
const databaseName = process.env.CLOUDFLARE_D1_DATABASE_NAME ?? "site-creator-d1";
const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID ?? PLACEHOLDER_DATABASE_ID;
const bucketName = process.env.CLOUDFLARE_R2_BUCKET_NAME ?? "site-creator-r2";
const retentionCron = process.env.CLOUDFLARE_RETENTION_CRON ?? "*/15 * * * *";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  name: workerName,
  main: "./worker/index.ts",
  // Preserve dashboard-managed text variables on direct Wrangler deploys.
  // Secrets are preserved by Wrangler independently.
  keep_vars: true,
  compatibility_flags: ["nodejs_compat"],
  triggers: { crons: [retentionCron] },
  observability: { enabled: true },
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: databaseName,
          database_id: databaseId,
          // Project-relative here; the Cloudflare plugin rewrites it so the
          // emitted dist/server/wrangler.json points back at ./drizzle, letting
          // `wrangler d1 migrations apply` use the checked-in migrations.
          migrations_dir: "drizzle",
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: bucketName,
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
