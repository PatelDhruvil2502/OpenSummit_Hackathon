import assert from "node:assert/strict";
import test from "node:test";

import {
  runAllRules,
  runDeductionsAndFeesRule,
  runEmploymentFactConsistencyRule,
  runNonproductiveTimeRule,
  runWageBenchmarkRule,
} from "./rules";
import { createFixtureCase } from "./fixtures";
import type {
  CasePayload,
  DeductionObservation,
  EmploymentEvent,
  EvidenceRef,
  FactRecord,
  FindingModule,
  PayPeriod,
  Scenario,
} from "./types";

function evidence(
  id: string,
  label: string,
  text: string,
  role: EvidenceRef["role"] = "context",
): EvidenceRef {
  return {
    id,
    documentId: `doc-${id}`,
    documentName: `${id}.pdf`,
    page: 1,
    label,
    text,
    role,
  };
}

function fact(
  type: string,
  normalizedValue: string,
  affects: FindingModule[],
  reviewStatus: FactRecord["reviewStatus"] = "CONFIRMED",
): FactRecord {
  return {
    id: `fact-${type.toLowerCase()}`,
    type,
    label: type
      .toLowerCase()
      .split("_")
      .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
      .join(" "),
    rawValue: normalizedValue,
    normalizedValue,
    confidence: reviewStatus === "NEEDS_REVIEW" ? 0.72 : 0.99,
    reviewStatus,
    affects,
    evidence: evidence(`span-${type.toLowerCase()}`, type, normalizedValue, "benchmark"),
  };
}

function payPeriod(
  id: string,
  start: string,
  end: string,
  ordinaryBaseCents: number,
  overrides: Partial<PayPeriod> = {},
): PayPeriod {
  return {
    id,
    start,
    end,
    payDate: end,
    ordinaryBaseCents,
    grossCents: ordinaryBaseCents,
    complete: true,
    comparable: true,
    correctionStatus: "NONE",
    evidence: evidence(`span-${id}`, "Regular salary/base", String(ordinaryBaseCents), "observed"),
    ...overrides,
  };
}

function baseCase(scenario: Scenario): CasePayload {
  return {
    id: `case-${scenario}`,
    ownerUserId: "user-test",
    mode: "SANDBOX",
    scenario,
    title: `${scenario} fixture`,
    workerName: "Arjun Mehta",
    employerName: "Northstar Data Systems LLC",
    position: "Data Engineer",
    reviewStart: "2026-02-02",
    reviewEnd: "2026-06-30",
    state: "READY_FOR_ANALYSIS",
    stateVersion: 1,
    consentVersion: "consent.v1",
    authorizedUseConfirmed: true,
    retentionHours: 24,
    retentionExpiresAt: "2026-08-16T00:00:00Z",
    createdAt: "2026-08-15T00:00:00Z",
    updatedAt: "2026-08-15T00:00:00Z",
    ruleSetVersion: "wageshield.rules.1.1.0",
    sourceCorpusVersion: "h1b_sources.2026-08-15",
    documents: [],
    facts: [],
    payPeriods: [],
    deductions: [],
    events: [],
    findings: [],
    corrections: [],
  };
}

function standardFacts(): FactRecord[] {
  return [
    fact("LCA_WAGE_ANNUAL", "120000.00", ["WAGE_BENCHMARK", "NONPRODUCTIVE_TIME"]),
    fact("OFFER_WAGE_ANNUAL", "120000.00", ["WAGE_BENCHMARK"]),
    fact("PAY_FREQUENCY", "BIWEEKLY", ["WAGE_BENCHMARK"]),
    fact("LCA_WORKSITE", "Indianapolis, Indiana", ["EMPLOYMENT_FACTS"]),
    fact("OFFER_WORKSITE", "Indianapolis, IN", ["EMPLOYMENT_FACTS"]),
  ];
}

