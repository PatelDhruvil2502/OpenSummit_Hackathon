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
import { formatCents, parseDollarsToCents } from "@/lib/money";
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
const ManualFactsSchema = z.object({
  worker_name: z.string().trim().max(100).optional().default(""),
  employer_name: z.string().trim().max(140).optional().default(""),
  position: z.string().trim().max(120).optional().default(""),
  lca_annual_dollars: OptionalMoney,
  offer_annual_dollars: OptionalMoney,
  pay_frequency: z
    .enum(["WEEKLY", "BIWEEKLY", "SEMI-MONTHLY", "MONTHLY"])
    .optional(),
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
});

type Context = { params: Promise<{ caseId: string }> };

function documentFor(caseData: CasePayload, preferred: DocumentType[]): CasePayload["documents"][number] {
  const document = preferred
    .map((type) => caseData.documents.find((candidate) => candidate.type === type))
    .find(Boolean);
  if (!document) {
    throw new Error(`SUPPORTING_DOCUMENT_REQUIRED:${preferred[0]}`);
  }
  return document;
}

function evidence(
  caseData: CasePayload,
  preferred: DocumentType[],
  label: string,
  text: string,
  role: EvidenceRef["role"] = "observed",
): EvidenceRef {
  const document = documentFor(caseData, preferred);
  return {
    id: `span_${crypto.randomUUID()}`,
    documentId: document.id,
    documentName: document.name,
    page: 1,
    label,
    text,
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
  documentTypes: DocumentType[],
): void {
  const nextEvidence = evidence(
    caseData,
    documentTypes,
    `${label} · user transcribed`,
    rawValue,
    type.startsWith("LCA") ? "benchmark" : "observed",
  );
  const existing = caseData.facts.find(
    (fact) => fact.type === type && fact.origin === "USER_ENTERED",
  );
  const now = new Date().toISOString();
  if (existing) {
    if (existing.rawValue !== rawValue) {
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
        ["PAYSTUB", "OFFER_OR_EMPLOYMENT_LETTER"],
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
        ["OFFER_OR_EMPLOYMENT_LETTER"],
      );
    }

    if (data.observed_biweekly_dollars) {
      const cents = parseDollarsToCents(data.observed_biweekly_dollars);
      const payEvidence = evidence(
        caseData,
        ["PAYSTUB"],
        "User-transcribed pay period",
        `Regular base ${formatCents(cents)} for ${data.pay_period_start} through ${data.pay_period_end}`,
      );
      const existing = caseData.payPeriods.find(
        (period) =>
          period.start === data.pay_period_start &&
          period.end === data.pay_period_end &&
          period.reviewStatus !== "NEEDS_REVIEW",
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
      else caseData.payPeriods.push({ id: `period_${crypto.randomUUID()}`, ...next });
    }

    if (data.deduction_description) {
      const amountCents = parseDollarsToCents(data.deduction_dollars);
      const relevant = /h\s*-?\s*1b|petition|filing|legal\s+fee/i.test(data.deduction_description);
      const deductionEvidence = evidence(
        caseData,
        ["PAYSTUB", "OFFER_OR_EMPLOYMENT_LETTER"],
        "User-transcribed deduction",
        `${data.deduction_description}: -${formatCents(amountCents)}`,
      );
      const existing = caseData.deductions.find(
        (deduction) =>
          deduction.date === data.deduction_date &&
          deduction.description === data.deduction_description &&
          deduction.reviewStatus !== "NEEDS_REVIEW",
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
      else caseData.deductions.push({ id: `deduction_${crypto.randomUUID()}`, ...next });
    }

    if (data.nonproductive_start) {
      const observed = data.nonproductive_observed_dollars
        ? parseDollarsToCents(data.nonproductive_observed_dollars)
        : null;
      const eventEvidence = evidence(
        caseData,
        ["WORK_MESSAGE", "TIMESHEET", "PAYSTUB"],
        "User-transcribed nonproductive interval",
        `Reviewed interval ${data.nonproductive_start} through ${data.nonproductive_end}`,
        "context",
      );
      const existing = caseData.events.find(
        (event) => event.kind === "NONPRODUCTIVE_TIME" && event.start === data.nonproductive_start,
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
      else caseData.events.push({ id: `event_${crypto.randomUUID()}`, ...next });
    }
    if (data.current_worksite) {
      const eventEvidence = evidence(
        caseData,
        ["WORK_MESSAGE", "OFFER_OR_EMPLOYMENT_LETTER", "OTHER"],
        "User-transcribed worksite instruction",
        data.current_worksite,
        "context",
      );
      const existing = caseData.events.find(
        (event) => event.kind === "WORKSITE_CHANGE" && event.worksite === data.current_worksite,
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
      else caseData.events.push({ id: `event_${crypto.randomUUID()}`, ...next });
    }

    invalidateDerivedResults(caseData);
    await saveCase(caseData);
    await appendAudit(caseData.id, "MANUAL_FACTS_REVIEWED", {
      factCount: caseData.facts.length,
      payPeriodCount: caseData.payPeriods.length,
      eventCount: caseData.events.length,
    });
    return jsonResponse({ case: caseData });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("SUPPORTING_DOCUMENT_REQUIRED:")) {
      return errorResponse(
        "FACT_REVIEW_REQUIRED",
        "Add the matching supporting document before transcribing this value.",
        409,
      );
    }
    if (error instanceof Error && /dollar amount|date|Enter|Choose|start|required/i.test(error.message)) {
      return errorResponse("INVALID_REQUEST", error.message, 400);
    }
    return internalError(error);
  }
}
