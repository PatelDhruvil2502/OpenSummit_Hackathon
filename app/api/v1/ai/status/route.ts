import { aiEvidenceConfiguration } from "@/lib/ai-evidence";
import { jsonResponse } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Browser-safe capability discovery for the upload consent UI. Never return
 * the provider endpoint, API key, or other secret-bearing configuration.
 */
export function GET(): Response {
  const configuration = aiEvidenceConfiguration();
  return jsonResponse({
    available: configuration.configured,
    provider: configuration.provider,
  });
}
