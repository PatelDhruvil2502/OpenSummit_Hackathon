import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { Pool } from "pg";

const exec = promisify(execFile);

async function executable(path) {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function openPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (!port) throw new Error("Could not allocate a PostgreSQL test port");
  return port;
}

async function findPostgresBin() {
  const configured = process.env.POSTGRES_BIN?.trim();
  const candidates = [
    configured,
    "/opt/homebrew/opt/postgresql@17/bin",
    "/opt/homebrew/opt/postgresql@16/bin",
    "/usr/local/opt/postgresql@17/bin",
    "/usr/local/opt/postgresql@16/bin",
  ].filter(Boolean);
  for (const directory of candidates) {
    if (await executable(join(directory, "initdb")) && await executable(join(directory, "pg_ctl"))) {
      return directory;
    }
  }
  try {
    const { stdout } = await exec("sh", ["-c", "command -v initdb"]);
    const location = stdout.trim();
    if (location) return location.slice(0, -basename(location).length).replace(/\/$/, "");
  } catch {
    // Docker is attempted below when a native PostgreSQL installation is absent.
  }
  return null;
}

async function waitForPostgres(url, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 1_000 });
    try {
      await pool.query("SELECT 1");
      await pool.end();
      return;
    } catch {
      await pool.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("Temporary PostgreSQL did not become ready");
}

async function nativePostgres(directory) {
  const root = await mkdtemp(join(tmpdir(), "wageshield-postgres-"));
  const data = join(root, "data");
  const log = join(root, "postgres.log");
  const port = await openPort();
  await exec(join(directory, "initdb"), [
    "-D",
    data,
    "--auth=trust",
    "--encoding=UTF8",
    "--no-locale",
  ]);
  await exec(join(directory, "pg_ctl"), [
    "-D",
    data,
    "-l",
    log,
    "-o",
    `-F -p ${port} -h 127.0.0.1`,
    "-w",
    "start",
  ]);
  const url = `postgresql://127.0.0.1:${port}/postgres`;
  await waitForPostgres(url);
  return {
    url,
    async close() {
      await exec(join(directory, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"])
        .catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function dockerPostgres() {
  await exec("docker", ["info"]);
  const name = `wageshield-test-${process.pid}-${Date.now()}`;
  await exec("docker", [
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    "-e",
    "POSTGRES_USER=wageshield",
    "-e",
    "POSTGRES_PASSWORD=wageshield-test",
    "-e",
    "POSTGRES_DB=postgres",
    "-p",
    "127.0.0.1::5432",
    "postgres:17-alpine",
  ]);
  const { stdout } = await exec("docker", ["port", name, "5432/tcp"]);
  const port = Number(stdout.trim().split(":").at(-1));
  if (!port) throw new Error("Docker did not publish the PostgreSQL test port");
  const url = `postgresql://wageshield:wageshield-test@127.0.0.1:${port}/postgres`;
  await waitForPostgres(url, 120);
  return {
    url,
    async close() {
      await exec("docker", ["stop", name]).catch(() => undefined);
    },
  };
}

async function testDatabase() {
  if (process.env.TEST_DATABASE_URL?.trim()) {
    await waitForPostgres(process.env.TEST_DATABASE_URL.trim());
    return { url: process.env.TEST_DATABASE_URL.trim(), close: async () => undefined };
  }
  const native = await findPostgresBin();
  if (native) return nativePostgres(native);
  try {
    return await dockerPostgres();
  } catch (error) {
    throw new Error(
      `Integration tests require PostgreSQL. Set TEST_DATABASE_URL, install PostgreSQL, or start Docker. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const database = await testDatabase();
try {
  const files = (await readdir("tests"))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => join("tests", name));
  const child = spawn(
    process.execPath,
    ["--test", "--test-concurrency=1", ...files],
    {
      stdio: "inherit",
      env: { ...process.env, TEST_DATABASE_URL: database.url },
    },
  );
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status, signal) => {
      if (signal) reject(new Error(`Integration tests stopped by ${signal}`));
      else resolve(status ?? 1);
    });
  });
  if (code !== 0) process.exitCode = code;
} finally {
  await database.close();
}
