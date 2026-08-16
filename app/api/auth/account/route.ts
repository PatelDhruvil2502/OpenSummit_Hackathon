import { z } from "zod";
import {
  authenticationRequired,
  errorResponse,
  internalError,
  validationDetails,
} from "@/lib/api";
import {
  clearAuthCookie,
  deleteAccountRecord,
  getAccountById,
  revokeAllSessions,
  verifyAccountPasswordById,
} from "@/lib/accounts";
import { authenticateCaseRequest } from "@/lib/case-auth";
import { requestUsesHttps } from "@/lib/identity";
import { mutationGuard, parseFormDataBody } from "@/lib/security";
import { jsonResponse } from "@/lib/session";
import { deleteCase, listOwnedCaseIds, lockAccountDeletion } from "@/lib/storage";

const DeleteAccountSchema = z.object({
  current_password: z.string().min(1).max(128),
  confirmation: z.literal("DELETE"),
});

function clearLocalSession(request: Request, response: Response): Response {
  response.headers.append("Set-Cookie", clearAuthCookie(requestUsesHttps(request)));
  return response;
}

/**
 * Permanently deletes a locally-managed WageShield account and every review it
 * owns. Current-password reauthentication and an exact DELETE confirmation are
 * both required. Gateway identities are managed by their identity provider and
 * deliberately cannot be removed through this local-account endpoint.
 */
export async function POST(request: Request) {
  const identity = await authenticateCaseRequest(request);
  if (!identity) return authenticationRequired(request, "/account");
  const guarded = mutationGuard(request);
  if (guarded) return guarded;

  if (identity.user.source !== "account") {
    return errorResponse(
      "INVALID_REQUEST",
      "This identity is managed by the trusted sign-in provider. Re-authenticate there, then use its account controls; you can still delete individual WageShield reviews here.",
      409,
    );
  }

  const body = await parseFormDataBody(request);
  if (!body.ok) return body.response;
  const parsed = DeleteAccountSchema.safeParse({
    current_password: body.value.get("current_password"),
    confirmation: body.value.get("confirmation"),
  });
  if (!parsed.success) {
    return errorResponse(
      "INVALID_REQUEST",
      'Enter your current password and type "DELETE" exactly to confirm permanent deletion.',
      400,
      false,
      validationDetails(parsed.error),
    );
  }

  const verified = await verifyAccountPasswordById(
    identity.user.userId,
    parsed.data.current_password,
  );
  if (verified !== "verified") {
    return errorResponse(
      "INVALID_REQUEST",
      "The current password is incorrect. Your account and reviews were not changed.",
      403,
    );
  }

  try {
    // This durable, opaque lock is checked by the atomic case insert and is
    // intentionally retained after deletion to stop a stale in-flight request
    // from recreating private data for the removed account ID.
    await lockAccountDeletion(identity.user.userId);
    // Stop new authenticated browser requests before deleting private objects.
    await revokeAllSessions(identity.user.userId);

    let deletedCases = 0;
    // A second pass catches a case deletion that raced the initial enumeration.
    for (let pass = 0; pass < 2; pass += 1) {
      const caseIds = await listOwnedCaseIds(identity.user.userId);
      if (!caseIds.length) break;
      for (const caseId of caseIds) {
        if (await deleteCase(caseId, identity.user.userId)) deletedCases += 1;
      }
    }

    const remainingCaseIds = await listOwnedCaseIds(identity.user.userId);
    if (remainingCaseIds.length) {
      return clearLocalSession(
        request,
        errorResponse(
          "INTERNAL_ERROR",
          "Account deletion paused because one or more review objects could not be verified as deleted. Sign in again and retry, or contact support with the request ID.",
          503,
          true,
        ),
      );
    }

    const deletedAccount = await deleteAccountRecord(identity.user.userId);
    if (!deletedAccount && (await getAccountById(identity.user.userId))) {
      return clearLocalSession(
        request,
        errorResponse(
          "INTERNAL_ERROR",
          "The reviews were deleted, but the account record could not be removed. Sign in again and retry, or contact support with the request ID.",
          503,
          true,
        ),
      );
    }

    return clearLocalSession(
      request,
      jsonResponse({
        deletion: {
          status: "DELETED",
          verified: true,
          casesDeleted: deletedCases,
          completedAt: new Date().toISOString(),
        },
      }),
    );
  } catch (error) {
    return clearLocalSession(request, internalError(error));
  }
}
