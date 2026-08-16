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
import { formatCents, parseDollarsToCents } from "@/lib/money";
import { API_POLICY } from "@/lib/product-config";
import { mutationGuard, parseJsonBody } from "@/lib/security";
import { jsonResponse } from "@/lib/session";
import { appendAudit, getCase, saveCase } from "@/lib/storage";
import type {
  CasePayload,
  DocumentType,
  EvidenceRef,
  FactRecord,
  FindingModule,
} from "@/lib/types";

const OptionalMoney = z.string().trim().max(32).optional().default("");
const OptionalDate = z.string().trim().max(10).optional().default("");
const ManualSourceSchema = z.object({
  document_id: z.string().trim().min(1).max(160),
  page: z.coerce.number().int().min(1).max(10_000),
  excerpt: z.string().trim().min(1).max(1_200),
});
type ManualSource = z.infer<typeof ManualSourceSchema>;

const ManualFactsSchema = z
  .object({
    worker_name: z.string().trim().max(100).optional().default(""),
    employer_name: z.string().trim().max(140).optional().default(""),
    position: z.string().trim().max(120).optional().default(""),
    lca_annual_dollars: OptionalMoney,
    offer_annual_dollars: OptionalMoney,
    pay_frequency: z.preprocess(
      (value) => value === "" ? undefined : value,
      z.enum(["WEEKLY", "BIWEEKLY", "SEMI-MONTHLY", "MONTHLY"]).optional(),
    ),
    observed_biweekly_dollars: OptionalMoney,
    pay_period_start: OptionalDate,
    pay_period_end: OptionalDate,
    pay_date: OptionalDate,
    lca_worksite: z.string().trim().max(180).optional().default(""),
    offer_worksite: z.string().trim().max(180).optional().default(""),
    current_worksite: z.string().trim().max(180).optional().default(""),
    worksite_qualifier: z.enum(["ONGOING", "TEMPORARY", "REMOTE", "UNKNOWN"]).optional(),
    deduction_description: z.string().trim().max(200).optional().default(""),
    deduction_dollars: OptionalMoney,
    deduction_date: OptionalDate,
    nonproductive_start: OptionalDate,
    nonproductive_end: OptionalDate,
    employer_related_reason: z.boolean().optional().default(false),
    worker_available: z.boolean().optional().default(false),
    employment_active: z.boolean().optional().default(false),
    nonproductive_observed_dollars: OptionalMoney,
    remove_pay_period: z.boolean().optional().default(false),
    remove_deduction: z.boolean().optional().default(false),
    remove_nonproductive: z.boolean().optional().default(false),
    remove_worksite: z.boolean().optional().default(false),
    lca_source: ManualSourceSchema.optional(),
    offer_source: ManualSourceSchema.optional(),
    pay_source: ManualSourceSchema.optional(),
    context_source: ManualSourceSchema.optional(),
  })
  .superRefine((value, context) => {
    const hasEnteredValue = [
        value.worker_name,
        value.employer_name,
        value.position,
        value.lca_annual_dollars,
        value.offer_annual_dollars,
        value.pay_frequency,
        value.observed_biweekly_dollars,
        value.pay_period_start,
        value.pay_period_end,
        value.pay_date,
        value.lca_worksite,
        value.offer_worksite,
        value.current_worksite,
        value.deduction_description,
        value.deduction_dollars,
        value.deduction_date,
        value.nonproductive_start,
        value.nonproductive_end,
        value.nonproductive_observed_dollars,
      ].some(Boolean);
    const removalCount = [
      value.remove_pay_period,
      value.remove_deduction,
      value.remove_nonproductive,
      value.remove_worksite,
    ].filter(Boolean).length;
    if (!hasEnteredValue && removalCount === 0) {
      context.addIssue({
        code: "custom",
        message: "Enter at least one reviewed value before saving.",
      });
    }
    if (removalCount > 1 || (removalCount > 0 && hasEnteredValue)) {
      context.addIssue({
        code: "custom",
        message: "Remove one transcribed record at a time, separately from saving values.",
      });
    }
    const requireSource = (
      hasGroupValue: boolean,
      source: ManualSource | undefined,
      path: string,
      label: string,
    ) => {
      if (hasGroupValue && !source) {
        context.addIssue({
          code: "custom",
          path: [path],
          message: `Choose the ${label} document, page, and verbatim excerpt.`,
        });
      }
    };
    const sourceGroups = [
      {
        used: Boolean(value.lca_annual_dollars || value.lca_worksite),
        source: value.lca_source,
        path: "lca_source",
        label: "LCA source",
      },
      {
        used: Boolean(value.offer_annual_dollars || value.offer_worksite),
        source: value.offer_source,
        path: "offer_source",
        label: "offer source",
      },
      {
        used: Boolean(
          value.pay_frequency ||
          value.observed_biweekly_dollars ||
          value.deduction_description ||
          value.deduction_dollars ||
          value.deduction_date
        ),
        source: value.pay_source,
        path: "pay_source",
        label: "pay-record source",
      },
      {
        used: Boolean(
          value.current_worksite ||
          value.nonproductive_start ||
          value.nonproductive_end ||
          value.nonproductive_observed_dollars
        ),
        source: value.context_source,
        path: "context_source",
        label: "work-context source",
      },
    ];
    sourceGroups.forEach(({ used, source, path, label }) => {
      requireSource(used, source, path, label);
      if (!used && source) {
        context.addIssue({
          code: "custom",
          path: [path],
          message: `Enter a value from the ${label} group or leave its source blank.`,
        });
      }
    });
  });