function heroCase(): CasePayload {
  const payload = baseCase("hero");
  payload.facts = standardFacts();
  payload.payPeriods = [
    payPeriod("pay-1", "2026-02-02", "2026-02-16", 376_923),
    payPeriod("pay-2", "2026-02-16", "2026-03-02", 376_923),
    payPeriod("pay-3", "2026-03-02", "2026-03-16", 376_923),
    payPeriod("pay-4", "2026-03-16", "2026-03-30", 376_923),
    payPeriod("pay-5", "2026-03-30", "2026-04-13", 376_923),
    payPeriod("pay-6", "2026-04-13", "2026-04-27", 376_923),
  ];
  payload.deductions = [
    {
      id: "deduction-h1b-fee",
      description: "H-1B filing/legal fee recovery",
      amountCents: -150_000,
      date: "2026-05-29",
      category: "PETITION_OR_LEGAL_FEE_REFERENCE",
      transactionStatus: "PAYROLL_OBSERVED",
      descriptionConfidence: 0.99,
      evidence: evidence(
        "span-deduction-h1b-fee",
        "Payroll deduction",
        "H-1B filing/legal fee recovery -$1,500.00",
        "observed",
      ),
    },
  ];
  payload.events = [
    {
      id: "event-project-delay",
      kind: "NONPRODUCTIVE_TIME",
      title: "Project delay",
      start: "2026-05-04",
      end: "2026-05-18",
      certainty: "CONFIRMED",
      attribution: "EMPLOYER",
      workerAvailable: true,
      employmentActive: true,
      voluntaryLeave: false,
      observedBaseCents: 0,
      evidence: [
        evidence(
          "span-project-delay",
          "Employer message",
          "Remain available and do not submit hours.",
          "context",
        ),
        evidence("span-project-delay-pay", "Ordinary base", "$0.00", "observed"),
      ],
    },
    {
      id: "event-worksite",
      kind: "WORKSITE_CHANGE",
      title: "Columbus client site",
      start: "2026-06-01",
      certainty: "CONFIRMED",
      worksite: "Columbus, Ohio",
      qualifier: "UNKNOWN",
      evidence: [
        evidence(
          "span-worksite-message",
          "Worksite instruction",
          "Report to the Columbus client site until further notice.",
          "contradiction",
        ),
      ],
    },
  ];
  return payload;
}

function cleanCase(): CasePayload {
  const payload = baseCase("clean");
  payload.facts = standardFacts();
  payload.payPeriods = [
    payPeriod("clean-pay-1", "2026-04-04", "2026-04-18", 461_538),
    payPeriod("clean-pay-2", "2026-04-18", "2026-05-02", 461_538),
  ];
  payload.deductions = [
    {
      id: "clean-benefit",
      description: "Employee elected health premium",
      amountCents: -12_500,
      date: "2026-05-02",
      category: "ORDINARY_TAX_OR_BENEFIT_DEDUCTION",
      transactionStatus: "PAYROLL_OBSERVED",
      descriptionConfidence: 0.99,
      evidence: evidence("span-clean-benefit", "Benefit deduction", "Health premium", "observed"),
    },
  ];
  payload.events = [
    {
      id: "clean-travel",
      kind: "WORKSITE_CHANGE",
      title: "One-day client visit",
      start: "2026-06-01",
      end: "2026-06-02",
      certainty: "CONFIRMED",
      worksite: "Columbus, Ohio",
      qualifier: "TEMPORARY",
      evidence: [
        evidence(
          "span-clean-travel",
          "Travel instruction",
          "Visit Columbus for one day and return to Indianapolis.",
          "context",
        ),
      ],
    },
  ];
  return payload;
}

function ambiguousCase(): CasePayload {
  const payload = baseCase("ambiguous");
  payload.facts = standardFacts();
  payload.payPeriods = [
    payPeriod("ambiguous-pay", "2026-02-02", "2026-02-16", 180_000, {
      complete: false,
      comparable: false,
      correctionStatus: "UNKNOWN",
    }),
  ];
  payload.deductions = [
    {
      id: "ambiguous-deduction",
      description: "Code 401",
      amountCents: -40_000,
      date: "2026-02-16",
      category: "UNKNOWN",
      transactionStatus: "PAYROLL_OBSERVED",
      descriptionConfidence: 0.42,
      evidence: evidence("span-ambiguous-deduction", "Deduction code", "401", "observed"),
    },
  ];
  payload.events = [
    {
      id: "ambiguous-npt",
      kind: "NONPRODUCTIVE_TIME",
      title: "Undated no-assignment screenshot",
      start: "2026-05-04",
      certainty: "UNKNOWN",
      attribution: "UNKNOWN",
      workerAvailable: null,
      employmentActive: null,
      voluntaryLeave: null,
      observedBaseCents: null,
      evidence: [
        evidence("span-ambiguous-npt", "Message", "Wait for an assignment.", "context"),
      ],
    },
    {
      id: "ambiguous-worksite",
      kind: "WORKSITE_CHANGE",
      title: "Remote work language",
      start: "2026-06-01",
      certainty: "APPROXIMATE",
      worksite: "Remote, Ohio",
      qualifier: "REMOTE",
      evidence: [
        evidence("span-ambiguous-worksite", "Remote work", "Work remotely for now.", "context"),
      ],
    },
  ];
  return payload;
}

