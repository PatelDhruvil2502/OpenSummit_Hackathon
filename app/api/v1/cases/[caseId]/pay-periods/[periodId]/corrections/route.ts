import { z } from "zod";
import {
  authenticationRequired,
  errorResponse,
  internalError,
  notFound,
  validationDetails,
} from "@/lib/api";
import { authenticateCaseRequest } from "@/lib/case-auth";
import { invalidateDerivedResults, refreshDocumentReviewStatus } from "@/lib/case-workflow";
import { mutationGuard, parseJsonBody } from "@/lib/security";
import { jsonResponse } from "@/lib/session";
import { appendAudit, getCase, saveCase } from "@/lib/storage";

const PeriodReviewSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm") }),
  z.object({ action: z.literal("reject") }),
  z.object({
    action: z.literal("correct"),
    start: z.iso.date(),
    end: z.iso.date(),
    pay_date: z.iso.date(),
    ordinary_base_cents: z.number().int().min(0).max(1_000_000_000),
    gross_cents: z.number().int().min(0).max(1_000_000_000),
    complete: z.boolean(),
    comparable: z.boolean(),
  }),
]);

type Context = { params: Promise<{ caseId: string; periodId: string }> };

export async function POST(request: Request, context: Context) {
  const identity = await authenticateCaseRequest(request);
  if (!identity) return authenticationRequired(request);
  const guarded = mutationGuard(request);
  if (guarded) return guarded;
  try {
    const { caseId, periodId } = await context.params;
    const caseData = await getCase(caseId, identity.user.userId);
    if (!caseData) return notFound();
    const period = caseData.payPeriods.find((candidate) => candidate.id === periodId);
    if (!period) return notFound();
    const body = await parseJsonBody(request);
    if (!body.ok) return body.response;
    const parsed = PeriodReviewSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(
        "INVALID_REQUEST",
        "Confirm, reject, or enter a valid pay-period correction.",
        400,
        false,
        validationDetails(parsed.error),
      );
    }
    const documentId = period.sourceDocumentId ?? period.evidence.documentId;
    if (parsed.data.action === "reject") {
      if (period.reviewStatus !== "NEEDS_REVIEW") {
        return errorResponse("INVALID_REQUEST", "Only an unreviewed proposal can be rejected.", 409);
      }
      caseData.payPeriods = caseData.payPeriods.filter((candidate) => candidate.id !== period.id);
      refreshDocumentReviewStatus(caseData, documentId);
      invalidateDerivedResults(caseData);
      await saveCase(caseData);
      await appendAudit(caseData.id, "PAY_PERIOD_PROPOSAL_REJECTED", { periodId });
      return jsonResponse({ case: caseData, pay_period: null });
    }
    if (parsed.data.action === "correct") {
      if (parsed.data.start > parsed.data.end) {
        return errorResponse(
          "INVALID_REQUEST",
          "The pay-period start date must be on or before the end date.",
          400,
        );
      }
      Object.assign(period, {
        start: parsed.data.start,
        end: parsed.data.end,
        payDate: parsed.data.pay_date,
        ordinaryBaseCents: parsed.data.ordinary_base_cents,
        grossCents: parsed.data.gross_cents,
        complete: parsed.data.complete,
        comparable: parsed.data.comparable,
        correctionStatus: "RESOLVED" as const,
        reviewStatus: "USER_CORRECTED" as const,
      });
    } else {
      period.reviewStatus = "CONFIRMED";
      period.correctionStatus = "NONE";
    }
    period.reviewedAt = new Date().toISOString();
    refreshDocumentReviewStatus(caseData, documentId);
    invalidateDerivedResults(caseData);
    await saveCase(caseData);
    await appendAudit(
      caseData.id,
      parsed.data.action === "correct" ? "PAY_PERIOD_CORRECTED" : "PAY_PERIOD_CONFIRMED",
      { periodId },
    );
    return jsonResponse({ case: caseData, pay_period: period });
  } catch (error) {
    return internalError(error);
  }
}
