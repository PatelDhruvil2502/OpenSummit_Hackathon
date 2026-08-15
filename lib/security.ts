import { errorResponse } from "./api";

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
      if (new URL(origin).origin !== new URL(request.url).origin) {
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

export async function parseJsonBody(request: Request): Promise<
  | { ok: true; value: unknown }
  | { ok: false; response: Response }
> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 256 * 1024) {
    return {
      ok: false,
      response: errorResponse("INVALID_REQUEST", "The request body is too large.", 413),
    };
  }
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return {
      ok: false,
      response: errorResponse("INVALID_REQUEST", "Send a valid JSON request body.", 400),
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
