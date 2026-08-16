import {
  aggregateExpectedCents,
  differenceExceedsTolerance,
  expectedPeriodCents,
  formatCents,
  roundDivide,
} from "./money";
import { SOURCES } from "./sources";
import type {
  CasePayload,
  DeductionObservation,
  EmploymentEvent,
  EvidenceRef,
  FactRecord,
  Finding,
  FindingModule,
  FindingStatus,
  PayPeriod,
} from "./types";
import { FINDING_RULE_VERSIONS as RULE_VERSIONS } from "./versions";

const FACT_TYPES = {
  lcaAnnualWage: [
    "LCA_WAGE_ANNUAL_CENTS",
    "LCA_WAGE_ANNUAL",
    "LCA_ANNUAL_WAGE",
    "LCA_WAGE_RATE",
    "LCA_WAGE",
  ],
  offerAnnualWage: [
    "OFFER_WAGE_ANNUAL_CENTS",
    "OFFER_WAGE_ANNUAL",
    "OFFER_ANNUAL_WAGE",
    "OFFER_BASE_WAGE",
    "OFFER_WAGE",
  ],
  payFrequency: ["PAY_FREQUENCY", "BASELINE_PAY_FREQUENCY", "PAYROLL_FREQUENCY"],
  lcaWorksite: ["LCA_WORKSITE", "LCA_WORK_LOCATION", "LCA_LOCATION"],
  offerWorksite: ["OFFER_WORKSITE", "OFFER_WORK_LOCATION", "OFFER_LOCATION"],
} as const;

const PERIODS_PER_YEAR: Record<string, number> = {
  WEEK: 52,
  WEEKLY: 52,
  BIWEEK: 26,
  BIWEEKLY: 26,
  "BI-WEEKLY": 26,
  SEMIMONTH: 24,
  SEMIMONTHLY: 24,
  "SEMI-MONTHLY": 24,
  MONTH: 12,
  MONTHLY: 12,
  YEAR: 1,
  ANNUAL: 1,
  ANNUALLY: 1,
};

type FindingInput = Omit<
  Finding,
  | "id"
  | "module"
  | "attention"
  | "source"
  | "confidence"
  | "includeInReport"
  | "disposition"
  | "ruleVersion"
> & {
  amountCents?: number;
  confidenceFacts?: FactRecord[];
  confidenceEvidenceTarget?: number;
};

