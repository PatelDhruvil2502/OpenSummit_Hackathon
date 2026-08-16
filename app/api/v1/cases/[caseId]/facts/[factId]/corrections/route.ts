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
import { API_POLICY } from "@/lib/product-config";
import { mutationGuard, parseJsonBody } from "@/lib/security";
import { jsonResponse } from "@/lib/session";
import { appendAudit, getCase, saveCase } from "@/lib/storage";
import type { CasePayload, FactRecord } from "@/lib/types";

const CorrectionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm") }),
  z.object({ action: z.literal("reject") }),
  z.object({ action: z.literal("delete") }),
  z.object({
    action: z.literal("correct"),
    raw_value: z.string().trim().min(1).max(240),
    normalized_value: z.string().trim().min(1).max(240),
  }),
]);

type Context = { params: Promise<{ caseId: string; factId: string }> };

function validNormalizedValue(type: string, value: string): boolean {
  if (type.endsWith("_CENTS")) return /^\d{1,15}$/.test(value);
  if (type === "PAY_FREQUENCY") {
    return ["WEEKLY", "BIWEEKLY", "SEMI-MONTHLY", "MONTHLY"].includes(value);
  }
  if (type.endsWith("_DATE")) return /^\d{4}-\d{2}-\d{2}$/.test(value);
  return Boolean(value.trim());
}

function syncWorksiteEvents(
  caseData: CasePayload,
  fact: FactRecord,
  action: "keep" | "remove",
): void {
  if (fact.type !== "CURRENT_WORKSITE") return;
  const referencesFact = (event: CasePayload["events"][number]) =>
    event.kind === "WORKSITE_CHANGE" &&
    event.evidence.some((item) => item.id === fact.evidence.id);
  if (action === "remove") {
    caseData.events = caseData.events.filter((event) => !referencesFact(event));
    return;
  }
  for (const event of caseData.events.filter(referencesFact)) {
    event.worksite = fact.rawValue;
    event.certainty = fact.reviewStatus === "CONFIRMED" ? "CONFIRMED" : "APPROXIMATE";
  }
}

export async function POST(request: Request, context: Context) {
  const identity = await authenticateCaseRequest(request);
  if (!identity) return authenticationRequired(request);
  const guarded = mutationGuard(request);
  if (guarded) return guarded;
  try {
    const { caseId, factId } = await context.params;
    const caseData = await getCase(caseId, identity.user.userId);
    if (!caseData) return notFound();
    const fact = caseData.facts.find((candidate) => candidate.id === factId);
    if (!fact) return notFound();
    const body = await parseJsonBody(request);
    if (!body.ok) return body.response;
    const normalizedBody =
      body.value && typeof body.value === "object" && !("action" in body.value)
        ? { ...(body.value as Record<string, unknown>), action: "correct" }
        : body.value;
    const parsed = CorrectionSchema.safeParse(normalizedBody);
    if (!parsed.success) {
      return errorResponse(
        "INVALID_REQUEST",
        "Confirm the proposed value or enter a valid correction.",
        400,
        false,
        validationDetails(parsed.error),
      );
    }

    const previousValue = fact.rawValue;
    if (parsed.data.action === "delete") {
      if (fact.origin !== "USER_ENTERED") {
        return errorResponse(
          "INVALID_REQUEST",
          "Only a user-transcribed fact can be removed. Uploaded proposals can be rejected instead.",
          409,
        );
      }
      syncWorksiteEvents(caseData, fact, "remove");
      caseData.facts = caseData.facts.filter((candidate) => candidate.id !== fact.id);
      caseData.corrections = caseData.corrections.filter(
        (correction) => correction.factId !== fact.id,
      );
      refreshDocumentReviewStatus(caseData, fact.evidence.documentId);
      invalidateDerivedResults(caseData);
      await saveCase(caseData);
      await appendAudit(caseData.id, "USER_FACT_REMOVED", { factId });
      return jsonResponse({ case: caseData, fact: null });
    }
    if (parsed.data.action === "reject") {
      if (fact.reviewStatus !== "NEEDS_REVIEW") {
        return errorResponse("INVALID_REQUEST", "Only an unreviewed proposal can be rejected.", 409);
      }
      syncWorksiteEvents(caseData, fact, "remove");
      caseData.facts = caseData.facts.filter((candidate) => candidate.id !== fact.id);
      refreshDocumentReviewStatus(caseData, fact.evidence.documentId);
      invalidateDerivedResults(caseData);
      await saveCase(caseData);
      await appendAudit(caseData.id, "FACT_PROPOSAL_REJECTED", { factId });
      return jsonResponse({ case: caseData, fact: null });
    }
    if (parsed.data.action === "correct") {
      if (!validNormalizedValue(fact.type, parsed.data.normalized_value)) {
        return errorResponse(
          "INVALID_REQUEST",
          "The normalized value is not valid for this fact type.",
          400,
        );
      }
      fact.rawValue = parsed.data.raw_value;
      fact.normalizedValue = parsed.data.normalized_value;
      fact.reviewStatus = "USER_CORRECTED";
      fact.userEditedAt = new Date().toISOString();
    } else {
      fact.reviewStatus = "CONFIRMED";
    }
    if (caseData.corrections.length >= API_POLICY.maximumCorrectionsPerCase) {
      return errorResponse(
        "CASE_QUOTA_EXCEEDED",
        "This review has reached its correction-history limit.",
        409,
      );
    }
    fact.reviewedAt = new Date().toISOString();
    syncWorksiteEvents(caseData, fact, "keep");
    caseData.corrections.push({
      id: `correction_${crypto.randomUUID()}`,
      factId,
      previousValue,
      newValue: fact.rawValue,
      createdAt: fact.reviewedAt,
    });
    refreshDocumentReviewStatus(caseData, fact.evidence.documentId);
    invalidateDerivedResults(caseData);
    await saveCase(caseData);
    await appendAudit(
      caseData.id,
      parsed.data.action === "correct" ? "FACT_CORRECTED" : "FACT_CONFIRMED",
      { factId },
    );
    return jsonResponse({ case: caseData, fact });
  } catch (error) {
    return internalError(error);
  }
}
