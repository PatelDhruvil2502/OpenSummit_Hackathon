/**
 * Shared no-store response helpers.
 *
 * Case ownership no longer uses a browser session. Authentication lives in
 * `lib/identity.ts`; this module remains intentionally small so binary and JSON
 * responses receive the same privacy and request-tracing headers.
 */
export function privateResponseHeaders(initial?: HeadersInit, requestId = crypto.randomUUID()): Headers {
  const headers = new Headers(initial);
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("Pragma", "no-cache");
  headers.set("X-Request-ID", requestId);
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

export function jsonResponse(
  body: unknown,
  init: ResponseInit = {},
  requestId?: string,
): Response {
  const headers = privateResponseHeaders(init.headers, requestId);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(
    JSON.stringify(body, (key, value) =>
      key === "ownerUserId" || key === "objectKey" ? undefined : value,
    ),
    { ...init, headers },
  );
}
