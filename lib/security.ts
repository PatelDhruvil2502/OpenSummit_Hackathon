import { errorResponse } from "./api";
import { isLocalHostname, requestUsesHttps } from "./identity";
import { publicAppOrigin } from "./runtime-flags";

function routedLocalOrigin(request: Request): string | null {
  const authority = request.headers.get("host")?.trim();
  if (!authority) return null;
  const protocol = requestUsesHttps(request) ? "https:" : "http:";
  try {
    const routed = new URL(`${protocol}//${authority}`);
    if (
      !isLocalHostname(routed.hostname) ||
      routed.username ||
      routed.password ||
      routed.pathname !== "/" ||
      routed.search ||
      routed.hash
    ) {
      return null;
    }
    return routed.origin;
  } catch {
    return null;
  }
}

function requestOriginIsAllowed(request: Request, origin: string): boolean {
  const receivedOrigin = new URL(origin).origin;
  const configuredOrigin = publicAppOrigin();
  if (configuredOrigin) return receivedOrigin === configuredOrigin;
  if (receivedOrigin === new URL(request.url).origin) return true;

  // Next can expose 0.0.0.0 or an internal placeholder in Request.url during
  // local development. The browser-visible Host is accepted only when it is
  // an exact loopback origin, including protocol and port.
  return receivedOrigin === routedLocalOrigin(request);
}

export function mutationGuard(request: Request): Response | null {
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite === "cross-site") {
    return errorResponse(
      "CSRF_REJECTED",
      "This update was rejected because it did not originate from WageShield.",
      403,
    );
  }

  const origin = request.headers.get("origin");
  if (origin) {
    try {
      // On Render the public HTTPS origin is terminated at the edge while the
      // Node service receives an internal request.  Compare browser mutations
      // with the explicitly configured canonical origin rather than relying on
      // that internal URL.
      if (!requestOriginIsAllowed(request, origin)) {
        return errorResponse(
          "CSRF_REJECTED",
          "This update was rejected because it did not originate from WageShield.",
          403,
        );
      }
    } catch {
      return errorResponse("CSRF_REJECTED", "The request origin is invalid.", 403);
    }
  }
  return null;
}

type LimitedBody =
  | { ok: true; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; response: Response };

async function readLimitedBody(request: Request, maximumBytes: number): Promise<LimitedBody> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maximumBytes) {
    return {
      ok: false,
      response: errorResponse("INVALID_REQUEST", "The request body is too large.", 413),
    };
  }
  if (!request.body) return { ok: true, bytes: new Uint8Array() };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        return {
          ok: false,
          response: errorResponse("INVALID_REQUEST", "The request body is too large.", 413),
        };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

export async function parseJsonBody(request: Request): Promise<
  | { ok: true; value: unknown }
  | { ok: false; response: Response }
> {
  const body = await readLimitedBody(request, 256 * 1024);
  if (!body.ok) return body;
  try {
    return {
      ok: true,
      value: JSON.parse(new TextDecoder().decode(body.bytes)) as unknown,
    };
  } catch {
    return {
      ok: false,
      response: errorResponse("INVALID_REQUEST", "Send a valid JSON request body.", 400),
    };
  }
}

export async function parseFormDataBody(
  request: Request,
  maximumBytes = 32 * 1024,
): Promise<
  | { ok: true; value: FormData }
  | { ok: false; response: Response }
> {
  const body = await readLimitedBody(request, maximumBytes);
  if (!body.ok) return body;
  try {
    const replay = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: body.bytes,
    });
    return { ok: true, value: await replay.formData() };
  } catch {
    return {
      ok: false,
      response: errorResponse("INVALID_REQUEST", "Send valid form data.", 400),
    };
  }
}

export function requireIdempotencyKey(request: Request):
  | { ok: true; key: string }
  | { ok: false; response: Response } {
  const key = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(key)) {
    return {
      ok: false,
      response: errorResponse(
        "IDEMPOTENCY_REQUIRED",
        "Send a unique Idempotency-Key of 16 to 128 safe characters.",
        400,
      ),
    };
  }
  return { ok: true, key };
}
