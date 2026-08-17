import { jsonResponse } from "@/lib/session";
import { storageHealthCheck } from "@/lib/storage";
import { RULE_SET_VERSION } from "@/lib/versions";
import { companyDetailsArePlaceholders } from "@/lib/company";
import { signupAccessIsConfigured } from "@/lib/accounts";
import { emailIsConfigured } from "@/lib/email";
import { publicAppOrigin } from "@/lib/runtime-flags";

const SUCCESS_CACHE_MS = 60 * 1000;
const FAILURE_CACHE_MS = 15 * 1000;
type DependencyHealth = { database: true; objects: true };
let cachedDependencies:
  | { checkedAt: number; ok: true; value: DependencyHealth }
  | { checkedAt: number; ok: false }
  | undefined;

async function dependenciesWithShortCache(): Promise<DependencyHealth> {
  if (cachedDependencies) {
    const age = Date.now() - cachedDependencies.checkedAt;
    if (cachedDependencies.ok && age < SUCCESS_CACHE_MS) return cachedDependencies.value;
    if (!cachedDependencies.ok && age < FAILURE_CACHE_MS) {
      throw new Error("Dependency readiness is temporarily degraded");
    }
  }
  try {
    const value = await storageHealthCheck();
    cachedDependencies = { checkedAt: Date.now(), ok: true, value };
    return value;
  } catch (error) {
    cachedDependencies = { checkedAt: Date.now(), ok: false };
    throw error;
  }
}

export async function GET() {
  try {
    // This is an operator-facing deep readiness check, not Render's frequent
    // liveness probe. Cache successful dependency checks briefly so repeated
    // dashboard refreshes do not create unnecessary database work.
    const dependencies = await dependenciesWithShortCache();
    const configuration = {
      company_details_configured: !companyDetailsArePlaceholders(),
      password_email_configured: emailIsConfigured(),
      public_app_url_configured: Boolean(publicAppOrigin()),
      signup_access_configured: signupAccessIsConfigured(),
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
