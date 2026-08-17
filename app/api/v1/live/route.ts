export const dynamic = "force-dynamic";

/** Cheap process liveness for Render. Deep dependency readiness is /api/v1/health. */
export function GET(): Response {
  return Response.json(
    { status: "ok", service: "wageshield-h1b" },
    {
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
