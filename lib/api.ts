import type { ZodError } from "zod";
import { signInPathForRequest } from "./identity";
import { jsonResponse } from "./session";
import {
  AccountDeletionPendingError,
  ActiveCaseQuotaError,
  CaseDeletionPendingError,
  CaseStorageQuotaError,
  CaseVersionConflictError,
  DeletionVerificationError,
  ReportQuotaError,
} from "./storage";

export type ErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "CSRF_REJECTED"
  | "CONCURRENT_UPDATE"
  | "IDEMPOTENCY_REQUIRED"
  | "OPERATION_IN_PROGRESS"
  | "CASE_QUOTA_EXCEEDED"
  | "INVALID_REQUEST"
  | "CASE_ACCESS_DENIED"
  | "INVALID_UPLOAD_TYPE"
  | "FILE_SIGNATURE_MISMATCH"
  | "FILE_TOO_LARGE"
  | "DOCUMENT_PASSWORD_REQUIRED"
  | "DOCUMENT_ACTIVE_CONTENT"
  | "DUPLICATE_DOCUMENT"
  | "FACT_REVIEW_REQUIRED"
  | "REPORT_EMPTY"
  | "INTERNAL_ERROR";

export function errorResponse(
  code: ErrorCode,
  message: string,
  status: number,
  retryable = false,
  details?: Record<string, string>,
  requestId = crypto.randomUUID(),
): Response {
  return jsonResponse(
    {
      error: {
        code,
        message,
        request_id: requestId,
        retryable,
        ...(details ? { details } : {}),
      },
    },
    { status },
    requestId,
  );
}

export function authenticationRequired(request: Request, returnTo = "/cases"): Response {
  const requestId = crypto.randomUUID();
  return jsonResponse(
    {
      error: {
        code: "AUTHENTICATION_REQUIRED",
        message: "Sign in to access your private WageShield reviews.",
        request_id: requestId,
        retryable: false,
        sign_in_url: signInPathForRequest(request, returnTo),
      },
    },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="WageShield"' } },
    requestId,
  );
}

export function validationDetails(error: ZodError): Record<string, string> {
  return Object.fromEntries(
    error.issues.slice(0, 8).map((issue) => [issue.path.join(".") || "request", issue.message]),
  );
}

export function notFound(): Response {
  return errorResponse(
    "CASE_ACCESS_DENIED",
    "This case is unavailable or you do not have access.",
    404,
  );
}

export function internalError(error?: unknown): Response {
  if (error instanceof CaseVersionConflictError) {
    return errorResponse(
      "CONCURRENT_UPDATE",
      "This review changed in another tab or request. Refresh it, then retry your update.",
      409,
      true,
    );
  }
  if (error instanceof DeletionVerificationError) {
    return errorResponse(
      "INTERNAL_ERROR",
      "Deletion could not be fully verified. The review has been locked; retry deletion or contact support with the request ID.",
      503,
      true,
    );
  }
  if (error instanceof ActiveCaseQuotaError) {
    return errorResponse("CASE_QUOTA_EXCEEDED", error.message, 409);
  }
  if (error instanceof AccountDeletionPendingError) {
    return errorResponse("INVALID_REQUEST", error.message, 409);
  }
  if (error instanceof CaseStorageQuotaError) {
    return errorResponse("CASE_QUOTA_EXCEEDED", error.message, 409);
  }
  if (error instanceof ReportQuotaError) {
    return errorResponse("CASE_QUOTA_EXCEEDED", error.message, 409);
  }
  if (error instanceof CaseDeletionPendingError) {
    return errorResponse("INVALID_REQUEST", error.message, 409);
  }
  if (error instanceof Error && error.message.startsWith("INVALID_CASE_TRANSITION:")) {
    return errorResponse(
      "INVALID_REQUEST",
      "This action is not available in the review's current state. Refresh and retry.",
      409,
      true,
    );
  }
  const requestId = crypto.randomUUID();
  console.error(
    JSON.stringify({
      event: "request_error",
      requestId,
      errorType: error instanceof Error ? error.name : typeof error,
    }),
  );
  return errorResponse(
    "INTERNAL_ERROR",
    "WageShield could not complete this step. Your existing case data was preserved.",
    500,
    true,
    undefined,
    requestId,
  );
}
