import { jsonResponse } from "@/lib/session";
import { storageHealthCheck } from "@/lib/storage";
import { RULE_SET_VERSION } from "@/lib/versions";
import { companyDetailsArePlaceholders } from "@/lib/company";
import { emailIsConfigured } from "@/lib/email";
import { publicAppOrigin } from "@/lib/runtime-flags";

export async function GET() {
  try {
    const dependencies = await storageHealthCheck();
    const configuration = {
      company_details_configured: !companyDetailsArePlaceholders(),
      password_email_configured: emailIsConfigured(),
      public_app_url_configured: Boolean(publicAppOrigin()),
    };
    return jsonResponse({
      status: "ok",
      service: "wageshield-h1b",
      rule_set_version: RULE_SET_VERSION,
      privacy_mode: "account-owned-private-records",
      launch_ready: Object.values(configuration).every(Boolean),
      configuration,
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