test("hero produces three possible discrepancies and one worksite review", () => {
  const findings = runAllRules(heroCase());
  assert.equal(findings.length, 4);
  assert.deepEqual(
    Object.fromEntries(findings.map((finding) => [finding.module, finding.status])),
    {
      WAGE_BENCHMARK: "POSSIBLE_DISCREPANCY",
      NONPRODUCTIVE_TIME: "POSSIBLE_DISCREPANCY",
      DEDUCTIONS_FEES: "POSSIBLE_DISCREPANCY",
      EMPLOYMENT_FACTS: "HUMAN_REVIEW_REQUIRED",
    },
  );

  assert.equal(findings.find((item) => item.module === "WAGE_BENCHMARK")?.amountCents, 507_693);
  assert.equal(
    findings.find((item) => item.module === "NONPRODUCTIVE_TIME")?.amountCents,
    461_538,
  );
  assert.equal(findings.find((item) => item.module === "DEDUCTIONS_FEES")?.amountCents, 150_000);
});

test("clean companion returns no mismatch in every module", () => {
  const findings = runAllRules(cleanCase());
  assert.equal(findings.length, 4);
  assert.ok(findings.every((finding) => finding.status === "NO_MISMATCH_DETECTED"));
});

test("ambiguous companion abstains instead of producing a possible discrepancy", () => {
  const findings = runAllRules(ambiguousCase());
  assert.ok(findings.every((finding) => finding.status !== "POSSIBLE_DISCREPANCY"));
  assert.deepEqual(
    Object.fromEntries(findings.map((finding) => [finding.module, finding.status])),
    {
      WAGE_BENCHMARK: "HUMAN_REVIEW_REQUIRED",
      NONPRODUCTIVE_TIME: "HUMAN_REVIEW_REQUIRED",
      DEDUCTIONS_FEES: "INSUFFICIENT_EVIDENCE",
      EMPLOYMENT_FACTS: "HUMAN_REVIEW_REQUIRED",
    },
  );
});

test("wage aggregation rounds once and preserves the exact six-period fixture total", () => {
  const finding = runWageBenchmarkRule(heroCase());
  assert.equal(finding.amountCents, 507_693);
  assert.equal(
    finding.calculation?.rows.find(
      (row) => row.label === "Sum of period-level documented shortfalls",
    )
      ?.value,
    "$5,076.93",
  );
});

test("a repayment clause alone is routed to human review", () => {
  const payload = cleanCase();
  const clause: DeductionObservation = {
    id: "clause-only",
    description: "$5,000 early-departure clause",
    amountCents: 500_000,
    date: "2026-02-02",
    category: "EARLY_DEPARTURE_REFERENCE",
    transactionStatus: "CLAUSE_ONLY",
    descriptionConfidence: 0.99,
    evidence: evidence("span-clause-only", "Offer clause", "$5,000 if employment ends early"),
  };
  payload.deductions = [clause];

  const finding = runDeductionsAndFeesRule(payload);
  assert.equal(finding.status, "HUMAN_REVIEW_REQUIRED");
  assert.ok(finding.diagnostics.includes("DEDUCTION_CLAUSE_NOT_TRANSACTION"));
  assert.equal(finding.amountCents, undefined);
});

test("a confirmed ongoing worksite change can produce a possible discrepancy", () => {
  const payload = cleanCase();
  const ongoing: EmploymentEvent = {
    id: "ongoing-worksite",
    kind: "WORKSITE_CHANGE",
    title: "Ongoing Columbus assignment",
    start: "2026-06-01",
    end: "2026-09-01",
    certainty: "CONFIRMED",
    worksite: "Columbus, Ohio",
    qualifier: "ONGOING",
    evidence: [evidence("span-ongoing-worksite", "Worksite", "Columbus through August")],
  };
  payload.events = [ongoing];

  const finding = runEmploymentFactConsistencyRule(payload);
  assert.equal(finding.status, "POSSIBLE_DISCREPANCY");
});

test("rule output is deterministic for the same immutable snapshot", () => {
  const payload = heroCase();
  assert.deepEqual(runAllRules(payload), runAllRules(payload));
});

test("canonical cent-valued fixture facts resolve without a dollar-unit conversion", async () => {
  const payload = await createFixtureCase(
    "hero",
    "case-canonical-cent-fixture",
    "owner-test",
    "2026-08-15T12:00:00Z",
  );
  const wage = runWageBenchmarkRule(payload);
  const findings = runAllRules(payload);
  assert.equal(wage.status, "POSSIBLE_DISCREPANCY");
  assert.equal(wage.amountCents, 507_693);
  assert.equal(payload.ruleSetVersion, "wageshield.rules.1.1.0");
  assert.ok(
    findings.every((finding) => finding.ruleVersion.endsWith(".v1.1.0")),
  );
});

