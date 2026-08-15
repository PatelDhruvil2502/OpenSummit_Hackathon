import type { CasePayload, CaseState, DocumentType } from "./types";

export const REQUIRED_DOCUMENTS: ReadonlyArray<{
  type: DocumentType;
  minimum: number;
  label: string;
}> = [
  { type: "LCA_CERTIFIED", minimum: 1, label: "one certified LCA" },
  {
    type: "OFFER_OR_EMPLOYMENT_LETTER",
    minimum: 1,
    label: "one offer or employment letter",
  },
  { type: "PAYSTUB", minimum: 2, label: "at least two paystubs" },
];

const TRANSITIONS: Record<CaseState, ReadonlySet<CaseState>> = {
  DRAFT: new Set(["INTAKE_COMPLETE", "DELETION_PENDING"]),
  INTAKE_COMPLETE: new Set(["UPLOADING", "DELETION_PENDING"]),
  UPLOADING: new Set(["PROCESSING", "FACT_REVIEW_REQUIRED", "UPLOAD_FAILED", "DELETION_PENDING"]),
  PROCESSING: new Set(["FACT_REVIEW_REQUIRED", "PROCESSING_FAILED", "DELETION_PENDING"]),
  FACT_REVIEW_REQUIRED: new Set(["UPLOADING", "READY_FOR_ANALYSIS", "DELETION_PENDING"]),
  READY_FOR_ANALYSIS: new Set(["UPLOADING", "FACT_REVIEW_REQUIRED", "ANALYZING", "DELETION_PENDING"]),
  ANALYZING: new Set(["RESULTS_READY", "ANALYSIS_FAILED", "DELETION_PENDING"]),
  RESULTS_READY: new Set([
    "UPLOADING",
    "FACT_REVIEW_REQUIRED",
    "READY_FOR_ANALYSIS",
    "ANALYZING",
    "REPORTING",
    "DELETION_PENDING",
  ]),
  REPORTING: new Set(["RESULTS_READY", "REPORT_FAILED", "DELETION_PENDING"]),
  REPORT_FAILED: new Set(["REPORTING", "RESULTS_READY", "DELETION_PENDING"]),
  PROCESSING_FAILED: new Set(["PROCESSING", "UPLOADING", "DELETION_PENDING"]),
  ANALYSIS_FAILED: new Set(["ANALYZING", "READY_FOR_ANALYSIS", "DELETION_PENDING"]),
  UPLOAD_FAILED: new Set(["UPLOADING", "DELETION_PENDING"]),
  DELETION_PENDING: new Set(["DELETED", "DELETION_FAILED"]),
  DELETION_FAILED: new Set(["DELETION_PENDING"]),
  DELETED: new Set(),
};

export interface AnalysisReadiness {
  ready: boolean;
  missingDocuments: string[];
  unreviewedCount: number;
  missingFacts: string[];
}

export function assertCaseTransition(caseData: CasePayload, nextState: CaseState): void {
  if (caseData.state === nextState) return;
  if (!TRANSITIONS[caseData.state].has(nextState)) {
    throw new Error(`INVALID_CASE_TRANSITION:${caseData.state}:${nextState}`);
  }
  caseData.state = nextState;
}

export function analysisReadiness(caseData: CasePayload): AnalysisReadiness {
  const missingDocuments = REQUIRED_DOCUMENTS.filter(({ type, minimum }) => {
    const count = caseData.documents.filter(
      (document) =>
        document.type === type &&
        (document.status === "READY" || document.status === "NEEDS_REVIEW"),
    ).length;
    return count < minimum;
  }).map(({ label }) => label);

  const unreviewedCount =
    caseData.facts.filter((fact) => fact.reviewStatus === "NEEDS_REVIEW").length +
    caseData.payPeriods.filter((period) => period.reviewStatus === "NEEDS_REVIEW").length +
    caseData.deductions.filter((deduction) => deduction.reviewStatus === "NEEDS_REVIEW").length;

  const acceptedFactTypes = new Set(
    caseData.facts
      .filter((fact) => fact.reviewStatus !== "NEEDS_REVIEW")
      .map((fact) => fact.type),
  );
  const missingFacts: string[] = [];
  if (!acceptedFactTypes.has("LCA_WAGE_ANNUAL_CENTS") && !acceptedFactTypes.has("LCA_WAGE_ANNUAL")) {
    missingFacts.push("a reviewed LCA annual wage");
  }
  if (!acceptedFactTypes.has("PAY_FREQUENCY")) missingFacts.push("a reviewed pay frequency");
  if (!caseData.payPeriods.some((period) => period.reviewStatus !== "NEEDS_REVIEW")) {
    missingFacts.push("at least one reviewed complete pay period");
  }

  return {
    ready: !missingDocuments.length && !unreviewedCount && !missingFacts.length,
    missingDocuments,
    unreviewedCount,
    missingFacts,
  };
}

export function stateAfterEvidenceChange(caseData: CasePayload): CaseState {
  const readiness = analysisReadiness(caseData);
  if (readiness.unreviewedCount || readiness.missingFacts.length) return "FACT_REVIEW_REQUIRED";
  if (readiness.missingDocuments.length) return "UPLOADING";
  return "READY_FOR_ANALYSIS";
}

export function invalidateDerivedResults(caseData: CasePayload): void {
  caseData.findings = [];
  delete caseData.lastAnalysisAt;
  if (caseData.reports) {
    caseData.reports = caseData.reports.map((report) => ({
      ...report,
      status: "SUPERSEDED",
    }));
  }
  delete caseData.lastReport;
  caseData.state = stateAfterEvidenceChange(caseData);
}

export function refreshDocumentReviewStatus(
  caseData: CasePayload,
  documentId: string,
): void {
  const document = caseData.documents.find((candidate) => candidate.id === documentId);
  if (!document || document.status === "REJECTED" || document.status === "PROCESSING") return;
  const hasPending =
    caseData.facts.some(
      (fact) => fact.evidence.documentId === documentId && fact.reviewStatus === "NEEDS_REVIEW",
    ) ||
    caseData.payPeriods.some(
      (period) =>
        (period.sourceDocumentId === documentId || period.evidence.documentId === documentId) &&
        period.reviewStatus === "NEEDS_REVIEW",
    ) ||
    caseData.deductions.some(
      (deduction) =>
        (deduction.sourceDocumentId === documentId || deduction.evidence.documentId === documentId) &&
        deduction.reviewStatus === "NEEDS_REVIEW",
    );
  document.status = hasPending ? "NEEDS_REVIEW" : "READY";
}
