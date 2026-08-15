import { jsonResponse } from "@/lib/session";
import { storageHealthCheck } from "@/lib/storage";

export async function GET() {
  try {
    const dependencies = await storageHealthCheck();
    return jsonResponse({
      status: "ok",
      service: "wageshield-h1b",
      rule_set_version: "wageshield.rules.1.1.0",
      privacy_mode: "account-owned-private-records",
      dependencies,
    });
  } catch {
    return jsonResponse(
      {
        status: "degraded",
        service: "wageshield-h1b",
        dependencies: { database: false, objects: false },
      },
      { status: 503 },
    );
  }
}
