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

const CategorySchema = z.enum([
  "PETITION_OR_LEGAL_FEE_REFERENCE",
  "EMPLOYER_BUSINESS_EXPENSE_REFERENCE",
  "EARLY_DEPARTURE_REFERENCE",
  "TRAINING_OR_RELOCATION_REFERENCE",
  "ORDINARY_TAX_OR_BENEFIT_DEDUCTION",
  "UNKNOWN",
]);
const TransactionSchema = z.enum(["PAYROLL_OBSERVED", "DIRECT_REQUEST", "CLAUSE_ONLY"]);
const DeductionReviewSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm") }),
  z.object({ action: z.literal("reject") }),
  z.object({
    action: z.literal("correct"),
    description: z.string().trim().min(1).max(200),
    amount_cents: z.number().int().min(0).max(1_000_000_000),
    date: z.iso.date(),
    category: CategorySchema,
    transaction_status: TransactionSchema,
  }),
]);

type Context = { params: Promise<{ caseId: string; deductionId: string }> };

export async function POST(request: Request, context: Context) {
  const identity = await authenticateCaseRequest(request);
  if (!identity) return authenticationRequired(request);
  const guarded = mutationGuard(request);
  if (guarded) return guarded;
  try {
    const { caseId, deductionId } = await context.params;
    const caseData = await getCase(caseId, identity.user.userId);
    if (!caseData) return notFound();
    const deduction = caseData.deductions.find((candidate) => candidate.id === deductionId);
    if (!deduction) return notFound();
    const body = await parseJsonBody(request);
    if (!body.ok) return body.response;
    const parsed = DeductionReviewSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(
        "INVALID_REQUEST",
        "Confirm, reject, or enter a valid deduction correction.",
        400,
        false,
        validationDetails(parsed.error),
      );
    }
    const documentId = deduction.sourceDocumentId ?? deduction.evidence.documentId;
    if (parsed.data.action === "reject") {
      if (deduction.reviewStatus !== "NEEDS_REVIEW") {
        return errorResponse("INVALID_REQUEST", "Only an unreviewed proposal can be rejected.", 409);
      }
      caseData.deductions = caseData.deductions.filter(
        (candidate) => candidate.id !== deduction.id,
      );
      refreshDocumentReviewStatus(caseData, documentId);
      invalidateDerivedResults(caseData);
      await saveCase(caseData);
      await appendAudit(caseData.id, "DEDUCTION_PROPOSAL_REJECTED", { deductionId });
      return jsonResponse({ case: caseData, deduction: null });
    }
    if (parsed.data.action === "correct") {
      Object.assign(deduction, {
        description: parsed.data.description,
        amountCents: parsed.data.amount_cents,
        date: parsed.data.date,
        category: parsed.data.category,
        transactionStatus: parsed.data.transaction_status,
        descriptionConfidence: 1,
        reviewStatus: "USER_CORRECTED" as const,
      });
    } else {
      deduction.reviewStatus = "CONFIRMED";
    }
    deduction.reviewedAt = new Date().toISOString();
    refreshDocumentReviewStatus(caseData, documentId);
    invalidateDerivedResults(caseData);
    await saveCase(caseData);
    await appendAudit(
      caseData.id,
      parsed.data.action === "correct" ? "DEDUCTION_CORRECTED" : "DEDUCTION_CONFIRMED",
      { deductionId },
    );
    return jsonResponse({ case: caseData, deduction });
  } catch (error) {
    return internalError(error);
  }
}