type Context = { params: Promise<{ caseId: string }> };

function evidence(
  caseData: CasePayload,
  source: ManualSource,
  allowedTypes: DocumentType[],
  label: string,
  role: EvidenceRef["role"] = "observed",
): EvidenceRef {
  const document = caseData.documents.find((candidate) => candidate.id === source.document_id);
  if (!document) throw new Error("MANUAL_SOURCE_INVALID:Choose a document from this review.");
  if (!allowedTypes.includes(document.type)) {
    throw new Error(`MANUAL_SOURCE_INVALID:The selected document is not a valid source for ${label.toLowerCase()}.`);
  }
  if (document.status === "REJECTED" || document.status === "PROCESSING") {
    throw new Error("MANUAL_SOURCE_INVALID:Wait until the selected document is available for review.");
  }
  if (source.page > document.pages) {
    throw new Error(`MANUAL_SOURCE_INVALID:${document.name} has only ${document.pages} page${document.pages === 1 ? "" : "s"}.`);
  }
  return {
    id: `span_${crypto.randomUUID()}`,
    documentId: document.id,
    documentName: document.name,
    page: source.page,
    label,
    text: source.excerpt,
    role,
  };
}

function upsertFact(
  caseData: CasePayload,
  type: string,
  label: string,
  rawValue: string,
  normalizedValue: string,
  affects: FindingModule[],
  source: ManualSource,
  documentTypes: DocumentType[],
): void {
  const nextEvidence = evidence(
    caseData,
    source,
    documentTypes,
    `${label} · user transcribed`,
    type.startsWith("LCA") ? "benchmark" : "observed",
  );
  const existing = caseData.facts.find(
    (fact) => fact.type === type && fact.origin === "USER_ENTERED",
  );
  const now = new Date().toISOString();
  if (existing) {
    if (existing.rawValue !== rawValue) {
      if (caseData.corrections.length >= API_POLICY.maximumCorrectionsPerCase) {
        throw new Error("CASE_DATA_QUOTA:This review has reached its correction-history limit.");
      }
      caseData.corrections.push({
        id: `correction_${crypto.randomUUID()}`,
        factId: existing.id,
        previousValue: existing.rawValue,
        newValue: rawValue,
        createdAt: now,
      });
    }
    Object.assign(existing, {
      rawValue,
      normalizedValue,
      reviewStatus: "USER_CORRECTED" as const,
      userEditedAt: now,
      reviewedAt: now,
      evidence: nextEvidence,
    });
    return;
  }
  if (caseData.facts.length >= API_POLICY.maximumFactsPerCase) {
    throw new Error("CASE_DATA_QUOTA:This review has reached its structured-fact limit.");
  }
  const fact: FactRecord = {
    id: `fact_${crypto.randomUUID()}`,
    type,
    label,
    rawValue,
    normalizedValue,
    confidence: 1,
    reviewStatus: "USER_CORRECTED",
    affects,
    evidence: nextEvidence,
    origin: "USER_ENTERED",
    reviewedAt: now,
    userEditedAt: now,
  };
  caseData.facts.push(fact);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateOptionalDate(value: string, label: string): void {
  if (value && !validDate(value)) throw new Error(`${label} must be a real date in YYYY-MM-DD format`);
}

function requireCompleteGroup(values: string[], message: string): void {
  const count = values.filter(Boolean).length;
  if (count > 0 && count < values.length) throw new Error(message);
}

export async function POST(request: Request, context: Context) {
  const identity = await authenticateCaseRequest(request);
  if (!identity) return authenticationRequired(request);
  const guarded = mutationGuard(request);
  if (guarded) return guarded;
  try {
    const { caseId } = await context.params;
    const caseData = await getCase(caseId, identity.user.userId);
    if (!caseData) return notFound();
    if (!caseData.documents.length) {
      return errorResponse(
        "FACT_REVIEW_REQUIRED",
        "Add the supporting records before entering transcribed facts.",
        409,
      );
    }
    const body = await parseJsonBody(request);
    if (!body.ok) return body.response;
    const parsed = ManualFactsSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(
        "INVALID_REQUEST",
        "One or more reviewed facts are invalid.",
        400,
        false,
        validationDetails(parsed.error),
      );
    }
    const data = parsed.data;
    const requestedRemoval =
      data.remove_pay_period ||
      data.remove_deduction ||
      data.remove_nonproductive ||
      data.remove_worksite;
    const profileChanged =
      Boolean(data.worker_name && data.worker_name !== caseData.workerName) ||
      Boolean(data.employer_name && data.employer_name !== caseData.employerName) ||
      Boolean(data.position && data.position !== caseData.position);
    const hasStructuredEntry = [
      data.lca_annual_dollars,
      data.offer_annual_dollars,
      data.pay_frequency,
      data.observed_biweekly_dollars,
      data.pay_period_start,
      data.pay_period_end,
      data.pay_date,
      data.lca_worksite,
      data.offer_worksite,
      data.current_worksite,
      data.worksite_qualifier,
      data.deduction_description,
      data.deduction_dollars,
      data.deduction_date,
      data.nonproductive_start,
      data.nonproductive_end,
      data.employer_related_reason,
      data.worker_available,
      data.employment_active,
      data.nonproductive_observed_dollars,
    ].some(Boolean);
    if (!requestedRemoval && !profileChanged && !hasStructuredEntry) {
      return errorResponse(
        "INVALID_REQUEST",
        "Change a profile field or enter at least one reviewed value before saving.",
        400,
      );
    }
    [
      [data.pay_period_start, "Pay period start"],
      [data.pay_period_end, "Pay period end"],
      [data.pay_date, "Pay date"],
      [data.deduction_date, "Deduction date"],
      [data.nonproductive_start, "Nonproductive-time start"],
      [data.nonproductive_end, "Nonproductive-time end"],
    ].forEach(([value, label]) => validateOptionalDate(value, label));

    requireCompleteGroup(
      [data.observed_biweekly_dollars, data.pay_period_start, data.pay_period_end, data.pay_date],
      "Enter the pay amount, period start, period end, and pay date together.",
    );
    requireCompleteGroup(
      [data.deduction_description, data.deduction_dollars, data.deduction_date],
      "Enter the deduction description, amount, and date together.",
    );
    requireCompleteGroup(
      [data.nonproductive_start, data.nonproductive_end],
      "Enter both boundaries of the nonproductive-time interval.",
    );
    if (data.pay_period_start && data.pay_period_start > data.pay_period_end) {
      throw new Error("Pay period start must be on or before the end date");
    }
    if (data.nonproductive_start && data.nonproductive_start >= data.nonproductive_end) {
      throw new Error("Nonproductive-time start must be before its exclusive end date");
    }
    if (data.observed_biweekly_dollars && !data.pay_frequency) {
      throw new Error("Choose the reviewed pay frequency for the observed pay period");
    }

    let removedManualRecord = false;
    if (data.remove_pay_period) {
      const before = caseData.payPeriods.length;
      caseData.payPeriods = caseData.payPeriods.filter(
        (period) => period.evidence.label !== "User-transcribed pay period",
      );
      removedManualRecord = caseData.payPeriods.length < before;
    } else if (data.remove_deduction) {
      const before = caseData.deductions.length;
      caseData.deductions = caseData.deductions.filter(
        (deduction) => deduction.evidence.label !== "User-transcribed deduction",
      );
      removedManualRecord = caseData.deductions.length < before;
    } else if (data.remove_nonproductive) {
      const before = caseData.events.length;
      caseData.events = caseData.events.filter(
        (event) =>
          !event.evidence.some(
            (item) => item.label === "User-transcribed nonproductive interval",
          ),
      );
      removedManualRecord = caseData.events.length < before;
    } else if (data.remove_worksite) {
      const before = caseData.events.length;
      caseData.events = caseData.events.filter(
        (event) =>
          !event.evidence.some(
            (item) => item.label === "User-transcribed worksite instruction",
          ),
      );
      removedManualRecord = caseData.events.length < before;
    }
    if (requestedRemoval && !removedManualRecord) {
      return errorResponse(
        "INVALID_REQUEST",
        "That transcribed record no longer exists. Refresh the review and try again.",
        409,
        true,
      );
    }

    if (data.worker_name) caseData.workerName = data.worker_name;
    if (data.employer_name) caseData.employerName = data.employer_name;
    if (data.position) caseData.position = data.position;
    if (data.lca_annual_dollars) {
      const cents = parseDollarsToCents(data.lca_annual_dollars);
      upsertFact(
        caseData,
        "LCA_WAGE_ANNUAL_CENTS",
        "LCA-listed annual wage",
        `${formatCents(cents)} per year`,
        String(cents),
        ["WAGE_BENCHMARK", "NONPRODUCTIVE_TIME"],
        data.lca_source!,
        ["LCA_CERTIFIED"],
      );
    }
    if (data.offer_annual_dollars) {
      const cents = parseDollarsToCents(data.offer_annual_dollars);
      upsertFact(
        caseData,
        "OFFER_WAGE_ANNUAL_CENTS",
        "Offer annual base wage",
        `${formatCents(cents)} per year`,
        String(cents),
        ["WAGE_BENCHMARK"],
        data.offer_source!,
        ["OFFER_OR_EMPLOYMENT_LETTER"],
      );
    }
    if (data.pay_frequency) {
      upsertFact(
        caseData,
        "PAY_FREQUENCY",
        "Pay frequency",
        data.pay_frequency.replace("-", " ").toLowerCase(),
        data.pay_frequency,
        ["WAGE_BENCHMARK"],
        data.pay_source!,
        ["PAYSTUB"],
      );
    }
    if (data.lca_worksite) {
      upsertFact(
        caseData,
        "LCA_WORKSITE",
        "LCA worksite",
        data.lca_worksite,
        data.lca_worksite,
        ["EMPLOYMENT_FACTS"],
        data.lca_source!,
        ["LCA_CERTIFIED"],
      );
    }
    if (data.offer_worksite) {
      upsertFact(
        caseData,
        "OFFER_WORKSITE",
        "Offer worksite",
        data.offer_worksite,
        data.offer_worksite,
        ["EMPLOYMENT_FACTS"],
        data.offer_source!,
        ["OFFER_OR_EMPLOYMENT_LETTER"],
      );
    }

    if (data.observed_biweekly_dollars) {
      const cents = parseDollarsToCents(data.observed_biweekly_dollars);
      const payEvidence = evidence(
        caseData,
        data.pay_source!,
        ["PAYSTUB"],
        "User-transcribed pay period",
      );
      const existing = caseData.payPeriods.find(
        (period) => period.evidence.label === "User-transcribed pay period",
      );
      const next = {
        start: data.pay_period_start,
        end: data.pay_period_end,
        payDate: data.pay_date,
        ordinaryBaseCents: cents,
        grossCents: cents,
        complete: true,
        comparable: true,
        correctionStatus: "RESOLVED" as const,
        reviewStatus: "USER_CORRECTED" as const,
        sourceDocumentId: payEvidence.documentId,
        reviewedAt: new Date().toISOString(),
        evidence: payEvidence,
      };
      if (existing) Object.assign(existing, next);
      else {
        if (caseData.payPeriods.length >= API_POLICY.maximumPayPeriodsPerCase) {
          throw new Error("CASE_DATA_QUOTA:This review has reached its pay-period limit.");
        }
        caseData.payPeriods.push({ id: `period_${crypto.randomUUID()}`, ...next });
      }
    }

    if (data.deduction_description) {
      const amountCents = parseDollarsToCents(data.deduction_dollars);
      const relevant = /h\s*-?\s*1b|petition|filing|legal\s+fee/i.test(data.deduction_description);
      const deductionEvidence = evidence(
        caseData,
        data.pay_source!,
        ["PAYSTUB"],
        "User-transcribed deduction",
      );
      const existing = caseData.deductions.find(
        (deduction) => deduction.evidence.label === "User-transcribed deduction",
      );
      const next = {
        description: data.deduction_description,
        amountCents,
        date: data.deduction_date,
        category: relevant ? ("PETITION_OR_LEGAL_FEE_REFERENCE" as const) : ("UNKNOWN" as const),
        transactionStatus: "PAYROLL_OBSERVED" as const,
        descriptionConfidence: 1,
        reviewStatus: "USER_CORRECTED" as const,
        sourceDocumentId: deductionEvidence.documentId,
        reviewedAt: new Date().toISOString(),
        evidence: deductionEvidence,
      };
      if (existing) Object.assign(existing, next);
      else {
        if (caseData.deductions.length >= API_POLICY.maximumDeductionsPerCase) {
          throw new Error("CASE_DATA_QUOTA:This review has reached its deduction limit.");
        }
        caseData.deductions.push({ id: `deduction_${crypto.randomUUID()}`, ...next });
      }
    }

    if (data.nonproductive_start) {
      const observed = data.nonproductive_observed_dollars
        ? parseDollarsToCents(data.nonproductive_observed_dollars)
        : null;
      const eventEvidence = evidence(
        caseData,
        data.context_source!,
        [
          "WORK_MESSAGE",
          "TIMESHEET",
          "PAYSTUB",
          "OFFER_OR_EMPLOYMENT_LETTER",
          "LEAVE_NOTICE",
          "TERMINATION_NOTICE",
          "OTHER",
        ],
        "User-transcribed nonproductive interval",
        "context",
      );
      const existing = caseData.events.find(
        (event) =>
          event.kind === "NONPRODUCTIVE_TIME" &&
          event.evidence.some((item) => item.label === "User-transcribed nonproductive interval"),
      );
      const next = {
        kind: "NONPRODUCTIVE_TIME" as const,
        title: "Reviewed nonproductive-time interval",
        start: data.nonproductive_start,
        end: data.nonproductive_end,
        certainty: "CONFIRMED" as const,
        attribution: data.employer_related_reason ? ("EMPLOYER" as const) : ("UNKNOWN" as const),
        workerAvailable: data.worker_available,
        employmentActive: data.employment_active,
        voluntaryLeave: false,
        observedBaseCents: observed,
        evidence: [eventEvidence],
      };
      if (existing) Object.assign(existing, next);
      else {
        if (caseData.events.length >= API_POLICY.maximumEventsPerCase) {
          throw new Error("CASE_DATA_QUOTA:This review has reached its employment-event limit.");
        }
        caseData.events.push({ id: `event_${crypto.randomUUID()}`, ...next });
      }
    }
    if (data.current_worksite) {
      const eventEvidence = evidence(
        caseData,
        data.context_source!,
        [
          "WORK_MESSAGE",
          "TIMESHEET",
          "PAYSTUB",
          "OFFER_OR_EMPLOYMENT_LETTER",
          "LEAVE_NOTICE",
          "TERMINATION_NOTICE",
          "OTHER",
        ],
        "User-transcribed worksite instruction",
        "context",
      );
      const existing = caseData.events.find(
        (event) =>
          event.kind === "WORKSITE_CHANGE" &&
          event.evidence.some((item) => item.label === "User-transcribed worksite instruction"),
      );
      const next = {
        kind: "WORKSITE_CHANGE" as const,
        title: "Reviewed worksite instruction",
        start: caseData.reviewEnd,
        certainty: "CONFIRMED" as const,
        worksite: data.current_worksite,
        qualifier: data.worksite_qualifier ?? ("UNKNOWN" as const),
        evidence: [eventEvidence],
      };
      if (existing) Object.assign(existing, next);
      else {
        if (caseData.events.length >= API_POLICY.maximumEventsPerCase) {
          throw new Error("CASE_DATA_QUOTA:This review has reached its employment-event limit.");
        }
        caseData.events.push({ id: `event_${crypto.randomUUID()}`, ...next });
      }
    }

    const referencedDocumentIds = new Set(
      [data.lca_source, data.offer_source, data.pay_source, data.context_source]
        .filter((source): source is ManualSource => Boolean(source))
        .map((source) => source.document_id),
    );
    referencedDocumentIds.forEach((documentId) =>
      refreshDocumentReviewStatus(caseData, documentId),
    );
    invalidateDerivedResults(caseData);
    await saveCase(caseData);
    await appendAudit(
      caseData.id,
      removedManualRecord ? "MANUAL_RECORD_REMOVED" : "MANUAL_FACTS_REVIEWED",
      {
      factCount: caseData.facts.length,
      payPeriodCount: caseData.payPeriods.length,
      eventCount: caseData.events.length,
      },
    );
    return jsonResponse({ case: caseData });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("CASE_DATA_QUOTA:")) {
      return errorResponse("CASE_QUOTA_EXCEEDED", error.message.slice(16), 409);
    }
    if (error instanceof Error && error.message.startsWith("SUPPORTING_DOCUMENT_REQUIRED:")) {
      return errorResponse(
        "FACT_REVIEW_REQUIRED",
        "Add the matching supporting document before transcribing this value.",
        409,
      );
    }
    if (error instanceof Error && error.message.startsWith("MANUAL_SOURCE_INVALID:")) {
      return errorResponse("INVALID_REQUEST", error.message.slice(22), 400);
    }
    if (error instanceof Error && /dollar amount|date|Enter|Choose|start|required/i.test(error.message)) {
      return errorResponse("INVALID_REQUEST", error.message, 400);
    }
    return internalError(error);
  }
}
