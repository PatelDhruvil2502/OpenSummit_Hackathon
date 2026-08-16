import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

const DEFAULT_ORIGIN = "https://wageshield.test";

async function buildMinimalPdf() {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([320, 180]);
  page.drawText("Synthetic WageShield test record", {
    x: 28,
    y: 128,
    size: 12,
    font,
  });
  return document.save({ useObjectStreams: false });
}

const MINIMAL_PDF_BYTES = await buildMinimalPdf();

export async function textPdf(lines) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([612, 792]);
  lines.forEach((line, index) => {
    page.drawText(String(line), {
      x: 48,
      y: 730 - index * 24,
      size: 12,
      font,
    });
  });
  return document.save({ useObjectStreams: false });
}

function findBytes(bytes, needle) {
  outer: for (let index = 0; index <= bytes.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function mergeHeaders(...sources) {
  const headers = new Headers();
  for (const source of sources) {
    if (!source) continue;
    new Headers(source).forEach((value, key) => headers.set(key, value));
  }
  return headers;
}

export function identityHeaders(
  id,
  email = `${id}@example.test`,
  fullName = id,
) {
  return {
    "oai-authenticated-user-id": id,
    "oai-authenticated-user-email": email,
    "oai-authenticated-user-full-name": encodeURIComponent(fullName),
    "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
  };
}

export class WorkerClient {
  constructor(harness, options = {}) {
    this.harness = harness;
    this.origin = options.origin ?? DEFAULT_ORIGIN;
    this.headers = new Headers(options.headers);
    this.cookie = options.cookie ?? "";
  }

  async request(pathname, options = {}) {
    const headers = mergeHeaders(this.headers, options.headers);
    if (this.cookie && !headers.has("cookie")) headers.set("cookie", this.cookie);

    let body = options.body;
    if (options.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.json);
    }

    const response = await this.harness.fetch(
      new Request(new URL(pathname, this.origin), {
        method: options.method ?? (body === undefined ? "GET" : "POST"),
        headers,
        body,
        redirect: options.redirect ?? "manual",
      }),
    );
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";", 1)[0];
    return response;
  }

  async json(pathname, options = {}) {
    const response = await this.request(pathname, options);
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(
        `${options.method ?? "GET"} ${pathname} returned non-JSON ${response.status}: ${text.slice(0, 240)}`,
      );
    }
    return { response, payload };
  }
}

async function collectJavaScriptModules(root) {
  const modules = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      modules.push(...(await collectJavaScriptModules(path)));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      modules.push(path);
    }
  }
  return modules;
}

export async function createWorkerHarness(label = "hardening", options = {}) {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const workerRoot = fileURLToPath(new URL("../../dist/server/", import.meta.url));
  const entrypoint = join(workerRoot, "index.js");
  const discoveredModules = await collectJavaScriptModules(workerRoot);
  const modules = [
    { type: "ESModule", path: entrypoint },
    ...discoveredModules
      .filter((path) => path !== entrypoint)
      .sort()
      .map((path) => ({ type: "ESModule", path })),
  ];
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      modules,
      modulesRoot: workerRoot,
      compatibilityDate: "2026-08-15",
      compatibilityFlags: ["nodejs_compat"],
      unsafeTriggerHandlers: true,
      bindings: {
        // The harness emulates OpenAI Sites, whose gateway strips client
        // identity headers and injects authenticated values of its own.
        TRUST_FORWARDED_IDENTITY: options.trustForwardedIdentity === false ? "false" : "true",
      },
      d1Databases: { DB: `${label}-db-${suffix}` },
      r2Buckets: { BUCKET: `${label}-bucket-${suffix}` },
    }),
  );
  const [DB, BUCKET] = await Promise.all([
    miniflare.getD1Database("DB"),
    miniflare.getR2Bucket("BUCKET"),
  ]);

  const harness = {
    DB,
    BUCKET,
    miniflare,
    client(identity, options = {}) {
      return new WorkerClient(this, {
        ...options,
        headers: mergeHeaders(
          identity
            ? identityHeaders(identity.id, identity.email, identity.name)
            : undefined,
          options.headers,
        ),
      });
    },
    async fetch(request) {
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer();
      return miniflare.dispatchFetch(request.url, {
        method: request.method,
        headers: Array.from(request.headers.entries()),
        body,
        redirect: request.redirect,
      });
    },
    async scheduled(options = {}) {
      const params = new URLSearchParams({
        cron: options.cron ?? "0 * * * *",
        format: "json",
      });
      if (options.scheduledTime !== undefined) {
        const scheduledTime =
          options.scheduledTime instanceof Date
            ? options.scheduledTime.getTime()
            : Number(options.scheduledTime);
        params.set("time", String(scheduledTime));
      }
      return miniflare.dispatchFetch(
        `${DEFAULT_ORIGIN}/cdn-cgi/local/scheduled?${params.toString()}`,
      );
    },
    async dispose() {
      await miniflare.dispose();
    },
  };
  harness.anonymous = new WorkerClient(harness);
  return harness;
}

export async function expectJsonError(response, status, code) {
  const text = await response.text();
  const payload = JSON.parse(text);
  if (response.status !== status || payload?.error?.code !== code) {
    throw new Error(
      `Expected ${status}/${code}, received ${response.status}/${payload?.error?.code}: ${text.slice(0, 300)}`,
    );
  }
  return payload.error;
}

export function minimalPdf(extra = "") {
  if (!extra) return MINIMAL_PDF_BYTES.slice();

  const marker = new TextEncoder().encode("%%EOF");
  let markerIndex = -1;
  outer: for (let index = MINIMAL_PDF_BYTES.length - marker.length; index >= 0; index -= 1) {
    for (let offset = 0; offset < marker.length; offset += 1) {
      if (MINIMAL_PDF_BYTES[index + offset] !== marker[offset]) continue outer;
    }
    markerIndex = index;
    break;
  }
  if (markerIndex < 0) throw new Error("Generated PDF is missing its EOF marker");

  const insertion = new TextEncoder().encode(`${extra}\n`);
  const output = new Uint8Array(MINIMAL_PDF_BYTES.length + insertion.length);
  output.set(MINIMAL_PDF_BYTES.slice(0, markerIndex));
  output.set(insertion, markerIndex);
  output.set(MINIMAL_PDF_BYTES.slice(markerIndex), markerIndex + insertion.length);
  return output;
}

export function minimalPdfVariant(variant) {
  const output = MINIMAL_PDF_BYTES.slice();
  const marker = new TextEncoder().encode("/ModDate (D:");
  const markerIndex = findBytes(output, marker);
  if (markerIndex < 0) throw new Error("Generated PDF is missing its modification date");
  const digits = String(Math.abs(Number(variant)) % 1_000_000)
    .padStart(6, "0")
    .slice(-6);
  output.set(
    new TextEncoder().encode(digits),
    markerIndex + marker.length + 8,
  );
  return output;
}