test("canonical LCA and offer worksites remain separate fact families", async () => {
  const expected = {
    hero: "HUMAN_REVIEW_REQUIRED",
    clean: "NO_MISMATCH_DETECTED",
    ambiguous: "HUMAN_REVIEW_REQUIRED",
  } as const;

  for (const scenario of Object.keys(expected) as Array<keyof typeof expected>) {
    const payload = await createFixtureCase(
      scenario,
      `case-worksite-${scenario}`,
      "owner-test",
      "2026-08-15T12:00:00Z",
    );
    const finding = runEmploymentFactConsistencyRule(payload);
    assert.equal(finding.status, expected[scenario], scenario);
    assert.ok(!finding.diagnostics.includes("WORKSITE_DOCUMENT_CONFLICT"), scenario);
  }
});

test("a high-pay period cannot offset a separate supported wage shortfall", () => {
  const payload = heroCase();
  payload.payPeriods = [
    payPeriod("low-period", "2026-02-02", "2026-02-16", 300_000),
    payPeriod("high-period", "2026-02-16", "2026-03-02", 700_000),
  ];

  const finding = runWageBenchmarkRule(payload);
  assert.equal(finding.status, "POSSIBLE_DISCREPANCY");
  assert.equal(finding.amountCents, 161_538);
});

test("worksites normalize every U.S. state name and ignore ZIP-only formatting variance", () => {
  const payload = cleanCase();
  payload.events = [];
  const lca = payload.facts.find((item) => item.type === "LCA_WORKSITE");
  const offer = payload.facts.find((item) => item.type === "OFFER_WORKSITE");
  assert.ok(lca && offer);
  lca.rawValue = "Austin, Texas 78701";
  lca.normalizedValue = "Austin, Texas 78701";
  offer.rawValue = "Austin, TX";
  offer.normalizedValue = "Austin, TX";

  const finding = runEmploymentFactConsistencyRule(payload);
  assert.equal(finding.status, "NO_MISMATCH_DETECTED");
  assert.ok(finding.diagnostics.includes("WORKSITE_CONSISTENT"));
});

test("worksite event selection is order-independent and keeps calculation context aligned", () => {
  const payload = cleanCase();
  const ongoing: EmploymentEvent = {
    id: "a-ongoing",
    kind: "WORKSITE_CHANGE",
    title: "Ongoing Columbus assignment",
    start: "2026-06-01",
    end: "2026-09-01",
    certainty: "CONFIRMED",
    worksite: "Columbus, Ohio",
    qualifier: "ONGOING",
    evidence: [evidence("span-event-ongoing", "Worksite", "Columbus through August")],
  };
  const laterTrip: EmploymentEvent = {
    id: "z-trip",
    kind: "WORKSITE_CHANGE",
    title: "Later one-day Chicago trip",
    start: "2026-09-10",
    end: "2026-09-11",
    certainty: "CONFIRMED",
    worksite: "Chicago, Illinois",
    qualifier: "TEMPORARY",
    evidence: [evidence("span-event-trip", "Travel", "One-day Chicago visit")],
  };

  payload.events = [ongoing, laterTrip];
  const forward = runEmploymentFactConsistencyRule(payload);
  payload.events = [laterTrip, ongoing];
  const reversed = runEmploymentFactConsistencyRule(payload);

  for (const finding of [forward, reversed]) {
    assert.equal(finding.status, "POSSIBLE_DISCREPANCY");
    assert.deepEqual(finding.diagnostics, ["WORKSITE_DOCUMENT_CONFLICT"]);
    assert.equal(
      finding.calculation?.rows.find((row) => row.label === "Compared worksite")?.value,
      "Columbus, Ohio",
    );
  }
});

test("mixed nonproductive-time events conservatively require human review", () => {
  const payload = heroCase();
  payload.events.push({
    id: "event-paid-delay",
    kind: "NONPRODUCTIVE_TIME",
    title: "Later paid onboarding delay",
    start: "2026-06-01",
    end: "2026-06-15",
    certainty: "CONFIRMED",
    attribution: "EMPLOYER",
    workerAvailable: true,
    employmentActive: true,
    voluntaryLeave: false,
    observedBaseCents: 461_538,
    evidence: [evidence("span-paid-delay", "Corrected pay", "$4,615.38", "observed")],
  });

  const finding = runAllRules(payload).find(
    (item) => item.module === "NONPRODUCTIVE_TIME",
  );
  assert.equal(finding?.status, "HUMAN_REVIEW_REQUIRED");
  assert.equal(finding?.amountCents, undefined);
  assert.equal(finding?.calculation, null);
  assert.deepEqual(finding?.diagnostics, ["NPT_EVENTS_MIXED_CONTEXT"]);
});