function normalizeFactType(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

function factsOfType(payload: CasePayload, aliases: readonly string[]): FactRecord[] {
  const exact = new Set(aliases.map(normalizeFactType));
  return payload.facts.filter((fact) => exact.has(normalizeFactType(fact.type)));
}

function acceptedFacts(facts: FactRecord[]): FactRecord[] {
  return facts.filter((fact) => fact.reviewStatus !== "NEEDS_REVIEW");
}

function needsReviewFacts(facts: FactRecord[]): FactRecord[] {
  return facts.filter((fact) => fact.reviewStatus === "NEEDS_REVIEW");
}

function decimalDollarsToCents(value: string): number | null {
  const cleaned = value.replace(/[$,\s]/g, "");
  const match = cleaned.match(/[-+]?\d+(?:\.\d+)?/);
  if (!match) return null;

  const negative = match[0].startsWith("-");
  const unsigned = match[0].replace(/^[-+]/, "");
  const [wholePart, fractionalPart = ""] = unsigned.split(".");
  const padded = `${fractionalPart}000`;
  let cents = BigInt(wholePart) * BigInt(100) + BigInt(padded.slice(0, 2));
  if (Number(padded[2]) >= 5) cents += BigInt(1);
  if (negative) cents = -cents;

  const result = Number(cents);
  return Number.isSafeInteger(result) ? result : null;
}

function moneyFactCents(fact: FactRecord | undefined): number | null {
  if (!fact) return null;
  const source = fact.normalizedValue || fact.rawValue;
  if (!source) return null;

  if (normalizeFactType(fact.type).endsWith("_CENTS") || fact.unit?.toUpperCase() === "CENTS") {
    const integer = source.replace(/[^\d-]/g, "");
    if (!/^-?\d+$/.test(integer)) return null;
    const parsed = Number(integer);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  return decimalDollarsToCents(source);
}

function payFrequencyFactor(fact: FactRecord | undefined): number | null {
  if (!fact) return null;
  const normalized = fact.normalizedValue.trim().toUpperCase().replace(/\s+/g, "");
  if (PERIODS_PER_YEAR[normalized]) return PERIODS_PER_YEAR[normalized];

  const raw = fact.rawValue.trim().toUpperCase().replace(/\s+/g, "");
  return PERIODS_PER_YEAR[raw] ?? null;
}

function uniqueEvidence(evidence: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = `${item.documentId}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function average(values: number[], fallback: number): number {
  if (values.length === 0) return fallback;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundConfidence(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
}

function attentionFor(status: FindingStatus, amountCents?: number): Finding["attention"] {
  if (status === "POSSIBLE_DISCREPANCY") {
    return (amountCents ?? 0) >= 100_000 ? "REVIEW_NOW" : "REVIEW_SOON";
  }
  if (
    status === "HUMAN_REVIEW_REQUIRED" ||
    status === "CONFLICTING_EVIDENCE" ||
    status === "INSUFFICIENT_EVIDENCE"
  ) {
    return "CONTEXT_NEEDED";
  }
  return "INFORMATIONAL";
}

function contextConfidence(status: FindingStatus): number {
  switch (status) {
    case "NO_MISMATCH_DETECTED":
      return 0.95;
    case "POSSIBLE_DISCREPANCY":
      return 0.78;
    case "CONFLICTING_EVIDENCE":
      return 0.35;
    case "HUMAN_REVIEW_REQUIRED":
      return 0.45;
    case "INSUFFICIENT_EVIDENCE":
      return 0.2;
  }
}

function buildFinding(
  payload: CasePayload,
  module: FindingModule,
  input: FindingInput,
): Finding {
  const evidence = uniqueEvidence(input.evidence);
  const factConfidences = (input.confidenceFacts ?? []).map((fact) => fact.confidence);
  const evidenceTarget = Math.max(1, input.confidenceEvidenceTarget ?? 2);
  const amount = input.amountCents;

  return {
    id: `${payload.id}:finding:${module.toLowerCase()}`,
    module,
    status: input.status,
    attention: attentionFor(input.status, amount),
    headline: input.headline,
    summary: input.summary,
    ...(amount === undefined ? {} : { amountCents: amount }),
    ...(input.amountLabel === undefined ? {} : { amountLabel: input.amountLabel }),
    ...(input.period === undefined ? {} : { period: input.period }),
    calculation: input.calculation,
    evidence,
    source: SOURCES[module],
    assumptions: input.assumptions,
    limitations: input.limitations,
    questions: input.questions,
    confidence: {
      extraction: roundConfidence(average(factConfidences, evidence.length > 0 ? 0.95 : 0.4)),
      evidence: roundConfidence(evidence.length / evidenceTarget),
      context: contextConfidence(input.status),
    },
    diagnostics: Array.from(new Set(input.diagnostics)).sort(),
    // Reports are an explicit disclosure boundary. A finding is never selected
    // merely because a rule gave it a higher-attention status.
    includeInReport: false,
    disposition: "UNREVIEWED",
    ruleVersion: RULE_VERSIONS[module],
  };
}

function dateRange(periods: PayPeriod[]): { start: string; end: string } | undefined {
  if (periods.length === 0) return undefined;
  const starts = periods.map((period) => period.start).sort();
  const ends = periods.map((period) => period.end).sort();
  return { start: starts[0], end: ends[ends.length - 1] };
}

function periodIsComparable(period: PayPeriod): boolean {
  return (
    period.reviewStatus !== "NEEDS_REVIEW" &&
    period.complete &&
    period.comparable &&
    (period.correctionStatus === "NONE" || period.correctionStatus === "RESOLVED")
  );
}

function periodNeedsReview(period: PayPeriod): boolean {
  return period.reviewStatus === "NEEDS_REVIEW";
}

type ComparablePeriodSet = {
  periods: PayPeriod[];
  duplicates: PayPeriod[];
  conflicts: PayPeriod[][];
};

/**
 * A pay period is an interval, not a document line. The same interval can be
 * supported by more than one uploaded record, but it must only contribute once
 * to the wage arithmetic. Different reviewed base amounts for the same interval
 * are a conflict that requires a person to resolve before any total is shown.
 */
function normalizeComparablePeriods(periods: PayPeriod[]): ComparablePeriodSet {
  const byInterval = new Map<string, PayPeriod[]>();
  for (const period of periods.filter(periodIsComparable)) {
    const key = `${period.start}:${period.end}`;
    const group = byInterval.get(key) ?? [];
    group.push(period);
    byInterval.set(key, group);
  }

  const normalized: PayPeriod[] = [];
  const duplicates: PayPeriod[] = [];
  const conflicts: PayPeriod[][] = [];
  for (const group of byInterval.values()) {
    const ordered = [...group].sort(
      (left, right) =>
        left.start.localeCompare(right.start) ||
        left.end.localeCompare(right.end) ||
        left.id.localeCompare(right.id),
    );
    if (new Set(ordered.map((period) => period.ordinaryBaseCents)).size > 1) {
      conflicts.push(ordered);
      continue;
    }
    normalized.push(ordered[0]);
    duplicates.push(...ordered.slice(1));
  }

  normalized.sort(
    (left, right) =>
      left.start.localeCompare(right.start) ||
      left.end.localeCompare(right.end) ||
      left.id.localeCompare(right.id),
  );
  conflicts.sort((left, right) =>
    `${left[0]?.start}:${left[0]?.end}`.localeCompare(
      `${right[0]?.start}:${right[0]?.end}`,
    ),
  );
  return { periods: normalized, duplicates, conflicts };
}

export function runWageBenchmarkRule(payload: CasePayload): Finding {
  const allLcaFacts = factsOfType(payload, FACT_TYPES.lcaAnnualWage);
  const reviewedLcaFacts = acceptedFacts(allLcaFacts);
  const lcaValues = reviewedLcaFacts
    .map((fact) => ({ fact, cents: moneyFactCents(fact) }))
    .filter((item): item is { fact: FactRecord; cents: number } => item.cents !== null);
  const distinctLcaValues = new Set(lcaValues.map((item) => item.cents));
  const lcaEvidence = allLcaFacts.map((fact) => fact.evidence);

  if (distinctLcaValues.size > 1) {
    return buildFinding(payload, "WAGE_BENCHMARK", {
      status: "CONFLICTING_EVIDENCE",
      headline: "More than one LCA wage may apply to the reviewed period",
      summary:
        "The uploaded records contain different reviewed LCA wage amounts, and the applicable record has not been established.",
      calculation: null,
      evidence: lcaEvidence,
      assumptions: [],
      limitations: ["The rule does not choose between active LCA records without reviewed date context."],
      questions: ["Which LCA supports each pay period in this review?"],
      diagnostics: ["WAGE_LCA_MULTIPLE_ACTIVE"],
      confidenceFacts: allLcaFacts,
    });
  }

  if (lcaValues.length === 0) {
    const reviewNeeded = needsReviewFacts(allLcaFacts).length > 0;
    return buildFinding(payload, "WAGE_BENCHMARK", {
      status: reviewNeeded ? "HUMAN_REVIEW_REQUIRED" : "INSUFFICIENT_EVIDENCE",
      headline: reviewNeeded
        ? "The LCA wage needs confirmation before comparison"
        : "An applicable LCA wage is needed",
      summary: reviewNeeded
        ? "A candidate wage was extracted, but it has not been reviewed for use in the calculation."
        : "The available facts do not include a reviewed annual LCA wage for the selected period.",
      calculation: null,
      evidence: lcaEvidence,
      assumptions: [],
      limitations: ["No wage comparison is published without a reviewed benchmark."],
      questions: ["What annual wage is listed on the applicable certified LCA?"],
      diagnostics: [reviewNeeded ? "WAGE_LCA_REVIEW_REQUIRED" : "WAGE_REQUIRED_FACT_MISSING"],
      confidenceFacts: allLcaFacts,
      confidenceEvidenceTarget: 1,
    });
  }

  const payFrequencyFacts = factsOfType(payload, FACT_TYPES.payFrequency);
  const reviewedFrequency = acceptedFacts(payFrequencyFacts).find(
    (fact) => payFrequencyFactor(fact) !== null,
  );
  const periodsPerYear = payFrequencyFactor(reviewedFrequency);
  if (!periodsPerYear) {
    const reviewNeeded = needsReviewFacts(payFrequencyFacts).length > 0;
    return buildFinding(payload, "WAGE_BENCHMARK", {
      status: reviewNeeded ? "HUMAN_REVIEW_REQUIRED" : "INSUFFICIENT_EVIDENCE",
      headline: "Pay frequency must be confirmed",
      summary:
        "The annual LCA wage cannot be converted to a period benchmark without a reviewed payroll frequency.",
      calculation: null,
      evidence: [...lcaEvidence, ...payFrequencyFacts.map((fact) => fact.evidence)],
      assumptions: [],
      limitations: ["Biweekly and semimonthly payroll are not interchangeable."],
      questions: ["Is the ordinary payroll weekly, biweekly, semimonthly, monthly, or annual?"],
      diagnostics: [reviewNeeded ? "WAGE_PAY_FREQUENCY_REVIEW_REQUIRED" : "WAGE_RATE_UNIT_UNKNOWN"],
      confidenceFacts: [...allLcaFacts, ...payFrequencyFacts],
    });
  }

  const normalizedPeriods = normalizeComparablePeriods(payload.payPeriods);
  const comparablePeriods = normalizedPeriods.periods;
  const excludedPeriods = payload.payPeriods.filter((period) => !periodIsComparable(period));
  const unreviewedPeriods = payload.payPeriods.filter(periodNeedsReview);
  if (normalizedPeriods.conflicts.length > 0) {
    const conflictingPeriods = normalizedPeriods.conflicts.flat();
    return buildFinding(payload, "WAGE_BENCHMARK", {
      status: "CONFLICTING_EVIDENCE",
      headline: "Reviewed pay records disagree for the same pay period",
      summary:
        "Two or more reviewed records assign different ordinary base-pay amounts to the same period, so WageShield cannot choose an amount automatically.",
      calculation: null,
      evidence: [
        ...lcaEvidence,
        ...payFrequencyFacts.map((fact) => fact.evidence),
        ...conflictingPeriods.map((period) => period.evidence),
      ],
      assumptions: [],
      limitations: [
        "No wage total is published until the conflicting period records are reconciled.",
      ],
      questions: [
        "Is one record a corrected or superseded pay statement for the same period?",
      ],
      diagnostics: ["WAGE_PERIOD_CONFLICT"],
      confidenceFacts: [...allLcaFacts, ...payFrequencyFacts],
      confidenceEvidenceTarget: 2,
    });
  }
  if (comparablePeriods.length === 0) {
    const hasPeriodContext = payload.payPeriods.length > 0;
    const reviewNeeded = unreviewedPeriods.length > 0;
    return buildFinding(payload, "WAGE_BENCHMARK", {
      status: hasPeriodContext ? "HUMAN_REVIEW_REQUIRED" : "INSUFFICIENT_EVIDENCE",
      headline: reviewNeeded
        ? "The available pay period needs confirmation"
        : hasPeriodContext
        ? "The available pay period needs contextual review"
        : "A complete ordinary pay period is needed",
      summary: reviewNeeded
        ? "A candidate pay period was extracted, but it has not been reviewed for use in the wage calculation."
        : hasPeriodContext
        ? "The available period is partial, non-comparable, or has an unresolved correction."
        : "No complete regular pay period is available for the wage comparison.",
      calculation: null,
      evidence: [...lcaEvidence, ...payload.payPeriods.map((period) => period.evidence)],
      assumptions: [],
      limitations: ["Partial or correction-affected periods are not annualized automatically."],
      questions: ["Was the period partial, affected by leave, or corrected later?"],
      diagnostics: [
        reviewNeeded
          ? "WAGE_PERIOD_REVIEW_REQUIRED"
          : hasPeriodContext
            ? "WAGE_PERIOD_PARTIAL"
            : "WAGE_REQUIRED_FACT_MISSING",
      ],
      confidenceFacts: [...allLcaFacts, ...payFrequencyFacts],
    });
  }

  const annualCents = lcaValues[0].cents;
  const expectedPerPeriod = expectedPeriodCents(annualCents, periodsPerYear);
  const observedTotal = comparablePeriods.reduce(
    (sum, period) => sum + period.ordinaryBaseCents,
    0,
  );
  const expectedTotal = aggregateExpectedCents(
    annualCents,
    comparablePeriods.length,
    periodsPerYear,
  );
  const discrepantPeriods = comparablePeriods.filter((period) =>
    differenceExceedsTolerance(expectedPerPeriod, period.ordinaryBaseCents),
  );
  // Preserve sub-cent annual-rate precision while preventing an overpaid period from
  // cancelling a separate period's supported shortfall.
  const shortfallNumerator = discrepantPeriods.reduce((sum, period) => {
    const periodNumerator =
      BigInt(annualCents) - BigInt(period.ordinaryBaseCents) * BigInt(periodsPerYear);
    return sum + (periodNumerator > BigInt(0) ? periodNumerator : BigInt(0));
  }, BigInt(0));
  const shortfallTotal = Number(
    roundDivide(shortfallNumerator, BigInt(periodsPerYear)),
  );
  const status: FindingStatus =
    discrepantPeriods.length > 0
      ? "POSSIBLE_DISCREPANCY"
      : excludedPeriods.length > 0
        ? "HUMAN_REVIEW_REQUIRED"
        : "NO_MISMATCH_DETECTED";

  const offerFacts = acceptedFacts(factsOfType(payload, FACT_TYPES.offerAnnualWage));
  const offerFact = offerFacts.find((fact) => moneyFactCents(fact) !== null);
  const diagnostics = [
    discrepantPeriods.length > 0
      ? "WAGE_BELOW_LCA_BENCHMARK"
      : "WAGE_MATCH_WITHIN_TOLERANCE",
  ];
  if (excludedPeriods.length > 0) diagnostics.push("WAGE_PERIODS_EXCLUDED_FROM_AGGREGATE");
  if (unreviewedPeriods.length > 0) diagnostics.push("WAGE_PERIOD_REVIEW_REQUIRED");
  if (normalizedPeriods.duplicates.length > 0) {
    diagnostics.push("WAGE_DUPLICATE_PERIODS_COLLAPSED");
  }
  if (offerFact && moneyFactCents(offerFact) !== annualCents) {
    diagnostics.push("WAGE_OFFER_RATE_DIFFERS");
  }

  const statusCopy = {
    POSSIBLE_DISCREPANCY: {
      headline: "Observed ordinary base pay is below the uploaded LCA wage benchmark",
      summary: `${discrepantPeriods.length} of ${comparablePeriods.length} comparable pay periods fall below the period benchmark beyond the configured rounding tolerance.`,
    },
    HUMAN_REVIEW_REQUIRED: {
      headline: "Some pay periods need review before the wage comparison is complete",
      summary:
        "The reviewed complete periods do not show a mismatch, but one or more other periods are partial, non-comparable, or correction-affected.",
    },
    NO_MISMATCH_DETECTED: {
      headline: "No wage mismatch was detected in the reviewed periods",
      summary:
        "Observed ordinary base pay meets the uploaded LCA period benchmark within the configured comparison tolerance.",
    },
  } as const;

  return buildFinding(payload, "WAGE_BENCHMARK", {
    status,
    headline: statusCopy[status].headline,
    summary: statusCopy[status].summary,
    ...(status === "POSSIBLE_DISCREPANCY" && shortfallTotal > 0
      ? {
          amountCents: shortfallTotal,
          amountLabel: "Estimated documented base-pay difference",
        }
      : {}),
    period: dateRange(comparablePeriods),
    calculation: {
      formula: `sum of period-level shortfalls beyond tolerance using annual LCA wage ÷ ${periodsPerYear}`,
      rows: [
        { label: "LCA-listed annual wage", value: formatCents(annualCents) },
        {
          label: "Expected base per pay period",
          value: formatCents(expectedPerPeriod),
        },
        {
          label: `Expected base across ${comparablePeriods.length} period${comparablePeriods.length === 1 ? "" : "s"}`,
          value: formatCents(expectedTotal),
        },
        {
          label: "Observed ordinary base",
          value: formatCents(observedTotal),
        },
        {
          label: "Sum of period-level documented shortfalls",
          value: formatCents(shortfallTotal),
          emphasis: status === "POSSIBLE_DISCREPANCY",
        },
      ],
      method:
        "Integer-cent arithmetic with high-precision annual-rate numerators; only discrepant period shortfalls are summed, so higher pay in another period cannot offset them.",
    },
    evidence: [
      lcaValues[0].fact.evidence,
      ...(offerFact ? [offerFact.evidence] : []),
      ...comparablePeriods.map((period) => period.evidence),
      ...normalizedPeriods.duplicates.map((period) => period.evidence),
      ...excludedPeriods.map((period) => period.evidence),
    ],
    assumptions: [
      `The reviewed payroll frequency has ${periodsPerYear} periods per year.`,
      "Comparable periods are complete ordinary periods and linked corrections are already reflected once.",
    ],
    limitations: [
      "This compares worker documents with the LCA-listed rate and does not establish the employer's internal actual-wage obligation.",
      "Bonuses, overtime, reimbursements, and deductions are not treated as ordinary base earnings.",
    ],
    questions: [
      "Were any reviewed periods partial, affected by leave, or corrected in another payroll?",
      "Does another accepted LCA or wage amendment support any reviewed period?",
    ],
    diagnostics,
    confidenceFacts: [...reviewedLcaFacts, ...payFrequencyFacts, ...offerFacts],
    confidenceEvidenceTarget: 2,
  });
}

function daysBetween(start: string, endExclusive: string): number | null {
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${endExclusive}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return Math.round((endMs - startMs) / 86_400_000);
}

type NptEvaluation = {
  status: FindingStatus;
  diagnostic: string;
  event: EmploymentEvent;
  benchmarkCents?: number;
  affectedCents?: number;
  coveredDays?: number;
};

function evaluateNonproductiveEvent(
  event: EmploymentEvent,
  annualBenchmarkCents: number | null,
): NptEvaluation {
  if (event.evidence.length === 0) {
    return { status: "INSUFFICIENT_EVIDENCE", diagnostic: "NPT_EVENT_EVIDENCE_MISSING", event };
  }
  if (!event.end || event.certainty !== "CONFIRMED") {
    return { status: "HUMAN_REVIEW_REQUIRED", diagnostic: "NPT_DATE_OR_INTERVAL_UNCLEAR", event };
  }
  const coveredDays = daysBetween(event.start, event.end);
  if (!coveredDays) {
    return { status: "HUMAN_REVIEW_REQUIRED", diagnostic: "NPT_DATE_OR_INTERVAL_UNCLEAR", event };
  }
  if (event.employmentActive === null || event.employmentActive === false) {
    return {
      status: "HUMAN_REVIEW_REQUIRED",
      diagnostic: "NPT_EMPLOYMENT_NOT_CONFIRMED_ACTIVE",
      event,
      coveredDays,
    };
  }
  if (event.voluntaryLeave === true) {
    return {
      status: "NO_MISMATCH_DETECTED",
      diagnostic: "NPT_VOLUNTARY_LEAVE_SUPPORTED",
      event,
      coveredDays,
    };
  }
  if (event.observedBaseCents === null || event.observedBaseCents === undefined) {
    return {
      status: "INSUFFICIENT_EVIDENCE",
      diagnostic: "NPT_PAY_EVIDENCE_MISSING",
      event,
      coveredDays,
    };
  }

  const benchmarkCents =
    annualBenchmarkCents === null
      ? undefined
      : Number(
          roundDivide(BigInt(annualBenchmarkCents) * BigInt(coveredDays), BigInt(364)),
        );

  if (
    benchmarkCents !== undefined &&
    !differenceExceedsTolerance(benchmarkCents, event.observedBaseCents)
  ) {
    return {
      status: "NO_MISMATCH_DETECTED",
      diagnostic: "NPT_PAID",
      event,
      benchmarkCents,
      affectedCents: 0,
      coveredDays,
    };
  }
  if (event.workerAvailable !== true) {
    return {
      status: "HUMAN_REVIEW_REQUIRED",
      diagnostic: "NPT_AVAILABILITY_UNCLEAR",
      event,
      benchmarkCents,
      coveredDays,
    };
  }
  if (event.attribution !== "EMPLOYER") {
    return {
      status: "HUMAN_REVIEW_REQUIRED",
      diagnostic:
        event.attribution === "WORKER" ? "NPT_PERSONAL_REASON_REVIEW" : "NPT_REASON_AMBIGUOUS",
      event,
      benchmarkCents,
      coveredDays,
    };
  }

  return {
    status: "POSSIBLE_DISCREPANCY",
    diagnostic: "NPT_EMPLOYER_RELATED_SIGNAL",
    event,
    benchmarkCents,
    affectedCents:
      benchmarkCents === undefined
        ? undefined
        : Math.max(0, benchmarkCents - event.observedBaseCents),
    coveredDays,
  };
}

function hasOverlappingIntervals(evaluations: NptEvaluation[]): boolean {
  const intervals = evaluations
    .filter(
      (evaluation): evaluation is NptEvaluation & { event: EmploymentEvent & { end: string } } =>
        Boolean(evaluation.event.end),
    )
    .map((evaluation) => ({
      start: evaluation.event.start,
      end: evaluation.event.end,
    }))
    .sort(
      (left, right) =>
        left.start.localeCompare(right.start) || left.end.localeCompare(right.end),
    );

  let latestEnd = "";
  for (const interval of intervals) {
    // Event intervals are half-open, so one ending exactly when the next starts
    // is adjacent rather than overlapping.
    if (latestEnd && interval.start < latestEnd) return true;
    if (interval.end > latestEnd) latestEnd = interval.end;
  }
  return false;
}

export function runNonproductiveTimeRule(payload: CasePayload): Finding {
  const events = payload.events.filter((event) => event.kind === "NONPRODUCTIVE_TIME");
  const lcaFacts = acceptedFacts(factsOfType(payload, FACT_TYPES.lcaAnnualWage));
  const annualBenchmarkCents = moneyFactCents(lcaFacts[0]);

  if (events.length === 0) {
    const hasReviewedPayroll = payload.payPeriods.some(periodIsComparable);
    const hasUnreviewedPayroll = payload.payPeriods.some(periodNeedsReview);
    return buildFinding(payload, "NONPRODUCTIVE_TIME", {
      status: hasUnreviewedPayroll
        ? "HUMAN_REVIEW_REQUIRED"
        : hasReviewedPayroll
          ? "NO_MISMATCH_DETECTED"
          : "INSUFFICIENT_EVIDENCE",
      headline: hasUnreviewedPayroll
          ? "Payroll evidence needs confirmation before assessing nonproductive time"
        : hasReviewedPayroll
          ? "No employer-related unpaid interval was identified"
        : "More evidence is needed to assess nonproductive time",
      summary: hasUnreviewedPayroll
          ? "A candidate pay period exists, but it has not been reviewed and cannot support a no-signal result."
        : hasReviewedPayroll
          ? "The reviewed timeline does not contain a no-work event aligned with missing or reduced ordinary base pay."
        : "The case does not contain both an employment event and payroll evidence for the same interval.",
      calculation: null,
      evidence: payload.payPeriods.map((period) => period.evidence),
      assumptions: [],
      limitations: ["Absence of an uploaded event does not establish what occurred outside the reviewed records."],
      questions: ["Are there messages or timesheets describing any unpaid no-assignment interval?"],
      diagnostics: [
        hasUnreviewedPayroll
          ? "NPT_PAYROLL_REVIEW_REQUIRED"
          : hasReviewedPayroll
            ? "NPT_NO_SIGNAL_FOUND"
            : "NPT_EVENT_MISSING",
      ],
      confidenceFacts: lcaFacts,
    });
  }

  const evaluations = events
    .map((event) => evaluateNonproductiveEvent(event, annualBenchmarkCents))
    .sort(
      (a, b) =>
        a.event.start.localeCompare(b.event.start) || a.event.id.localeCompare(b.event.id),
    );
  const selected = evaluations[0];
  const distinctStatuses = new Set(evaluations.map((evaluation) => evaluation.status));
  const mixedEvidence = distinctStatuses.size > 1;
  const allPossible = evaluations.every(
    (evaluation) => evaluation.status === "POSSIBLE_DISCREPANCY",
  );
  const overlappingPossibleIntervals =
    allPossible && evaluations.length > 1 && hasOverlappingIntervals(evaluations);
  const status: FindingStatus =
    mixedEvidence || overlappingPossibleIntervals ? "HUMAN_REVIEW_REQUIRED" : selected.status;
  const copy: Record<FindingStatus, { headline: string; summary: string }> = {
    POSSIBLE_DISCREPANCY: {
      headline:
        "An unpaid interval may be related to an employer-side delay while employment remained active",
      summary:
        "The records align an employer-attributed no-work interval, worker availability, active employment, and missing or reduced ordinary base pay.",
    },
    HUMAN_REVIEW_REQUIRED: {
      headline: "The no-work interval needs contextual review",
      summary:
        "A relevant interval appears in the records, but availability, cause, employment boundaries, or date precision is unresolved.",
    },
    INSUFFICIENT_EVIDENCE: {
      headline: "Payroll or event evidence is missing for the no-work interval",
      summary: "The available records cannot safely align a reviewed event with ordinary base pay.",
    },
    CONFLICTING_EVIDENCE: {
      headline: "The employment timeline contains conflicting evidence",
      summary: "The event cannot be aligned safely until the conflicting employment dates are reviewed.",
    },
    NO_MISMATCH_DETECTED: {
      headline: "No employer-related unpaid interval mismatch was detected",
      summary:
        "The reviewed event was paid within tolerance or the records support a worker-requested voluntary leave context.",
    },
  };
  if (mixedEvidence) {
    copy.HUMAN_REVIEW_REQUIRED = {
      headline: "The no-work events contain mixed evidence",
      summary:
        "The reviewed intervals lead to different pay, availability, or cause outcomes and should not be collapsed into one automatic discrepancy.",
    };
  } else if (overlappingPossibleIntervals) {
    copy.HUMAN_REVIEW_REQUIRED = {
      headline: "The no-work intervals overlap and need reconciliation",
      summary:
        "More than one reviewed event covers the same calendar days, so summing them could count the same missing base pay twice.",
    };
  } else if (allPossible && evaluations.length > 1) {
    copy.POSSIBLE_DISCREPANCY = {
      headline: "Multiple unpaid intervals may be related to employer-side delays",
      summary:
        "Each reviewed interval independently aligns employer attribution, worker availability, active employment, and missing or reduced ordinary base pay.",
    };
  }

  const observed = selected.event.observedBaseCents;
  const aggregateAffected =
    allPossible &&
    !overlappingPossibleIntervals &&
    evaluations.every((evaluation) => evaluation.affectedCents !== undefined)
      ? evaluations.reduce((sum, evaluation) => sum + (evaluation.affectedCents ?? 0), 0)
      : selected.affectedCents;
  const calculation =
    mixedEvidence ||
    overlappingPossibleIntervals ||
    selected.benchmarkCents === undefined ||
    selected.coveredDays === undefined
      ? null
      : allPossible && evaluations.length > 1
        ? {
            formula: "sum of independently reviewed interval benchmarks and observed base pay",
            rows: [
              ...evaluations.map((evaluation) => ({
                label: `Potential affected base pay from ${evaluation.event.start}`,
                value: formatCents(evaluation.affectedCents ?? 0),
              })),
              {
                label: "Total potential affected base pay",
                value: formatCents(aggregateAffected ?? 0),
                emphasis: true,
              },
            ],
            method:
              "Each non-overlapping reviewed interval is calculated separately using calendar-day proration, then the interval results are summed.",
          }
      : {
          formula: `annual LCA benchmark × ${selected.coveredDays} calendar days ÷ 364`,
          rows: [
            { label: "Annual documented benchmark", value: formatCents(annualBenchmarkCents ?? 0) },
            { label: "Covered calendar days", value: String(selected.coveredDays) },
            {
              label: "Interval comparison benchmark",
              value: formatCents(selected.benchmarkCents),
            },
            {
              label: "Observed ordinary base pay",
              value: formatCents(observed ?? 0),
            },
            {
              label: "Potential affected base pay",
              value: formatCents(selected.affectedCents ?? 0),
              emphasis: status === "POSSIBLE_DISCREPANCY",
            },
          ],
          method:
            "Calendar-day proration uses the documented annual benchmark divided by 52 weeks and 7 days.",
        };

  return buildFinding(payload, "NONPRODUCTIVE_TIME", {
    status,
    headline: copy[status].headline,
    summary: copy[status].summary,
    ...(status === "POSSIBLE_DISCREPANCY" && aggregateAffected !== undefined
      ? {
          amountCents: aggregateAffected,
          amountLabel: "Potential affected base pay",
        }
      : {}),
    ...(evaluations.every((evaluation) => evaluation.event.end)
      ? {
          period: {
            start: evaluations[0].event.start,
            end: evaluations
              .map((evaluation) => evaluation.event.end as string)
              .sort()[evaluations.length - 1],
          },
        }
      : {}),
    calculation,
    evidence: events.flatMap((event) => event.evidence),
    assumptions: ["Event intervals use a half-open start-inclusive, end-exclusive convention."],
    limitations: [
      "The displayed benchmark is not damages or an amount determined to be owed.",
      "Leave, termination, later payroll corrections, and worker availability may change the interpretation.",
    ],
    questions: [
      "Was the worker ready and available throughout this interval?",
      "Was ordinary base pay provided later or through a correction?",
      "Was there a voluntary leave request or another worker-caused reason?",
    ],
    diagnostics: mixedEvidence
      ? ["NPT_EVENTS_MIXED_CONTEXT"]
      : overlappingPossibleIntervals
        ? ["NPT_EVENTS_OVERLAP"]
        : evaluations.map((evaluation) => evaluation.diagnostic),
    confidenceFacts: lcaFacts,
    confidenceEvidenceTarget: 2,
  });
}

function relevantDeductionTransaction(observation: DeductionObservation): boolean {
  return (
    observation.transactionStatus !== "CLAUSE_ONLY" &&
    observation.descriptionConfidence >= 0.9 &&
    [
      "PETITION_OR_LEGAL_FEE_REFERENCE",
      "EMPLOYER_BUSINESS_EXPENSE_REFERENCE",
      "EARLY_DEPARTURE_REFERENCE",
    ].includes(observation.category)
  );
}

function deductionObservationKey(observation: DeductionObservation): string {
  const normalizedDescription = observation.description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const normalizedEvidence = observation.evidence.text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return [
    observation.evidence.documentId,
    observation.evidence.page,
    normalizedEvidence,
    normalizedDescription,
    observation.date,
    Math.abs(observation.amountCents),
    observation.transactionStatus,
  ].join(":");
}

function uniqueDeductionObservations(
  observations: DeductionObservation[],
): DeductionObservation[] {
  const seenIds = new Set<string>();
  const seenContent = new Set<string>();
  return observations.filter((observation) => {
    const contentKey = deductionObservationKey(observation);
    if (seenIds.has(observation.id) || seenContent.has(contentKey)) return false;
    seenIds.add(observation.id);
    seenContent.add(contentKey);
    return true;
  });
}

export function runDeductionsAndFeesRule(payload: CasePayload): Finding {
  const unreviewedObservations = payload.deductions.filter(
    (observation) => observation.reviewStatus === "NEEDS_REVIEW",
  );
  const eligibleObservations = payload.deductions.filter(
    (observation) => observation.reviewStatus !== "NEEDS_REVIEW",
  );
  const observations = uniqueDeductionObservations(eligibleObservations);
  const duplicatesCollapsed = eligibleObservations.length - observations.length;
  if (observations.length === 0) {
    const hasReviewedPayroll = payload.payPeriods.some(periodIsComparable);
    const hasUnreviewedPayroll = payload.payPeriods.some(periodNeedsReview);
    const reviewNeeded = unreviewedObservations.length > 0;
    return buildFinding(payload, "DEDUCTIONS_FEES", {
      status: reviewNeeded || hasUnreviewedPayroll
        ? "HUMAN_REVIEW_REQUIRED"
        : hasReviewedPayroll
          ? "NO_MISMATCH_DETECTED"
          : "INSUFFICIENT_EVIDENCE",
      headline: reviewNeeded
        ? "A deduction candidate needs confirmation"
        : hasUnreviewedPayroll
          ? "Payroll evidence needs confirmation before assessing deductions"
          : hasReviewedPayroll
        ? "No relevant fee or deduction signal was identified"
        : "Deduction evidence is needed",
      summary: reviewNeeded
        ? "A candidate transaction was extracted, but it has not been reviewed and is not used as evidence for an automatic finding."
        : hasUnreviewedPayroll
          ? "Candidate payroll evidence exists, but it has not been reviewed and cannot support a no-signal result."
          : hasReviewedPayroll
        ? "The reviewed payroll records do not contain a deduction or payment request mapped to a configured H-1B fee category."
        : "No reviewed payroll transaction, direct request, or repayment clause is available for this module.",
      calculation: null,
      evidence: reviewNeeded
        ? unreviewedObservations.map((observation) => observation.evidence)
        : payload.payPeriods.map((period) => period.evidence),
      assumptions: [],
      limitations: ["The rule assesses only uploaded transactions, requests, and clauses."],
      questions: ["Were any work-related fees paid outside payroll?"],
      diagnostics: [
        reviewNeeded
          ? "DEDUCTION_REVIEW_REQUIRED"
          : hasUnreviewedPayroll
            ? "DEDUCTION_PAYROLL_REVIEW_REQUIRED"
            : hasReviewedPayroll
              ? "DEDUCTION_NO_RELEVANT_INPUT"
              : "DEDUCTION_INPUT_MISSING",
      ],
    });
  }

  const possible = observations.filter(relevantDeductionTransaction);
  const clauseOnly = observations.filter((item) => item.transactionStatus === "CLAUSE_ONLY");
  const unclear = observations.filter(
    (item) => item.descriptionConfidence < 0.75 || item.category === "UNKNOWN",
  );
  const contextual = observations.filter(
    (item) =>
      item.category === "TRAINING_OR_RELOCATION_REFERENCE" ||
      (item.descriptionConfidence >= 0.75 &&
        item.descriptionConfidence < 0.9 &&
        [
          "PETITION_OR_LEGAL_FEE_REFERENCE",
          "EMPLOYER_BUSINESS_EXPENSE_REFERENCE",
          "EARLY_DEPARTURE_REFERENCE",
        ].includes(item.category)),
  );
  const routine = observations.filter(
    (item) => item.category === "ORDINARY_TAX_OR_BENEFIT_DEDUCTION",
  );

  let status: FindingStatus;
  let diagnostic: string;
  if (possible.length > 0) {
    status = "POSSIBLE_DISCREPANCY";
    diagnostic = "DEDUCTION_OFFICIAL_GUIDANCE_CATEGORY";
  } else if (clauseOnly.length > 0) {
    status = "HUMAN_REVIEW_REQUIRED";
    diagnostic = "DEDUCTION_CLAUSE_NOT_TRANSACTION";
  } else if (unclear.length > 0) {
    status = "INSUFFICIENT_EVIDENCE";
    diagnostic = "DEDUCTION_DESCRIPTION_UNCLEAR";
  } else if (contextual.length > 0) {
    status = "HUMAN_REVIEW_REQUIRED";
    diagnostic = "DEDUCTION_CONTEXT_REQUIRED";
  } else if (routine.length === observations.length) {
    status = "NO_MISMATCH_DETECTED";
    diagnostic = "DEDUCTION_ROUTINE_CATEGORY";
  } else {
    status = "HUMAN_REVIEW_REQUIRED";
    diagnostic = "DEDUCTION_CONTEXT_REQUIRED";
  }

  if (unreviewedObservations.length > 0 && status === "NO_MISMATCH_DETECTED") {
    status = "HUMAN_REVIEW_REQUIRED";
    diagnostic = "DEDUCTION_REVIEW_REQUIRED";
  }

  const possibleAmount = possible.reduce(
    (sum, observation) => sum + Math.abs(observation.amountCents),
    0,
  );
  const copy: Record<FindingStatus, { headline: string; summary: string }> = {
    POSSIBLE_DISCREPANCY: {
      headline:
        possible.length === 1
          ? `A ${formatCents(Math.abs(possible[0].amountCents))} transaction references an H-1B-related fee category`
          : "Transactions reference H-1B-related fee categories",
      summary:
        "The records contain an observed payroll deduction or direct payment request whose label matches a configured official-guidance category.",
    },
    HUMAN_REVIEW_REQUIRED: {
      headline: "A fee or repayment item needs contextual review",
      summary:
        "The uploaded language is a clause or context-sensitive category and does not by itself establish that a payment occurred.",
    },
    INSUFFICIENT_EVIDENCE: {
      headline: "A deduction description needs clarification",
      summary:
        "The transaction label or category is too ambiguous to map safely to a configured fee category.",
    },
    CONFLICTING_EVIDENCE: {
      headline: "Fee records conflict",
      summary: "The amount or trigger differs across the uploaded records.",
    },
    NO_MISMATCH_DETECTED: {
      headline: "No relevant fee mismatch was detected",
      summary:
        "The reviewed items are supported ordinary tax or benefit deductions and do not produce a configured fee signal.",
    },
  };

  return buildFinding(payload, "DEDUCTIONS_FEES", {
    status,
    headline: copy[status].headline,
    summary: copy[status].summary,
    ...(status === "POSSIBLE_DISCREPANCY"
      ? { amountCents: possibleAmount, amountLabel: "Observed transaction amount" }
      : {}),
    calculation:
      possible.length === 0
        ? null
        : {
            formula: "sum of distinct observed candidate transactions",
            rows: [
              ...possible.map((observation) => ({
                label: `${observation.date} — ${observation.description}`,
                value: formatCents(Math.abs(observation.amountCents)),
              })),
              {
                label: "Total observed candidate amount",
                value: formatCents(possibleAmount),
                emphasis: true,
              },
            ],
            method:
              "Source deductions are normalized to positive magnitudes and deduplicated by observation identifier or matching source evidence, date, description, and amount.",
          },
    evidence: observations.map((observation) => observation.evidence),
    assumptions: ["A direct payment request is shown separately from a completed payroll transaction."],
    limitations: [
      "A transaction label does not establish authorization, beneficiary, reimbursement, or final characterization.",
      "Contract language is not treated as proof that money changed hands.",
    ],
    questions: [
      "What exact service or fee did the amount cover?",
      "Was the amount deducted, paid separately, or only described in a clause?",
      "Was any amount later reimbursed?",
    ],
    diagnostics: [
      diagnostic,
      ...(duplicatesCollapsed > 0 ? ["DEDUCTION_DUPLICATES_COLLAPSED"] : []),
      ...(unreviewedObservations.length > 0
        ? ["DEDUCTION_CANDIDATES_EXCLUDED_PENDING_REVIEW"]
        : []),
    ],
    confidenceEvidenceTarget: status === "POSSIBLE_DISCREPANCY" ? 1 : 2,
  });
}

const STATE_ABBREVIATIONS: Record<string, string> = {
  alabama: "al",
  alaska: "ak",
  arizona: "az",
  arkansas: "ar",
  california: "ca",
  colorado: "co",
  connecticut: "ct",
  delaware: "de",
  "district of columbia": "dc",
  florida: "fl",
  georgia: "ga",
  hawaii: "hi",
  idaho: "id",
  illinois: "il",
  indiana: "in",
  iowa: "ia",
  kansas: "ks",
  kentucky: "ky",
  louisiana: "la",
  maine: "me",
  maryland: "md",
  massachusetts: "ma",
  michigan: "mi",
  minnesota: "mn",
  mississippi: "ms",
  missouri: "mo",
  montana: "mt",
  nebraska: "ne",
  nevada: "nv",
  "new hampshire": "nh",
  "new jersey": "nj",
  "new mexico": "nm",
  "new york": "ny",
  "north carolina": "nc",
  "north dakota": "nd",
  ohio: "oh",
  oklahoma: "ok",
  oregon: "or",
  pennsylvania: "pa",
  "rhode island": "ri",
  "south carolina": "sc",
  "south dakota": "sd",
  tennessee: "tn",
  texas: "tx",
  utah: "ut",
  vermont: "vt",
  virginia: "va",
  washington: "wa",
  "west virginia": "wv",
  wisconsin: "wi",
  wyoming: "wy",
};

const STATE_ALIASES = [
  ...Object.entries(STATE_ABBREVIATIONS),
  ...Array.from(new Set(Object.values(STATE_ABBREVIATIONS)), (code) => [code, code] as const),
  ["d c", "dc"] as const,
].sort(([left], [right]) => right.length - left.length);

function cleanLocationPart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function trailingCityAndState(
  value: string,
): { city: string; state: string } | null {
  const normalized = cleanLocationPart(value);
  for (const [alias, state] of STATE_ALIASES) {
    if (normalized === alias) return { city: "", state };
    if (normalized.endsWith(` ${alias}`)) {
      const city = normalized.slice(0, -(alias.length + 1)).trim();
      if (city) return { city, state };
    }
  }
  return null;
}

function normalizeWorksite(value: string): string {
  const prepared = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bd\s*\.?\s*c\.?\b/g, "dc")
    .replace(/\b(?:united states(?: of america)?|usa|u\.?s\.?)\b/g, " ")
    .replace(/\b\d{5}(?:-\d{4})?\b/g, " ");
  const segments = prepared
    .split(/[,;\n]+/)
    .map(cleanLocationPart)
    .filter(Boolean);
  const last = segments.at(-1) ?? "";
  const trailing = trailingCityAndState(last);

  if (trailing?.city) {
    // A comma-delimited "city state" tail is independent of any earlier street
    // address segment, so compare only the material city/state pair.
    return `${trailing.city} ${trailing.state}`;
  }
  if (trailing && segments.length >= 2) {
    const city = segments.at(-2) ?? "";
    if (city) return `${city} ${trailing.state}`;
  }

  // For non-address prose or non-U.S. locations, retain conservative exact
  // normalization. We deliberately do not fuzzy-collapse unknown places.
  return cleanLocationPart(prepared);
}

function eventDurationDays(event: EmploymentEvent): number | null {
  return event.end ? daysBetween(event.start, event.end) : null;
}

type WorksiteEvaluation = {
  status: FindingStatus;
  diagnostic: string;
  observedLocation: string;
  event?: EmploymentEvent;
  stableKey: string;
};

const WORKSITE_STATUS_RANK: Record<FindingStatus, number> = {
  POSSIBLE_DISCREPANCY: 5,
  CONFLICTING_EVIDENCE: 4,
  HUMAN_REVIEW_REQUIRED: 3,
  INSUFFICIENT_EVIDENCE: 2,
  NO_MISMATCH_DETECTED: 1,
};

function evaluateWorksiteEvent(
  event: EmploymentEvent,
  baseline: string,
): WorksiteEvaluation {
  const stableKey = `${event.start}:${event.id}`;
  if (!event.worksite || event.certainty !== "CONFIRMED") {
    return {
      status: "HUMAN_REVIEW_REQUIRED",
      diagnostic: "WORKSITE_DATE_OR_LOCATION_UNCLEAR",
      observedLocation: event.worksite ?? "Location not supplied",
      event,
      stableKey,
    };
  }
  if (normalizeWorksite(event.worksite) === baseline) {
    return {
      status: "NO_MISMATCH_DETECTED",
      diagnostic: "WORKSITE_CONSISTENT",
      observedLocation: event.worksite,
      event,
      stableKey,
    };
  }

  const durationDays = eventDurationDays(event);
  if (
    event.qualifier === "TEMPORARY" &&
    durationDays !== null &&
    durationDays <= 2
  ) {
    return {
      status: "NO_MISMATCH_DETECTED",
      diagnostic: "WORKSITE_SHORT_TRAVEL_CONTEXT",
      observedLocation: event.worksite,
      event,
      stableKey,
    };
  }
  if (
    event.qualifier === "TEMPORARY" ||
    event.qualifier === "REMOTE" ||
    event.qualifier === "UNKNOWN" ||
    event.qualifier === undefined
  ) {
    return {
      status: "HUMAN_REVIEW_REQUIRED",
      diagnostic: "WORKSITE_CONTEXT_REQUIRED",
      observedLocation: event.worksite,
      event,
      stableKey,
    };
  }
  return {
    status: "POSSIBLE_DISCREPANCY",
    diagnostic: "WORKSITE_DOCUMENT_CONFLICT",
    observedLocation: event.worksite,
    event,
    stableKey,
  };
}

export function runEmploymentFactConsistencyRule(payload: CasePayload): Finding {
  const allLcaWorksites = factsOfType(payload, FACT_TYPES.lcaWorksite);
  const allOfferWorksites = factsOfType(payload, FACT_TYPES.offerWorksite);
  const lcaWorksites = acceptedFacts(allLcaWorksites);
  const offerWorksites = acceptedFacts(allOfferWorksites);
  const worksiteEvents = payload.events.filter((event) => event.kind === "WORKSITE_CHANGE");
  const factEvidence = [...allLcaWorksites, ...allOfferWorksites].map((fact) => fact.evidence);
  const eventEvidence = worksiteEvents.flatMap((event) => event.evidence);
  const evidence = [...factEvidence, ...eventEvidence];

  const baselineFact = lcaWorksites[0] ?? offerWorksites[0];
  if (!baselineFact) {
    const hasUnreviewed =
      needsReviewFacts([...allLcaWorksites, ...allOfferWorksites]).length > 0;
    return buildFinding(payload, "EMPLOYMENT_FACTS", {
      status: hasUnreviewed ? "HUMAN_REVIEW_REQUIRED" : "INSUFFICIENT_EVIDENCE",
      headline: hasUnreviewed
        ? "The documented worksite needs confirmation"
        : "A documented worksite is needed",
      summary: hasUnreviewed
        ? "A worksite candidate exists but has not been reviewed for cross-document comparison."
        : "The available facts do not include a reviewed LCA or offer worksite.",
      calculation: null,
      evidence,
      assumptions: [],
      limitations: ["The rule does not infer a worksite from employer or worker identity."],
      questions: ["What city and state are listed on the applicable LCA?"],
      diagnostics: [hasUnreviewed ? "WORKSITE_REVIEW_REQUIRED" : "WORKSITE_TOO_FEW_SOURCES"],
      confidenceFacts: [...allLcaWorksites, ...allOfferWorksites],
    });
  }

  const baseline = normalizeWorksite(baselineFact.normalizedValue || baselineFact.rawValue);
  const confirmedFactLocations = [...lcaWorksites, ...offerWorksites]
    .map((fact) => normalizeWorksite(fact.normalizedValue || fact.rawValue))
    .filter(Boolean);
  const distinctFactLocations = new Set(confirmedFactLocations);
  const evaluations: WorksiteEvaluation[] = worksiteEvents.map((event) =>
    evaluateWorksiteEvent(event, baseline),
  );
  const baselineDisplay = baselineFact.rawValue || baselineFact.normalizedValue;

  if (distinctFactLocations.size > 1) {
    const conflictingFact = [...lcaWorksites, ...offerWorksites].find(
      (fact) => normalizeWorksite(fact.normalizedValue || fact.rawValue) !== baseline,
    );
    evaluations.push({
      status: "POSSIBLE_DISCREPANCY",
      diagnostic: "WORKSITE_DOCUMENT_CONFLICT",
      observedLocation:
        conflictingFact?.rawValue || conflictingFact?.normalizedValue || baselineDisplay,
      stableKey: "0000:document-conflict",
    });
  } else if (confirmedFactLocations.length >= 2) {
    evaluations.push({
      status: "NO_MISMATCH_DETECTED",
      diagnostic: "WORKSITE_CONSISTENT",
      observedLocation: baselineDisplay,
      stableKey: "0000:document-match",
    });
  }

  if (worksiteEvents.length === 0 && confirmedFactLocations.length < 2) {
    evaluations.push({
      status: "INSUFFICIENT_EVIDENCE",
      diagnostic: "WORKSITE_TOO_FEW_SOURCES",
      observedLocation: baselineDisplay,
      stableKey: "0000:too-few-sources",
    });
  }
  if (needsReviewFacts([...allLcaWorksites, ...allOfferWorksites]).length > 0) {
    evaluations.push({
      status: "HUMAN_REVIEW_REQUIRED",
      diagnostic: "WORKSITE_REVIEW_REQUIRED",
      observedLocation: baselineDisplay,
      stableKey: "0000:unreviewed-fact",
    });
  }

  evaluations.sort(
    (left, right) =>
      WORKSITE_STATUS_RANK[right.status] - WORKSITE_STATUS_RANK[left.status] ||
      left.stableKey.localeCompare(right.stableKey),
  );
  const selected = evaluations[0];
  const status = selected.status;
  const diagnostic = selected.diagnostic;
  const observedLocation = selected.observedLocation;
  const selectedEvent = selected.event;

  const copy: Record<FindingStatus, { headline: string; summary: string }> = {
    POSSIBLE_DISCREPANCY: {
      headline: "Uploaded records identify different ongoing work locations",
      summary:
        "The normalized worksite locations differ and the reviewed records describe the alternate location as ongoing.",
    },
    HUMAN_REVIEW_REQUIRED: {
      headline: "Uploaded records identify different work locations",
      summary:
        "The worksite locations differ, but temporary, remote, travel, date, or duration context prevents an automatic mismatch result.",
    },
    INSUFFICIENT_EVIDENCE: {
      headline: "Another worksite source is needed",
      summary: "Fewer than two compatible reviewed worksite sources are available for comparison.",
    },
    CONFLICTING_EVIDENCE: {
      headline: "The worksite records conflict",
      summary: "The available records disagree and their effective periods cannot be resolved.",
    },
    NO_MISMATCH_DETECTED: {
      headline: "No persistent worksite mismatch was detected",
      summary:
        diagnostic === "WORKSITE_SHORT_TRAVEL_CONTEXT"
          ? "The alternate location is documented as a short, confirmed trip with a bounded duration."
          : "The reviewed LCA, offer, and worksite records normalize to the same location.",
    },
  };

  return buildFinding(payload, "EMPLOYMENT_FACTS", {
    status,
    headline: copy[status].headline,
    summary: copy[status].summary,
    period:
      selectedEvent?.end === undefined
        ? undefined
        : { start: selectedEvent.start, end: selectedEvent.end },
    calculation: {
      formula: "normalized city/state comparison",
      rows: [
        {
          label: "LCA or baseline worksite",
          value: baselineFact.rawValue || baselineFact.normalizedValue,
        },
        { label: "Compared worksite", value: observedLocation },
        {
          label: "Duration qualifier",
          value: selectedEvent?.qualifier ?? "Not supplied",
        },
      ],
      method:
        "Case-insensitive city/state normalization across U.S. state names and abbreviations; ZIP formatting is ignored when city/state already align, with no fuzzy entity collapse.",
    },
    evidence,
    assumptions: ["The compared records refer to the same worker and petitioning employer."],
    limitations: [
      "This comparison does not determine geographic-area rules or whether another filing was required.",
      "Temporary travel, remote work, duration, and another LCA or amendment may change the interpretation.",
    ],
    questions: [
      "Is the alternate assignment temporary, and what is its expected duration?",
      "Is another relevant LCA or amendment available?",
      "Is remote work authorized?",
    ],
    diagnostics: [diagnostic],
    confidenceFacts: [...allLcaWorksites, ...allOfferWorksites],
    confidenceEvidenceTarget: 2,
  });
}

export function runAllRules(payload: CasePayload): Finding[] {
  return [
    runWageBenchmarkRule(payload),
    runNonproductiveTimeRule(payload),
    runDeductionsAndFeesRule(payload),
    runEmploymentFactConsistencyRule(payload),
  ];
}

// Concise aliases are convenient for callers and preserve explicit exported rule entry points.
export const runWageRule = runWageBenchmarkRule;
export const runDeductionRule = runDeductionsAndFeesRule;
export const runEmploymentFactsRule = runEmploymentFactConsistencyRule;
