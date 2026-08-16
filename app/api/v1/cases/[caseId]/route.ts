import { z } from "zod";
import {
  authenticationRequired,
  errorResponse,
  internalError,
  notFound,
  validationDetails,
} from "@/lib/api";
import { authenticateCaseRequest } from "@/lib/case-auth";
import { invalidateDerivedResults } from "@/lib/case-workflow";
import { RETENTION_POLICY } from "@/lib/product-config";
import { mutationGuard, parseJsonBody, requireIdempotencyKey } from "@/lib/security";
import { jsonResponse } from "@/lib/session";
import {
  deleteCase,
  getCase,
  listReports,
  releaseIdempotencyKey,
  reserveIdempotencyKey,
  saveCase,
} from "@/lib/storage";

const PatchCaseSchema = z
  .object({
    title: z.string().trim().min(1).max(100).optional(),
    review_start: z.iso.date().optional(),
    review_end: z.iso.date().optional(),
    retention_hours: z
      .number()
      .int()
      .min(RETENTION_POLICY.minimumHours)
      .max(RETENTION_POLICY.maximumHours)
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one setting is required");

type Context = { params: Promise<{ caseId: string }> };

export async function GET(request: Request, context: Context) {
  const identity = await authenticateCaseRequest(request);
  if (!identity) return authenticationRequired(request);
  try {
    const { caseId } = await context.params;
    const caseData = await getCase(caseId, identity.user.userId);
    if (!caseData) return notFound();
    caseData.reports = await listReports(caseId, identity.user.userId, caseData.reports);
    if (caseData.lastReport) {
      caseData.lastReport =
        caseData.reports.find((report) => report.id === caseData.lastReport?.id) ??
        caseData.lastReport;
    }
    return jsonResponse({ case: caseData });
  } catch (error) {
    return internalError(error);
  }
}

export async function PATCH(request: Request, context: Context) {
  const identity = await authenticateCaseRequest(request);
  if (!identity) return authenticationRequired(request);
  const guarded = mutationGuard(request);
  if (guarded) return guarded;
  try {
    const { caseId } = await context.params;
    const caseData = await getCase(caseId, identity.user.userId);
    if (!caseData) return notFound();
    const body = await parseJsonBody(request);
    if (!body.ok) return body.response;
    const parsed = PatchCaseSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(
        "INVALID_REQUEST",
        "One or more review settings are invalid.",
        400,
        false,
        validationDetails(parsed.error),
      );
    }
    const datesChanged =
      (parsed.data.review_start && parsed.data.review_start !== caseData.reviewStart) ||
      (parsed.data.review_end && parsed.data.review_end !== caseData.reviewEnd);
    if (parsed.data.title) caseData.title = parsed.data.title;
    if (parsed.data.review_start) caseData.reviewStart = parsed.data.review_start;
    if (parsed.data.review_end) caseData.reviewEnd = parsed.data.review_end;
    if (parsed.data.retention_hours) {
      caseData.retentionHours = parsed.data.retention_hours;
      caseData.retentionExpiresAt = new Date(
        Date.now() + parsed.data.retention_hours * 60 * 60 * 1000,
      ).toISOString();
    }
    if (caseData.reviewStart > caseData.reviewEnd) {
      return errorResponse(
        "INVALID_REQUEST",
        "The review start date must be on or before the end date.",
        400,
      );
    }
    if (datesChanged) invalidateDerivedResults(caseData);
    await saveCase(caseData);
    return jsonResponse({ case: caseData });
  } catch (error) {
    return internalError(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  const identity = await authenticateCaseRequest(request);
  if (!identity) return authenticationRequired(request);
  const guarded = mutationGuard(request);
  if (guarded) return guarded;
  let scope = "";
  let idempotencyKey = "";
  let reserved = false;
  try {
    const { caseId } = await context.params;
    const existing = await getCase(caseId, identity.user.userId);
    if (!existing) return notFound();
    const idempotency = requireIdempotencyKey(request);
    if (!idempotency.ok) return idempotency.response;
    idempotencyKey = idempotency.key;
    scope = `cases:${caseId}:delete`;
    const prior = await reserveIdempotencyKey(identity.user.userId, scope, idempotencyKey);
    if (prior !== "RESERVED") {
      return errorResponse(
        "OPERATION_IN_PROGRESS",
        "Deletion is already running. Retry shortly with the same key.",
        409,
        true,
      );
    }
    reserved = true;
    const deleted = await deleteCase(caseId, identity.user.userId);
    if (!deleted) {
      await releaseIdempotencyKey(identity.user.userId, scope, idempotencyKey);
      return notFound();
    }
    const responseBody = {
      deletion: { status: "DELETED", verified: true, completed_at: new Date().toISOString() },
    };
    return jsonResponse(responseBody);
  } catch (error) {
    if (reserved && scope && idempotencyKey) {
      await releaseIdempotencyKey(identity.user.userId, scope, idempotencyKey);
    }
    return internalError(error);
  }
}