test("duplicate OCR deduction observations are counted once", () => {
  const payload = heroCase();
  const original = payload.deductions[0];
  payload.deductions.push({ ...original, id: "duplicate-ocr-observation" });

  const finding = runDeductionsAndFeesRule(payload);
  assert.equal(finding.status, "POSSIBLE_DISCREPANCY");
  assert.equal(finding.amountCents, 150_000);
  assert.ok(finding.diagnostics.includes("DEDUCTION_DUPLICATES_COLLAPSED"));
});

test("pay periods pending review cannot drive wage or no-signal findings", () => {
  const payload = cleanCase();
  payload.events = [];
  payload.payPeriods = payload.payPeriods.map((period) => ({
    ...period,
    reviewStatus: "NEEDS_REVIEW",
  }));

  const wage = runWageBenchmarkRule(payload);
  assert.equal(wage.status, "HUMAN_REVIEW_REQUIRED");
  assert.equal(wage.amountCents, undefined);
  assert.equal(wage.calculation, null);
  assert.ok(wage.diagnostics.includes("WAGE_PERIOD_REVIEW_REQUIRED"));

  const nonproductiveTime = runNonproductiveTimeRule(payload);
  assert.equal(nonproductiveTime.status, "HUMAN_REVIEW_REQUIRED");
  assert.ok(
    nonproductiveTime.diagnostics.includes("NPT_PAYROLL_REVIEW_REQUIRED"),
  );
});

test("a deduction pending review is excluded from amount and automatic status", () => {
  const payload = heroCase();
  payload.deductions = payload.deductions.map((observation) => ({
    ...observation,
    reviewStatus: "NEEDS_REVIEW",
  }));

  const finding = runDeductionsAndFeesRule(payload);
  assert.equal(finding.status, "HUMAN_REVIEW_REQUIRED");
  assert.equal(finding.amountCents, undefined);
  assert.equal(finding.calculation, null);
  assert.deepEqual(finding.diagnostics, ["DEDUCTION_REVIEW_REQUIRED"]);
});

test("an unreviewed deduction prevents a reviewed routine item from publishing no mismatch", () => {
  const payload = cleanCase();
  payload.deductions.push({
    id: "pending-fee",
    description: "H-1B filing fee",
    amountCents: -200_000,
    date: "2026-05-02",
    category: "PETITION_OR_LEGAL_FEE_REFERENCE",
    transactionStatus: "PAYROLL_OBSERVED",
    descriptionConfidence: 0.99,
    reviewStatus: "NEEDS_REVIEW",
    evidence: evidence(
      "span-pending-fee",
      "Unreviewed fee candidate",
      "H-1B filing fee -$2,000.00",
      "observed",
    ),
  });

  const finding = runDeductionsAndFeesRule(payload);
  assert.equal(finding.status, "HUMAN_REVIEW_REQUIRED");
  assert.equal(finding.amountCents, undefined);
  assert.ok(finding.diagnostics.includes("DEDUCTION_REVIEW_REQUIRED"));
  assert.ok(
    finding.diagnostics.includes(
      "DEDUCTION_CANDIDATES_EXCLUDED_PENDING_REVIEW",
    ),
  );
  assert.ok(
    finding.evidence.every((item) => item.id !== "span-pending-fee"),
  );
});

test("reviewed deduction evidence remains eligible when another candidate awaits review", () => {
  const payload = heroCase();
  payload.deductions.push({
    ...payload.deductions[0],
    id: "pending-separate-fee",
    amountCents: -900_000,
    date: "2026-06-15",
    reviewStatus: "NEEDS_REVIEW",
    evidence: evidence(
      "span-pending-separate-fee",
      "Unreviewed fee candidate",
      "Legal fee candidate -$9,000.00",
      "observed",
    ),
  });

  const finding = runDeductionsAndFeesRule(payload);
  assert.equal(finding.status, "POSSIBLE_DISCREPANCY");
  assert.equal(finding.amountCents, 150_000);
  assert.ok(
    finding.diagnostics.includes(
      "DEDUCTION_CANDIDATES_EXCLUDED_PENDING_REVIEW",
    ),
  );
});
