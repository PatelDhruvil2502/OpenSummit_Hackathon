import { authenticationRequired, internalError } from "@/lib/api";
import { authenticateCaseRequest } from "@/lib/case-auth";
import { getAccountPolicyAcceptance } from "@/lib/accounts";
import { jsonResponse } from "@/lib/session";
import { listOwnedCases } from "@/lib/storage";

/**
 * A portable, structured copy of the data WageShield currently retains for
 * the signed-in user. `jsonResponse` recursively omits storage-only owner and
 * object-key fields, so an export never leaks R2 paths or internal ownership
 * metadata.
 */
export async function GET(request: Request) {
  const identity = await authenticateCaseRequest(request);
  if (!identity) return authenticationRequired(request, "/account");

  try {
    const [cases, policyAcceptance] = await Promise.all([
      listOwnedCases(identity.user.userId),
      identity.user.source === "account"
        ? getAccountPolicyAcceptance(identity.user.userId)
        : Promise.resolve(null),
    ]);
    const generatedAt = new Date().toISOString();
    const response = jsonResponse({
      exportVersion: "1.0",
      generatedAt,
      account: {
        id: identity.user.userId,
        email: identity.user.email,
        displayName: identity.user.displayName,
        fullName: identity.user.fullName,
        source: identity.user.source,
        policyAcceptance,
      },
      cases,
    });
    response.headers.set(
      "Content-Disposition",
      `attachment; filename="wageshield-export-${generatedAt.slice(0, 10)}.json"`,
    );
    return response;
  } catch (error) {
    return internalError(error);
  }
}
