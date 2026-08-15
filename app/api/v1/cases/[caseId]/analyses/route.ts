import { authenticationRequired, errorResponse, internalError, notFound } from "@/lib/api";
import { authenticateCaseRequest } from "@/lib/case-auth";
import { analysisReadiness, assertCaseTransition } from "@/lib/case-workflow";
import { runAllRules } from "@/lib/rules";
import { mutationGuard, requireIdempotencyKey } from "@/lib/security";
import { jsonResponse } from "@/lib/session";
import {
  appendAudit,
  completeIdempotencyKey,
  getCase,
  releaseIdempotencyKey,
  reserveIdempotencyKey,
  saveCase,
} from "@/lib/storage";

type Context = { params: Promise<{ caseId: string }> };

export async function POST(request: Request, context: Context) {
  const identity = await authenticateCaseRequest(request);
  if (!identity) return authenticationRequired(request);
  const guarded = mutationGuard(request);
  if (guarded) return guarded;
  const idempotency = requireIdempotencyKey(request);
  if (!idempotency.ok) return idempotency.response;
  let activeCase: Awaited<ReturnType<typeof getCase>> = null;
  let reserved = false;
  let scope = "";

  try {
    const { caseId } = await context.params;
    scope = `cases:${caseId}:analysis`;
    const prior = await reserveIdempotencyKey(identity.user.userId, scope, idempotency.key);
    if (prior === "IN_PROGRESS") {
      return errorResponse(
        "OPERATION_IN_PROGRESS",
        "This analysis is already running. Wait a moment, then retry with the same key.",
        409,
        true,
      );
    }
    if (prior !== "RESERVED") return jsonResponse(prior.body, { status: prior.status });
    reserved = true;

    const caseData = await getCase(caseId, identity.user.userId);
    if (!caseData) {
      await releaseIdempotencyKey(identity.user.userId, scope, idempotency.key);
      return notFound();
    }
    activeCase = caseData;
    if (caseData.mode === "STANDARD") {
      const readiness = analysisReadiness(caseData);
      if (!readiness.ready) {
        await releaseIdempotencyKey(identity.user.userId, scope, idempotency.key);
        return errorResponse(
          "FACT_REVIEW_REQUIRED",
          "Finish the required document and fact review before running comparisons.",
          409,
          false,
          {
            missing_documents: readiness.missingDocuments.join(", ") || "none",
            missing_facts: readiness.missingFacts.join(", ") || "none",
            unreviewed_proposals: String(readiness.unreviewedCount),
          },
        );
      }
    }

    const priorChoices = new Map(
      caseData.findings.map((finding) => [
        finding.module,
        { includeInReport: finding.includeInReport, disposition: finding.disposition },
      ]),
    );
    if (caseData.reports) {
      caseData.reports = caseData.reports.map((report) => ({
        ...report,
        status: "SUPERSEDED",
      }));
    }
    delete caseData.lastReport;
    assertCaseTransition(caseData, "ANALYZING");
    await saveCase(caseData);

    const findings = runAllRules(caseData);
    caseData.findings = findings.map((finding) => ({
      ...finding,
      ...(priorChoices.get(finding.module) ?? {}),
    }));
    assertCaseTransition(caseData, "RESULTS_READY");
    caseData.lastAnalysisAt = new Date().toISOString();
    await saveCase(caseData);
    const analysisId = `analysis_${crypto.randomUUID()}`;
    try {
      await appendAudit(caseData.id, "ANALYSIS_COMPLETED", {
        analysisId,
        findingCount: caseData.findings.length,
        ruleSetVersion: caseData.ruleSetVersion,
      });
    } catch {
      // The completed immutable case snapshot remains authoritative if the
      // non-content audit append is temporarily unavailable.
    }
    const responseBody = {
      analysis: { id: analysisId, status: "RESULTS_READY" },
      case: caseData,
    };
    try {
      await completeIdempotencyKey(identity.user.userId, scope, idempotency.key, {
        status: 201,
        body: responseBody,
      });
    } catch {
      // The analysis snapshot is committed and remains authoritative.
    }
    return jsonResponse(responseBody, { status: 201 });
  } catch (error) {
    if (activeCase?.state === "ANALYZING") {
      activeCase.state = "ANALYSIS_FAILED";
      try {
        await saveCase(activeCase);
      } catch {
        // Preserve the original safe error response.
      }
    }
    if (reserved && scope) {
      await releaseIdempotencyKey(identity.user.userId, scope, idempotency.key);
    }
    return internalError(error);
  }
}
