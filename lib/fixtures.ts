import { SOURCE_CORPUS_VERSION, SOURCES } from "./sources";
import { FINDING_RULE_VERSIONS, RULE_SET_VERSION } from "./versions";
import type {
  CasePayload,
  DeductionObservation,
  DocumentRecord,
  EmploymentEvent,
  EvidenceRef,
  FactRecord,
  Finding,
  FindingModule,
  PayPeriod,
  ReviewStatus,
  Scenario,
} from "./types";

const SYNTHETIC_WATERMARK =
  "FICTIONAL SYNTHETIC DATA - NOT A REAL PERSON OR EMPLOYER.";
const CONSENT_VERSION = "2026-08-15.1";
const DEFAULT_RETENTION_HOURS = 24;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export interface FixtureScenarioMeta {
  label: string;
  description: string;
  expectedOutcome: string;
  documentCount: number | null;
  syntheticOnly: boolean;
}

export const fixtureScenarioMeta = {
  hero: {
    label: "Hero discrepancy case",
    description:
      "A complete evidence set with six comparable pay periods, a separate unpaid project-delay interval, a filing-fee deduction, and an unexplained worksite change.",
    expectedOutcome:
      "Three possible discrepancies and one worksite finding that requires human review.",
    documentCount: 12,
    syntheticOnly: true,
  },
  clean: {
    label: "Clean comparison case",
    description:
      "Consistent LCA, offer, payroll, ordinary deductions, and a clearly temporary one-day client visit.",
    expectedOutcome: "No mismatch detected in all four modules.",
    documentCount: 7,
    syntheticOnly: true,
  },
  ambiguous: {
    label: "Ambiguous evidence case",
    description:
      "A partial first pay period, an unexplained deduction code, an undated project-delay message, and open-ended remote-work language.",
    expectedOutcome:
      "Human review and more-evidence statuses rather than a possible-discrepancy conclusion.",
    documentCount: 6,
    syntheticOnly: true,
  },
  custom: {
    label: "Custom private review",
    description: "A blank case ready for authorized document uploads.",
    expectedOutcome: "No analysis until documents and material facts are reviewed.",
    documentCount: null,
    syntheticOnly: false,
  },
} satisfies Record<Scenario, FixtureScenarioMeta>;

type FixtureNow = Date | string | number;

interface LifecycleTimes {
  createdAt: string;
  uploadedAt: string;
  analyzedAt: string;
  updatedAt: string;
  retentionExpiresAt: string;
}

interface DocumentSpec {
  key: string;
  name: string;
  type: DocumentRecord["type"];
  required: boolean;
  pages: number;
  bytes: number;
  note: string;
  contentType?: string;
  status?: DocumentRecord["status"];
}

interface PayPeriodSpec {
  key: string;
  documentKey: string;
  start: string;
  end: string;
  payDate: string;
  ordinaryBaseCents: number;
  grossCents: number;
  complete: boolean;
  comparable: boolean;
  correctionStatus: PayPeriod["correctionStatus"];
}

function normalizeNow(value?: FixtureNow): Date {
  const date = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("now must be a valid Date, timestamp, or ISO date string");
  }
  return date;
}

function lifecycleTimes(value?: FixtureNow): LifecycleTimes {
  const now = normalizeNow(value);
  return {
    createdAt: new Date(now.getTime() - 30 * MINUTE_MS).toISOString(),
    uploadedAt: new Date(now.getTime() - 20 * MINUTE_MS).toISOString(),
    analyzedAt: new Date(now.getTime() - 2 * MINUTE_MS).toISOString(),
    updatedAt: now.toISOString(),
    retentionExpiresAt: new Date(
      now.getTime() + DEFAULT_RETENTION_HOURS * HOUR_MS,
    ).toISOString(),
  };
}

function safeObjectSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function createDocuments(
  caseId: string,
  uploadedAt: string,
  specs: DocumentSpec[],
): Promise<DocumentRecord[]> {
  const safeCaseId = safeObjectSegment(caseId);
  return Promise.all(
    specs.map(async (spec) => {
      const id = `${caseId}-doc-${spec.key}`;
      const note = `${SYNTHETIC_WATERMARK} ${spec.note}`;
      return {
        id,
        name: spec.name,
        type: spec.type,
        required: spec.required,
        status: spec.status ?? "READY",
        pages: spec.pages,
        bytes: spec.bytes,
        contentType: spec.contentType ?? "application/pdf",
        hash: await sha256(`${caseId}|${spec.name}|${note}`),
        synthetic: true,
        uploadedAt,
        objectKey: `private/demo/${safeCaseId}/original/${safeObjectSegment(id)}/v1/${safeObjectSegment(spec.name)}`,
        note,
      } satisfies DocumentRecord;
    }),
  );
}

function getDocument(
  documents: DocumentRecord[],
  caseId: string,
  key: string,
): DocumentRecord {
  const document = documents.find((item) => item.id === `${caseId}-doc-${key}`);
  if (!document) throw new Error(`Fixture document not found: ${key}`);
  return document;
}

function makeEvidence(
  caseId: string,
  key: string,
  document: DocumentRecord,
  page: number,
  label: string,
  text: string,
  role: EvidenceRef["role"],
): EvidenceRef {
  return {
    id: `${caseId}-evidence-${key}`,
    documentId: document.id,
    documentName: document.name,
    page,
    label,
    text,
    role,
  };
}

function makeFact(
  caseId: string,
  key: string,
  input: {
    type: string;
    label: string;
    rawValue: string;
    normalizedValue: string;
    confidence: number;
    reviewStatus: ReviewStatus;
    affects: FindingModule[];
    evidence: EvidenceRef;
    unit?: string;
  },
): FactRecord {
  return {
    id: `${caseId}-fact-${key}`,
    ...input,
  };
}

function makePayPeriod(
  caseId: string,
  spec: PayPeriodSpec,
  evidence: EvidenceRef,
): PayPeriod {
  return {
    id: `${caseId}-period-${spec.key}`,
    start: spec.start,
    end: spec.end,
    payDate: spec.payDate,
    ordinaryBaseCents: spec.ordinaryBaseCents,
    grossCents: spec.grossCents,
    complete: spec.complete,
    comparable: spec.comparable,
    correctionStatus: spec.correctionStatus,
    evidence,
  };
}

function makePayPeriodEvents(
  caseId: string,
  payPeriods: PayPeriod[],
): EmploymentEvent[] {
  return payPeriods.map((period, index) => ({
    id: `${caseId}-event-pay-${index + 1}`,
    kind: "PAY_PERIOD",
    title: period.complete
      ? `Complete pay period ${index + 1}`
      : `Partial pay period ${index + 1}`,
    start: period.start,
    end: period.end,
    certainty: period.complete ? "CONFIRMED" : "APPROXIMATE",
    observedBaseCents: period.ordinaryBaseCents,
    evidence: [period.evidence],
  }));
}

function makeFinding(
  caseId: string,
  key: string,
  input: Omit<Finding, "id" | "ruleVersion">,
): Finding {
  return {
    id: `${caseId}-finding-${key}`,
    ruleVersion: FINDING_RULE_VERSIONS[input.module],
    ...input,
  };
}

function commonCaseFields(
  caseId: string,
  ownerUserId: string,
  times: LifecycleTimes,
): Pick<
  CasePayload,
  | "id"
  | "ownerUserId"
  | "mode"
  | "consentVersion"
  | "authorizedUseConfirmed"
  | "retentionHours"
  | "retentionExpiresAt"
  | "createdAt"
  | "updatedAt"
  | "ruleSetVersion"
  | "sourceCorpusVersion"
  | "corrections"
> {
  return {
    id: caseId,
    ownerUserId,
    mode: "SANDBOX",
    consentVersion: CONSENT_VERSION,
    authorizedUseConfirmed: true,
    retentionHours: DEFAULT_RETENTION_HOURS,
    retentionExpiresAt: times.retentionExpiresAt,
    createdAt: times.createdAt,
    updatedAt: times.updatedAt,
    ruleSetVersion: RULE_SET_VERSION,
    sourceCorpusVersion: SOURCE_CORPUS_VERSION,
    corrections: [],
  };
}

const HERO_PERIOD_SPECS: PayPeriodSpec[] = [
  {
    key: "01",
    documentKey: "pay-01",
    start: "2026-02-02",
    end: "2026-02-15",
    payDate: "2026-02-20",
    ordinaryBaseCents: 376_923,
    grossCents: 376_923,
    complete: true,
    comparable: true,
    correctionStatus: "NONE",
  },
  {
    key: "02",
    documentKey: "pay-02",
    start: "2026-02-16",
    end: "2026-03-01",
    payDate: "2026-03-06",
    ordinaryBaseCents: 376_923,
    grossCents: 376_923,
    complete: true,
    comparable: true,
    correctionStatus: "NONE",
  },
  {
    key: "03",
    documentKey: "pay-03",
    start: "2026-03-02",
    end: "2026-03-15",
    payDate: "2026-03-20",
    ordinaryBaseCents: 376_923,
    grossCents: 376_923,
    complete: true,
    comparable: true,
    correctionStatus: "NONE",
  },
  {
    key: "04",
    documentKey: "pay-04",
    start: "2026-03-16",
    end: "2026-03-29",
    payDate: "2026-04-03",
    ordinaryBaseCents: 376_923,
    grossCents: 376_923,
    complete: true,
    comparable: true,
    correctionStatus: "NONE",
  },
  {
    key: "05",
    documentKey: "pay-05",
    start: "2026-03-30",
    end: "2026-04-12",
    payDate: "2026-04-17",
    ordinaryBaseCents: 376_923,
    grossCents: 376_923,
    complete: true,
    comparable: true,
    correctionStatus: "NONE",
  },
  {
    key: "06",
    documentKey: "pay-06",
    start: "2026-04-13",
    end: "2026-04-26",
    payDate: "2026-05-01",
    ordinaryBaseCents: 376_923,
    grossCents: 376_923,
    complete: true,
    comparable: true,
    correctionStatus: "NONE",
  },
];

async function createHeroCase(
  caseId: string,
  ownerUserId: string,
  times: LifecycleTimes,
): Promise<CasePayload> {
  const documentSpecs: DocumentSpec[] = [
    {
      key: "lca",
      name: "01-synthetic-certified-lca.pdf",
      type: "LCA_CERTIFIED",
      required: true,
      pages: 4,
      bytes: 486_120,
      note: "Certified-LCA-style fixture with a $120,000 annual wage and Indianapolis worksite.",
    },
    {
      key: "offer",
      name: "02-synthetic-offer-letter.pdf",
      type: "OFFER_OR_EMPLOYMENT_LETTER",
      required: true,
      pages: 2,
      bytes: 174_900,
      note: "Offer-letter fixture for a Data Engineer paid $120,000 annually on a biweekly schedule.",
    },
    ...HERO_PERIOD_SPECS.map<DocumentSpec>((period, index) => ({
      key: period.documentKey,
      name: `${String(index + 3).padStart(2, "0")}-synthetic-paystub-${period.payDate}.pdf`,
      type: "PAYSTUB",
      required: true,
      pages: 1,
      bytes: 91_500 + index * 173,
      note:
        index === HERO_PERIOD_SPECS.length - 1
          ? `Complete biweekly payroll fixture for ${period.start} through ${period.end}; ordinary base $3,769.23 and a separate $1,500.00 filing/legal-fee recovery line.`
          : `Complete biweekly payroll fixture for ${period.start} through ${period.end}; ordinary base $3,769.23.`,
    })),
    {
      key: "npt-zero-pay",
      name: "09-synthetic-paystub-project-delay-zero-pay.pdf",
      type: "PAYSTUB",
      required: false,
      pages: 1,
      bytes: 93_220,
      note: "Separate payroll fixture showing $0.00 ordinary base for the 2026-05-04 through 2026-05-17 project-delay interval.",
    },
    {
      key: "project-delay-message",
      name: "10-synthetic-work-message-project-delay.pdf",
      type: "WORK_MESSAGE",
      required: false,
      pages: 1,
      bytes: 128_440,
      note: "Employer-authored message fixture instructing the worker to remain available but not submit hours for two weeks.",
    },
    {
      key: "worksite-message",
      name: "11-synthetic-work-message-worksite.pdf",
      type: "WORK_MESSAGE",
      required: false,
      pages: 1,
      bytes: 124_200,
      note: "Employer-authored message fixture directing reporting to Columbus beginning 2026-06-01 without a stated end date.",
    },
    {
      key: "timesheet",
      name: "12-synthetic-timesheet-may.pdf",
      type: "TIMESHEET",
      required: false,
      pages: 1,
      bytes: 109_880,
      note: "Timesheet fixture showing no approved hours during the project-delay interval while assignment status remained active.",
    },
  ];

  const documents = await createDocuments(caseId, times.uploadedAt, documentSpecs);
  const lca = getDocument(documents, caseId, "lca");
  const offer = getDocument(documents, caseId, "offer");
  const zeroPayDocument = getDocument(documents, caseId, "npt-zero-pay");
  const projectMessageDocument = getDocument(
    documents,
    caseId,
    "project-delay-message",
  );
  const worksiteMessageDocument = getDocument(
    documents,
    caseId,
    "worksite-message",
  );
  const timesheetDocument = getDocument(documents, caseId, "timesheet");

  const workerEvidence = makeEvidence(
    caseId,
    "hero-worker",
    lca,
    1,
    "Worker name",
    "Worker: Arjun Mehta",
    "context",
  );
  const employerEvidence = makeEvidence(
    caseId,
    "hero-employer",
    lca,
    1,
    "Petitioning employer",
    "Northstar Data Systems LLC",
    "benchmark",
  );
  const lcaWageEvidence = makeEvidence(
    caseId,
    "hero-lca-wage",
    lca,
    2,
    "LCA wage offered",
    "Rate of Pay: $120,000.00 per Year",
    "benchmark",
  );
  const lcaWorksiteEvidence = makeEvidence(
    caseId,
    "hero-lca-worksite",
    lca,
    3,
    "LCA worksite",
    "Place of Employment: Indianapolis, Indiana 46204",
    "benchmark",
  );
  const offerWageEvidence = makeEvidence(
    caseId,
    "hero-offer-wage",
    offer,
    1,
    "Offer salary",
    "Your annual base salary will be $120,000.00, paid biweekly.",
    "benchmark",
  );
  const offerStartEvidence = makeEvidence(
    caseId,
    "hero-offer-start",
    offer,
    1,
    "Employment start and status",
    "Start date: February 2, 2026. Position: full-time Data Engineer.",
    "context",
  );
  const offerWorksiteEvidence = makeEvidence(
    caseId,
    "hero-offer-worksite",
    offer,
    1,
    "Offer worksite",
    "Primary work location: Indianapolis, Indiana.",
    "benchmark",
  );

  const payEvidence = HERO_PERIOD_SPECS.map((period, index) =>
    makeEvidence(
      caseId,
      `hero-pay-${period.key}`,
      getDocument(documents, caseId, period.documentKey),
      1,
      `Complete pay period ${index + 1}`,
      `Pay period ${period.start} through ${period.end}; Regular Salary $3,769.23; Gross Ordinary Base $3,769.23.`,
      "observed",
    ),
  );
  const zeroPayEvidence = makeEvidence(
    caseId,
    "hero-zero-pay",
    zeroPayDocument,
    1,
    "Project-delay payroll interval",
    "Pay period 2026-05-04 through 2026-05-17; Regular Salary $0.00; Regular Hours 0.00.",
    "observed",
  );
  const projectMessageEvidence = makeEvidence(
    caseId,
    "hero-project-message",
    projectMessageDocument,
    1,
    "Employer project-delay instruction",
    "The client project is delayed for two weeks. Remain available, but do not submit hours until we place you.",
    "context",
  );
  const timesheetEvidence = makeEvidence(
    caseId,
    "hero-timesheet",
    timesheetDocument,
    1,
    "Active assignment and no approved hours",
    "2026-05-04 to 2026-05-17: assignment status ACTIVE; approved regular hours 0.00.",
    "context",
  );
  const deductionEvidence = makeEvidence(
    caseId,
    "hero-deduction",
    getDocument(documents, caseId, "pay-06"),
    1,
    "Observed deduction line",
    "H-1B filing/legal fee recovery  -$1,500.00",
    "observed",
  );
  const worksiteMessageEvidence = makeEvidence(
    caseId,
    "hero-worksite-message",
    worksiteMessageDocument,
    1,
    "Ongoing worksite instruction",
    "Beginning June 1, report to the Columbus, Ohio client site until further notice.",
    "contradiction",
  );

  const payPeriods = HERO_PERIOD_SPECS.map((period, index) =>
    makePayPeriod(caseId, period, payEvidence[index]),
  );

  const facts: FactRecord[] = [
    makeFact(caseId, "worker-name", {
      type: "WORKER_NAME",
      label: "Worker name",
      rawValue: "Arjun Mehta",
      normalizedValue: "Arjun Mehta",
      confidence: 0.99,
      reviewStatus: "CONFIRMED",
      affects: ["WAGE_BENCHMARK", "NONPRODUCTIVE_TIME", "EMPLOYMENT_FACTS"],
      evidence: workerEvidence,
    }),
    makeFact(caseId, "employer-name", {
      type: "EMPLOYER_NAME",
      label: "Petitioning employer",
      rawValue: "Northstar Data Systems LLC",
      normalizedValue: "NORTHSTAR DATA SYSTEMS LLC",
      confidence: 0.99,
      reviewStatus: "CONFIRMED",
      affects: ["WAGE_BENCHMARK", "NONPRODUCTIVE_TIME", "EMPLOYMENT_FACTS"],
      evidence: employerEvidence,
    }),
    makeFact(caseId, "position", {
      type: "POSITION_TITLE",
      label: "Position",
      rawValue: "Data Engineer",
      normalizedValue: "DATA ENGINEER",
      confidence: 0.99,
      reviewStatus: "CONFIRMED",
      affects: ["EMPLOYMENT_FACTS"],
      evidence: offerStartEvidence,
    }),
    makeFact(caseId, "employment-status", {
      type: "EMPLOYMENT_STATUS",
      label: "Employment status during reviewed period",
      rawValue: "Full-time; active from February 2, 2026",
      normalizedValue: "ACTIVE_FULL_TIME",
      confidence: 0.99,
      reviewStatus: "CONFIRMED",
      affects: ["WAGE_BENCHMARK", "NONPRODUCTIVE_TIME"],
      evidence: offerStartEvidence,
    }),
    makeFact(caseId, "lca-wage", {
      type: "LCA_WAGE_ANNUAL_CENTS",
      label: "LCA-listed annual wage",
      rawValue: "$120,000.00 per year",
      normalizedValue: "12000000",
      unit: "USD_CENTS_PER_YEAR",
      confidence: 0.99,
      reviewStatus: "CONFIRMED",
      affects: ["WAGE_BENCHMARK", "NONPRODUCTIVE_TIME"],
      evidence: lcaWageEvidence,
    }),
    makeFact(caseId, "offer-wage", {
      type: "OFFER_WAGE_ANNUAL_CENTS",
      label: "Offer annual base salary",
      rawValue: "$120,000.00 per year",
      normalizedValue: "12000000",
      unit: "USD_CENTS_PER_YEAR",
      confidence: 0.99,
      reviewStatus: "CONFIRMED",
      affects: ["WAGE_BENCHMARK", "NONPRODUCTIVE_TIME"],
      evidence: offerWageEvidence,
    }),
    makeFact(caseId, "pay-frequency", {
      type: "PAY_FREQUENCY",
      label: "Pay frequency",
      rawValue: "Paid biweekly",
      normalizedValue: "BIWEEKLY",
      confidence: 0.99,
      reviewStatus: "CONFIRMED",
      affects: ["WAGE_BENCHMARK", "NONPRODUCTIVE_TIME"],
      evidence: offerWageEvidence,
    }),
    makeFact(caseId, "lca-worksite", {
      type: "LCA_WORKSITE",
      label: "LCA worksite",
      rawValue: "Indianapolis, Indiana 46204",
      normalizedValue: "INDIANAPOLIS|IN",
      confidence: 0.99,
      reviewStatus: "CONFIRMED",
      affects: ["EMPLOYMENT_FACTS"],
      evidence: lcaWorksiteEvidence,
    }),
    makeFact(caseId, "offer-worksite", {
      type: "OFFER_WORKSITE",
      label: "Offer worksite",
      rawValue: "Indianapolis, Indiana",
      normalizedValue: "INDIANAPOLIS|IN",
      confidence: 0.99,
      reviewStatus: "CONFIRMED",
      affects: ["EMPLOYMENT_FACTS"],
      evidence: offerWorksiteEvidence,
    }),
    ...payEvidence.map((evidence, index) =>
      makeFact(caseId, `base-earnings-${index + 1}`, {
        type: "ORDINARY_BASE_EARNINGS_CENTS",
        label: `Ordinary base earnings, pay period ${index + 1}`,
        rawValue: "$3,769.23",
        normalizedValue: "376923",
        unit: "USD_CENTS_PER_PERIOD",
        confidence: 0.99,
        reviewStatus: "CONFIRMED",
        affects: ["WAGE_BENCHMARK"],
        evidence,
      }),
    ),
    makeFact(caseId, "npt-ready", {
      type: "WORKER_AVAILABILITY",
      label: "Availability during project delay",
      rawValue: "Remain available",
      normalizedValue: "READY",
      confidence: 0.98,
      reviewStatus: "CONFIRMED",
      affects: ["NONPRODUCTIVE_TIME"],
      evidence: projectMessageEvidence,
    }),
    makeFact(caseId, "npt-zero-base", {
      type: "NONPRODUCTIVE_TIME_BASE_CENTS",
      label: "Observed ordinary base during project delay",
      rawValue: "$0.00",
      normalizedValue: "0",
      unit: "USD_CENTS",
      confidence: 0.99,
      reviewStatus: "CONFIRMED",
      affects: ["NONPRODUCTIVE_TIME"],
      evidence: zeroPayEvidence,
    }),
    makeFact(caseId, "deduction-amount", {
      type: "DEDUCTION_AMOUNT_CENTS",
      label: "Filing/legal-fee recovery deduction",
      rawValue: "-$1,500.00",
      normalizedValue: "150000",
      unit: "USD_CENTS",
      confidence: 0.99,
      reviewStatus: "CONFIRMED",
      affects: ["DEDUCTIONS_FEES"],
      evidence: deductionEvidence,
    }),
    makeFact(caseId, "worksite-direction", {
      type: "WORKSITE_CHANGE",
      label: "Later worksite instruction",
      rawValue: "Columbus, Ohio beginning June 1 until further notice",
      normalizedValue: "COLUMBUS|OH|START=2026-06-01|DURATION=UNKNOWN",
      confidence: 0.98,
      reviewStatus: "CONFIRMED",
      affects: ["EMPLOYMENT_FACTS"],
      evidence: worksiteMessageEvidence,
    }),
  ];

  const deductions: DeductionObservation[] = [
    {
      id: `${caseId}-deduction-filing-fee`,
      description: "H-1B filing/legal fee recovery",
      amountCents: 150_000,
      date: "2026-05-01",
      category: "PETITION_OR_LEGAL_FEE_REFERENCE",
      transactionStatus: "PAYROLL_OBSERVED",
      descriptionConfidence: 0.99,
      evidence: deductionEvidence,
    },
  ];

  const events: EmploymentEvent[] = [
    {
      id: `${caseId}-event-employment-start`,
      kind: "EMPLOYMENT_START",
      title: "Full-time employment begins",
      start: "2026-02-02",
      certainty: "CONFIRMED",
      employmentActive: true,
      worksite: "Indianapolis, Indiana",
      evidence: [offerStartEvidence, lcaWorksiteEvidence],
    },
    ...makePayPeriodEvents(caseId, payPeriods),
    {
      id: `${caseId}-event-project-delay`,
      kind: "NONPRODUCTIVE_TIME",
      title: "Two-week project-delay interval",
      start: "2026-05-04",
      end: "2026-05-18",
      certainty: "CONFIRMED",
      attribution: "EMPLOYER",
      workerAvailable: true,
      employmentActive: true,
      voluntaryLeave: false,
      observedBaseCents: 0,
      evidence: [projectMessageEvidence, zeroPayEvidence, timesheetEvidence],
    },
    {
      id: `${caseId}-event-worksite-change`,
      kind: "WORKSITE_CHANGE",
      title: "Instruction names a different ongoing worksite",
      start: "2026-06-01",
      certainty: "CONFIRMED",
      attribution: "EMPLOYER",
      employmentActive: true,
      worksite: "Columbus, Ohio",
      qualifier: "UNKNOWN",
      evidence: [worksiteMessageEvidence, lcaWorksiteEvidence, offerWorksiteEvidence],
    },
  ];

  const findings: Finding[] = [
    makeFinding(caseId, "wage-benchmark", {
      module: "WAGE_BENCHMARK",
      status: "POSSIBLE_DISCREPANCY",
      attention: "REVIEW_NOW",
      headline:
        "Observed ordinary base pay is below the uploaded LCA and offer benchmarks",
      summary:
        "Six complete biweekly periods show $3,769.23 in ordinary base earnings against a $120,000 annual documented benchmark.",
      amountCents: 507_693,
      amountLabel: "estimated documented base-pay difference",
      period: { start: "2026-02-02", end: "2026-04-27" },
      calculation: {
        formula: "($120,000 / 26 x 6) - ($3,769.23 x 6)",
        rows: [
          { label: "LCA and offer annual benchmark", value: "$120,000.00" },
          { label: "Expected per biweekly period", value: "$4,615.38" },
          { label: "Observed per complete period", value: "$3,769.23" },
          { label: "Complete comparable periods", value: "6" },
          { label: "Aggregate expected base", value: "$27,692.31" },
          { label: "Aggregate observed base", value: "$22,615.38" },
          {
            label: "Estimated documented difference",
            value: "$5,076.93",
            emphasis: true,
          },
        ],
        method:
          "The annual benchmark is divided using decimal arithmetic, aggregated across six complete periods, and rounded to cents only at the aggregate display step.",
      },
      evidence: [lcaWageEvidence, offerWageEvidence, ...payEvidence],
      source: SOURCES.WAGE_BENCHMARK,
      assumptions: [
        "All six listed pay periods are complete ordinary biweekly periods.",
        "The uploaded LCA supports the reviewed period.",
      ],
      limitations: [
        "This worker-side comparison does not establish the employer's internal actual-wage obligation.",
        "Additional payroll corrections, leave records, or another applicable LCA may change the comparison.",
      ],
      questions: [
        "Was a salary change or amendment issued?",
        "Were any later base-pay corrections paid outside these six records?",
      ],
      confidence: { extraction: 0.99, evidence: 0.99, context: 0.84 },
      diagnostics: ["WAGE_BELOW_LCA_BENCHMARK"],
      includeInReport: true,
      disposition: "UNREVIEWED",
    }),
    makeFinding(caseId, "nonproductive-time", {
      module: "NONPRODUCTIVE_TIME",
      status: "POSSIBLE_DISCREPANCY",
      attention: "REVIEW_NOW",
      headline:
        "A two-week unpaid interval may be related to an employer project delay",
      summary:
        "The message says to remain available while no ordinary base pay or approved hours appear for the aligned interval.",
      amountCents: 461_538,
      amountLabel: "potential affected base-pay benchmark",
      period: { start: "2026-05-04", end: "2026-05-18" },
      calculation: {
        formula: "$120,000 / 26 biweekly periods",
        rows: [
          { label: "Documented annual benchmark", value: "$120,000.00" },
          { label: "One biweekly benchmark interval", value: "$4,615.38" },
          { label: "Observed ordinary base", value: "$0.00" },
          { label: "Comparison amount", value: "$4,615.38", emphasis: true },
        ],
        method:
          "The 14-day reviewed interval aligns to one documented biweekly benchmark period; the amount is a comparison benchmark, not damages or a legally owed amount.",
      },
      evidence: [projectMessageEvidence, zeroPayEvidence, timesheetEvidence],
      source: SOURCES.NONPRODUCTIVE_TIME,
      assumptions: [
        "Employment remained active throughout the interval.",
        "The worker was ready and available as the employer-authored message states.",
      ],
      limitations: [
        "Leave, incapacity, termination, or later payroll corrections could change the interpretation.",
      ],
      questions: [
        "Was ordinary base pay provided later?",
        "Was there any voluntary leave request or period of unavailability?",
      ],
      confidence: { extraction: 0.99, evidence: 0.98, context: 0.88 },
      diagnostics: ["NPT_EMPLOYER_RELATED_SIGNAL"],
      includeInReport: true,
      disposition: "UNREVIEWED",
    }),
    makeFinding(caseId, "deductions-fees", {
      module: "DEDUCTIONS_FEES",
      status: "POSSIBLE_DISCREPANCY",
      attention: "REVIEW_SOON",
      headline: "A $1,500 payroll deduction references H-1B filing or legal fees",
      summary:
        "The deduction is an observed payroll transaction matching an official-guidance category that should be reviewed.",
      amountCents: 150_000,
      amountLabel: "observed payroll deduction",
      period: { start: "2026-04-13", end: "2026-05-01" },
      calculation: {
        formula: "$3,769.23 ordinary base - $1,500.00 observed deduction",
        rows: [
          { label: "Ordinary base before deductions", value: "$3,769.23" },
          { label: "Filing/legal-fee recovery", value: "$1,500.00" },
          { label: "Cash after candidate deduction", value: "$2,269.23", emphasis: true },
        ],
        method:
          "The calculation shows the cash-pay effect of the observed line and does not determine authorization or legality.",
      },
      evidence: [deductionEvidence, payEvidence[5]],
      source: SOURCES.DEDUCTIONS_FEES,
      assumptions: ["The paystub line represents an actual payroll deduction."],
      limitations: [
        "The label alone does not establish which filing service or expense the amount covered.",
      ],
      questions: [
        "What service or filing did the amount cover?",
        "Was the amount later reimbursed?",
        "Is there a separate authorization, invoice, or agreement?",
      ],
      confidence: { extraction: 0.99, evidence: 0.99, context: 0.74 },
      diagnostics: ["DEDUCTION_OFFICIAL_GUIDANCE_CATEGORY"],
      includeInReport: true,
      disposition: "UNREVIEWED",
    }),
    makeFinding(caseId, "employment-facts", {
      module: "EMPLOYMENT_FACTS",
      status: "HUMAN_REVIEW_REQUIRED",
      attention: "CONTEXT_NEEDED",
      headline: "Uploaded records identify different work locations",
      summary:
        "The LCA and offer name Indianapolis, while a later employer message directs work in Columbus without a clear duration.",
      period: { start: "2026-06-01", end: "2026-06-30" },
      calculation: null,
      evidence: [lcaWorksiteEvidence, offerWorksiteEvidence, worksiteMessageEvidence],
      source: SOURCES.EMPLOYMENT_FACTS,
      assumptions: ["The message describes a work instruction rather than a short visit."],
      limitations: [
        "The available records do not establish duration, geographic-area context, remote-work terms, or whether another filing exists.",
      ],
      questions: [
        "Was the assignment temporary?",
        "What duration was expected?",
        "Is another LCA, petition amendment, or remote-work instruction available?",
      ],
      confidence: { extraction: 0.98, evidence: 0.98, context: 0.48 },
      diagnostics: ["WORKSITE_CONTEXT_REQUIRED"],
      includeInReport: true,
      disposition: "NEEDS_REVIEW",
    }),
  ];

  return {
    ...commonCaseFields(caseId, ownerUserId, times),
    scenario: "hero",
    title: "Arjun Mehta - synthetic evidence review",
    workerName: "Arjun Mehta",
    employerName: "Northstar Data Systems LLC",
    position: "Data Engineer",
    reviewStart: "2026-02-02",
    reviewEnd: "2026-06-30",
    state: "RESULTS_READY",
    stateVersion: 8,
    documents,
    facts,
    payPeriods,
    deductions,
    events,
    findings,
    lastAnalysisAt: times.analyzedAt,
  };
}

const CLEAN_PERIOD_SPECS: PayPeriodSpec[] = [
  {
    key: "01",
    documentKey: "pay-01",
    start: "2026-03-02",
    end: "2026-03-15",
    payDate: "2026-03-20",
    ordinaryBaseCents: 461_538,
    grossCents: 461_538,
    complete: true,
    comparable: true,
    correctionStatus: "NONE",
  },
  {
    key: "02",
    documentKey: "pay-02",
    start: "2026-03-16",
    end: "2026-03-29",
    payDate: "2026-04-03",
    ordinaryBaseCents: 461_538,
    grossCents: 461_538,
    complete: true,
    comparable: true,
    correctionStatus: "NONE",
  },
  {
    key: "03",
    documentKey: "pay-03",
    start: "2026-03-30",
    end: "2026-04-12",
    payDate: "2026-04-17",
    ordinaryBaseCents: 461_538,
    grossCents: 461_538,
    complete: true,
    comparable: true,
    correctionStatus: "NONE",
  },
  {
    key: "04",
    documentKey: "pay-04",
    start: "2026-04-13",
    end: "2026-04-26",
    payDate: "2026-05-01",
    ordinaryBaseCents: 461_538,
    grossCents: 461_538,
    complete: true,
    comparable: true,
    correctionStatus: "NONE",
  },
];

async function createCleanCase(
  caseId: string,
  ownerUserId: string,
  times: LifecycleTimes,
): Promise<CasePayload> {
  const documents = await createDocuments(caseId, times.uploadedAt, [
    {
      key: "lca",
      name: "01-synthetic-clean-lca.pdf",
      type: "LCA_CERTIFIED",
      required: true,
      pages: 4,
      bytes: 481_340,
      note: "Certified-LCA-style fixture with a $120,000 annual wage and Indianapolis worksite.",
    },
    {
      key: "offer",
      name: "02-synthetic-clean-offer.pdf",
      type: "OFFER_OR_EMPLOYMENT_LETTER",
      required: true,
      pages: 2,
      bytes: 169_400,
      note: "Offer fixture matching the LCA wage, full-time status, start date, and Indianapolis worksite.",
    },
    ...CLEAN_PERIOD_SPECS.map<DocumentSpec>((period, index) => ({
      key: period.documentKey,
      name: `${String(index + 3).padStart(2, "0")}-synthetic-clean-paystub-${period.payDate}.pdf`,
      type: "PAYSTUB",
      required: true,
      pages: 1,
      bytes: 90_200 + index * 129,
      note:
        index === CLEAN_PERIOD_SPECS.length - 1
          ? `Complete biweekly payroll fixture for ${period.start} through ${period.end}; ordinary base $4,615.38 with ordinary tax and elected health-premium deductions.`
          : `Complete biweekly payroll fixture for ${period.start} through ${period.end}; ordinary base $4,615.38.`,
    })),
    {
      key: "temporary-travel",
      name: "07-synthetic-one-day-client-visit.pdf",
      type: "WORK_MESSAGE",
      required: false,
      pages: 1,
      bytes: 118_600,
      note: "Employer message fixture documenting a one-day Cincinnati client visit and same-day return to Indianapolis.",
    },
  ]);

  const lca = getDocument(documents, caseId, "lca");
  const offer = getDocument(documents, caseId, "offer");
  const travelDocument = getDocument(documents, caseId, "temporary-travel");
  const workerEvidence = makeEvidence(
    caseId,
    "clean-worker",
    lca,
    1,
    "Worker name",
    "Worker: Priya Shah",
    "context",
  );
  const employerEvidence = makeEvidence(
    caseId,
    "clean-employer",
    lca,
    1,
    "Petitioning employer",
    "Meridian Analytics Group LLC",
    "benchmark",
  );
  const lcaWageEvidence = makeEvidence(
    caseId,
    "clean-lca-wage",
    lca,
    2,
    "LCA wage offered",
    "Rate of Pay: $120,000.00 per Year",
    "benchmark",
  );
  const lcaWorksiteEvidence = makeEvidence(
    caseId,
    "clean-lca-worksite",
    lca,
    3,
    "LCA worksite",
    "Place of Employment: Indianapolis, Indiana 46204",
    "benchmark",
  );
  const offerEvidence = makeEvidence(
    caseId,
    "clean-offer",
    offer,
    1,
    "Matching employment terms",
    "Full-time Business Systems Analyst; $120,000 annual base; paid biweekly; primary work location Indianapolis, Indiana; start date March 2, 2026.",
    "context",
  );
  const payEvidence = CLEAN_PERIOD_SPECS.map((period, index) =>
    makeEvidence(
      caseId,
      `clean-pay-${period.key}`,
      getDocument(documents, caseId, period.documentKey),
      1,
      `Complete pay period ${index + 1}`,
      `Pay period ${period.start} through ${period.end}; Regular Salary $4,615.38; Gross Ordinary Base $4,615.38.`,
      "observed",
    ),
  );
  const routineDeductionEvidence = makeEvidence(
    caseId,
    "clean-health-deduction",
    getDocument(documents, caseId, "pay-04"),
    1,
    "Elected health-premium deduction",
    "Employee health plan premium  -$125.00",
    "observed",
  );
  const travelEvidence = makeEvidence(
    caseId,
    "clean-temporary-travel",
    travelDocument,
    1,
    "One-day travel instruction",
    "Please visit the Cincinnati client on April 22 for the day and return to your Indianapolis worksite afterward.",
    "context",
  );

  const payPeriods = CLEAN_PERIOD_SPECS.map((period, index) =>
    makePayPeriod(caseId, period, payEvidence[index]),
  );
  const facts: FactRecord[] = [
    makeFact(caseId, "worker-name", {
      type: "WORKER_NAME",
      label: "Worker name",
      rawValue: "Priya Shah",
      normalizedValue: "Priya Shah",
      confidence: 0.99,
      reviewStatus: "CONFIRMED",
      affects: ["WAGE_BENCHMARK", "EMPLOYMENT_FACTS"],
      evidence: workerEvidence,
    }),
    makeFact(caseId, "employer-name", {
      type: "EMPLOYER_NAME",
      label: "Petitioning employer",
      rawValue: "Meridian Analytics Group LLC",
      normalizedValue: "MERIDIAN ANALYTICS GROUP LLC",
      confidence: 0.99,
      reviewStatus: "CONFIRMED",
      affects: ["WAGE_BENCHMARK", "EMPLOYMENT_FACTS"],
      evidence: employerEvidence,
    }),
    makeFact(caseId, "position", {
      type: "POSITION_TITLE",
      label: "Position",
      rawValue: "Business Systems Analyst",
      normalizedValue: "BUSINESS SYSTEMS ANALYST",
      confidence: 0.99,
      reviewStatus: "CONFIRMED",
      affects: ["EMPLOYMENT_FACTS"],
      evidence: offerEvidence,
    }),
    makeFact(caseId, "employment-status", {
      type: "EMPLOYMENT_STATUS",
      label: "Employment status",
      rawValue: "Full-time and active",
      normalizedValue: "ACTIVE_FULL_TIME",
      confidence: 0.99,
      reviewStatus: "CONFIRMED",
      affects: ["WAGE_BENCHMARK", "NONPRODUCTIVE_TIME"],
      evidence: offerEvidence,
    }),
    makeFact(caseId, "lca-wage", {
      type: "LCA_WAGE_ANNUAL_CENTS",
      label: "LCA-listed annual wage",
      rawValue: "$120,000.00 per year",
      normalizedValue: "12000000",
      unit: "USD_CENTS_PER_YEAR",
      confidence: 0.99,
      reviewStatus: "CONFIRMED",
      affects: ["WAGE_BENCHMARK", "NONPRODUCTIVE_TIME"],
      evidence: lcaWageEvidence,
    }),
    makeFact(caseId, "offer-wage", {
      type: "OFFER_WAGE_ANNUAL_CENTS",
      label: "Offer annual base salary",
      rawValue: "$120,000.00 per year",
      normalizedValue: "12000000",
      unit: "USD_CENTS_PER_YEAR",
      confidence: 0.99,
      reviewStatus: "CONFIRMED",
      affects: ["WAGE_BENCHMARK", "NONPRODUCTIVE_TIME"],
      evidence: offerEvidence,
    }),
    makeFact(caseId, "pay-frequency", {
      type: "PAY_FREQUENCY",
      label: "Pay frequency",
      rawValue: "Paid biweekly",
      normalizedValue: "BIWEEKLY",
      confidence: 0.99,
      reviewStatus: "CONFIRMED",
      affects: ["WAGE_BENCHMARK"],
      evidence: offerEvidence,
    }),
    makeFact(caseId, "lca-worksite", {
      type: "LCA_WORKSITE",
      label: "LCA worksite",
      rawValue: "Indianapolis, Indiana 46204",
      normalizedValue: "INDIANAPOLIS|IN",
      confidence: 0.99,
      reviewStatus: "CONFIRMED",
      affects: ["EMPLOYMENT_FACTS"],
      evidence: lcaWorksiteEvidence,
    }),
    makeFact(caseId, "offer-worksite", {
      type: "OFFER_WORKSITE",
      label: "Offer worksite",
      rawValue: "Indianapolis, Indiana",
      normalizedValue: "INDIANAPOLIS|IN",
      confidence: 0.99,
      reviewStatus: "CONFIRMED",
      affects: ["EMPLOYMENT_FACTS"],
      evidence: offerEvidence,
    }),
    ...payEvidence.map((evidence, index) =>
      makeFact(caseId, `base-earnings-${index + 1}`, {
        type: "ORDINARY_BASE_EARNINGS_CENTS",
        label: `Ordinary base earnings, pay period ${index + 1}`,
        rawValue: "$4,615.38",
        normalizedValue: "461538",
        unit: "USD_CENTS_PER_PERIOD",
        confidence: 0.99,
        reviewStatus: "CONFIRMED",
        affects: ["WAGE_BENCHMARK"],
        evidence,
      }),
    ),
    makeFact(caseId, "routine-deduction", {
      type: "DEDUCTION_CATEGORY",
      label: "Health-premium deduction",
      rawValue: "Employee health plan premium -$125.00",
      normalizedValue: "ORDINARY_TAX_OR_BENEFIT_DEDUCTION",
      confidence: 0.99,
      reviewStatus: "CONFIRMED",
      affects: ["DEDUCTIONS_FEES"],
      evidence: routineDeductionEvidence,
    }),
    makeFact(caseId, "temporary-travel", {
      type: "WORKSITE_CHANGE",
      label: "Temporary client travel",
      rawValue: "One-day Cincinnati client visit; return to Indianapolis",
      normalizedValue: "CINCINNATI|OH|TEMPORARY_ONE_DAY",
      confidence: 0.99,
      reviewStatus: "CONFIRMED",
      affects: ["EMPLOYMENT_FACTS"],
      evidence: travelEvidence,
    }),
  ];

  const deductions: DeductionObservation[] = [
    {
      id: `${caseId}-deduction-health-premium`,
      description: "Employee health plan premium",
      amountCents: 12_500,
      date: "2026-05-01",
      category: "ORDINARY_TAX_OR_BENEFIT_DEDUCTION",
      transactionStatus: "PAYROLL_OBSERVED",
      descriptionConfidence: 0.99,
      evidence: routineDeductionEvidence,
    },
  ];

  const events: EmploymentEvent[] = [
    {
      id: `${caseId}-event-employment-start`,
      kind: "EMPLOYMENT_START",
      title: "Full-time employment begins",
      start: "2026-03-02",
      certainty: "CONFIRMED",
      employmentActive: true,
      worksite: "Indianapolis, Indiana",
      evidence: [offerEvidence, lcaWorksiteEvidence],
    },
    ...makePayPeriodEvents(caseId, payPeriods),
    {
      id: `${caseId}-event-temporary-travel`,
      kind: "WORKSITE_CHANGE",
      title: "Documented one-day client visit",
      start: "2026-04-22",
      end: "2026-04-23",
      certainty: "CONFIRMED",
      attribution: "EMPLOYER",
      employmentActive: true,
      worksite: "Cincinnati, Ohio",
      qualifier: "TEMPORARY",
      evidence: [travelEvidence, lcaWorksiteEvidence, offerEvidence],
    },
  ];

  const findings: Finding[] = [
    makeFinding(caseId, "wage-benchmark", {
      module: "WAGE_BENCHMARK",
      status: "NO_MISMATCH_DETECTED",
      attention: "INFORMATIONAL",
      headline: "Observed ordinary base pay matches the documented benchmark",
      summary:
        "Four complete biweekly periods are consistent with the $120,000 annual LCA and offer amounts within rounding tolerance.",
      amountCents: 0,
      amountLabel: "estimated documented difference",
      period: { start: "2026-03-02", end: "2026-04-27" },
      calculation: {
        formula: "$120,000 / 26 compared with $4,615.38 per period",
        rows: [
          { label: "Expected per biweekly period", value: "$4,615.38" },
          { label: "Observed per period", value: "$4,615.38" },
          { label: "Complete comparable periods", value: "4" },
          { label: "Difference within tolerance", value: "$0.00", emphasis: true },
        ],
        method:
          "Each complete period is compared independently using decimal arithmetic and the configured rounding tolerance.",
      },
      evidence: [lcaWageEvidence, offerEvidence, ...payEvidence],
      source: SOURCES.WAGE_BENCHMARK,
      assumptions: ["The four paystubs are complete ordinary periods."],
      limitations: [
        "This comparison does not establish the employer's internal actual-wage system.",
      ],
      questions: ["Are any other payrolls or amendments relevant to this review period?"],
      confidence: { extraction: 0.99, evidence: 0.99, context: 0.95 },
      diagnostics: ["WAGE_MATCH_WITHIN_TOLERANCE"],
      includeInReport: true,
      disposition: "UNREVIEWED",
    }),
    makeFinding(caseId, "nonproductive-time", {
      module: "NONPRODUCTIVE_TIME",
      status: "NO_MISMATCH_DETECTED",
      attention: "INFORMATIONAL",
      headline: "No employer-related unpaid interval appears in the reviewed records",
      summary:
        "The available complete payroll periods contain ordinary base pay and no project-delay or no-assignment event is documented.",
      calculation: null,
      evidence: [offerEvidence, ...payEvidence],
      source: SOURCES.NONPRODUCTIVE_TIME,
      assumptions: ["The uploaded records cover the selected review period."],
      limitations: ["An unuploaded event or pay record would not be reflected."],
      questions: ["Were there any unpaid intervals not represented in these records?"],
      confidence: { extraction: 0.99, evidence: 0.97, context: 0.94 },
      diagnostics: ["NPT_NO_EVENT_FOUND"],
      includeInReport: true,
      disposition: "UNREVIEWED",
    }),
    makeFinding(caseId, "deductions-fees", {
      module: "DEDUCTIONS_FEES",
      status: "NO_MISMATCH_DETECTED",
      attention: "INFORMATIONAL",
      headline: "Only an ordinary elected-benefit deduction was identified",
      summary:
        "The reviewed deduction is labeled as an employee health-plan premium and no conflicting fee evidence appears.",
      amountCents: 12_500,
      amountLabel: "observed elected-benefit deduction",
      period: { start: "2026-04-13", end: "2026-05-01" },
      calculation: null,
      evidence: [routineDeductionEvidence],
      source: SOURCES.DEDUCTIONS_FEES,
      assumptions: ["The health-plan election remains applicable to this payroll."],
      limitations: ["The module does not provide tax or benefits advice."],
      questions: ["Does the deduction match the worker's benefit election?"],
      confidence: { extraction: 0.99, evidence: 0.99, context: 0.93 },
      diagnostics: ["DEDUCTION_ROUTINE_CATEGORY"],
      includeInReport: true,
      disposition: "UNREVIEWED",
    }),
    makeFinding(caseId, "employment-facts", {
      module: "EMPLOYMENT_FACTS",
      status: "NO_MISMATCH_DETECTED",
      attention: "INFORMATIONAL",
      headline: "Primary worksite records are consistent",
      summary:
        "The LCA and offer identify Indianapolis, and the only different-location record explicitly describes a one-day visit followed by return.",
      period: { start: "2026-03-02", end: "2026-05-01" },
      calculation: null,
      evidence: [lcaWorksiteEvidence, offerEvidence, travelEvidence],
      source: SOURCES.EMPLOYMENT_FACTS,
      assumptions: ["The client visit occurred only for the documented day."],
      limitations: ["Later or longer location changes are outside this record set."],
      questions: ["Did the temporary visit extend beyond the documented date?"],
      confidence: { extraction: 0.99, evidence: 0.99, context: 0.94 },
      diagnostics: ["WORKSITE_TEMPORARY_CONTEXT_ACCEPTED"],
      includeInReport: true,
      disposition: "UNREVIEWED",
    }),
  ];

  return {
    ...commonCaseFields(caseId, ownerUserId, times),
    scenario: "clean",
    title: "Priya Shah - synthetic clean review",
    workerName: "Priya Shah",
    employerName: "Meridian Analytics Group LLC",
    position: "Business Systems Analyst",
    reviewStart: "2026-03-02",
    reviewEnd: "2026-05-01",
    state: "RESULTS_READY",
    stateVersion: 7,
    documents,
    facts,
    payPeriods,
    deductions,
    events,
    findings,
    lastAnalysisAt: times.analyzedAt,
  };
}

async function createAmbiguousCase(
  caseId: string,
  ownerUserId: string,
  times: LifecycleTimes,
): Promise<CasePayload> {
  const documents = await createDocuments(caseId, times.uploadedAt, [
    {
      key: "lca",
      name: "01-synthetic-ambiguous-lca.pdf",
      type: "LCA_CERTIFIED",
      required: true,
      pages: 4,
      bytes: 478_900,
      note: "Certified-LCA-style fixture with a $110,000 annual wage and Indianapolis worksite.",
    },
    {
      key: "offer",
      name: "02-synthetic-ambiguous-offer.pdf",
      type: "OFFER_OR_EMPLOYMENT_LETTER",
      required: true,
      pages: 2,
      bytes: 171_200,
      note: "Offer fixture showing a mid-period start and biweekly $110,000 annual salary.",
    },
    {
      key: "partial-pay",
      name: "03-synthetic-partial-first-paystub.pdf",
      type: "PAYSTUB",
      required: true,
      pages: 1,
      bytes: 88_420,
      note: "First payroll fixture covering only one week after the employment start date.",
    },
    {
      key: "regular-pay",
      name: "04-synthetic-paystub-unknown-deduction.pdf",
      type: "PAYSTUB",
      required: true,
      pages: 1,
      bytes: 91_330,
      note: "Complete payroll fixture with ordinary base $4,230.77 and an unexplained deduction labeled code 401.",
    },
    {
      key: "undated-delay",
      name: "05-synthetic-project-delay-missing-year.pdf",
      type: "WORK_MESSAGE",
      required: false,
      pages: 1,
      bytes: 122_880,
      note: "Message screenshot fixture whose visible timestamp omits the year and whose project-delay interval has no end date.",
    },
    {
      key: "remote-message",
      name: "06-synthetic-remote-work-unknown-duration.pdf",
      type: "WORK_MESSAGE",
      required: false,
      pages: 1,
      bytes: 119_760,
      note: "Remote-work instruction fixture with no physical location or expected duration.",
    },
  ]);

  const lca = getDocument(documents, caseId, "lca");
  const offer = getDocument(documents, caseId, "offer");
  const partialPayDocument = getDocument(documents, caseId, "partial-pay");
  const regularPayDocument = getDocument(documents, caseId, "regular-pay");
  const delayDocument = getDocument(documents, caseId, "undated-delay");
  const remoteDocument = getDocument(documents, caseId, "remote-message");

  const workerEvidence = makeEvidence(
    caseId,
    "ambiguous-worker",
    lca,
    1,
    "Worker name",
    "Worker: Sofia Alvarez",
    "context",
  );
  const employerEvidence = makeEvidence(
    caseId,
    "ambiguous-employer",
    lca,
    1,
    "Petitioning employer",
    "Harborview Technical Services Inc.",
    "benchmark",
  );
  const lcaWageEvidence = makeEvidence(
    caseId,
    "ambiguous-lca-wage",
    lca,
    2,
    "LCA wage offered",
    "Rate of Pay: $110,000.00 per Year",
    "benchmark",
  );
  const lcaWorksiteEvidence = makeEvidence(
    caseId,
    "ambiguous-lca-worksite",
    lca,
    3,
    "LCA worksite",
    "Place of Employment: Indianapolis, Indiana 46204",
    "benchmark",
  );
  const offerEvidence = makeEvidence(
    caseId,
    "ambiguous-offer",
    offer,
    1,
    "Offer terms",
    "Full-time Cloud Support Engineer; $110,000 annual base; biweekly payroll; Indianapolis worksite; employment begins March 9, 2026.",
    "context",
  );
  const partialPayEvidence = makeEvidence(
    caseId,
    "ambiguous-partial-pay",
    partialPayDocument,
    1,
    "Partial first pay period",
    "Pay period 2026-03-02 through 2026-03-15; hire date 2026-03-09; Regular Salary $2,115.38.",
    "observed",
  );
  const regularPayEvidence = makeEvidence(
    caseId,
    "ambiguous-regular-pay",
    regularPayDocument,
    1,
    "Complete regular pay period",
    "Pay period 2026-03-16 through 2026-03-29; Regular Salary $4,230.77.",
    "observed",
  );
  const unknownDeductionEvidence = makeEvidence(
    caseId,
    "ambiguous-deduction",
    regularPayDocument,
    1,
    "Unexplained payroll code",
    "Deduction code 401  -$650.00",
    "observed",
  );
  const delayEvidence = makeEvidence(
    caseId,
    "ambiguous-delay",
    delayDocument,
    1,
    "Project-delay message with incomplete date",
    "Apr 8, year not visible: The next project is delayed. Please wait for an update.",
    "context",
  );
  const remoteEvidence = makeEvidence(
    caseId,
    "ambiguous-remote",
    remoteDocument,
    1,
    "Remote-work instruction without duration",
    "Starting next month, work remotely until we provide another update.",
    "context",
  );

  const payPeriodSpecs: PayPeriodSpec[] = [
    {
      key: "partial",
      documentKey: "partial-pay",
      start: "2026-03-02",
      end: "2026-03-15",
      payDate: "2026-03-20",
      ordinaryBaseCents: 211_538,
      grossCents: 211_538,
      complete: false,
      comparable: false,
      correctionStatus: "UNKNOWN",
    },
    {
      key: "regular",
      documentKey: "regular-pay",
      start: "2026-03-16",
      end: "2026-03-29",
      payDate: "2026-04-03",
      ordinaryBaseCents: 423_077,
      grossCents: 423_077,
      complete: true,
      comparable: true,
      correctionStatus: "NONE",
    },
  ];
  const payPeriods = [
    makePayPeriod(caseId, payPeriodSpecs[0], partialPayEvidence),
    makePayPeriod(caseId, payPeriodSpecs[1], regularPayEvidence),
  ];

  const facts: FactRecord[] = [
    makeFact(caseId, "worker-name", {
      type: "WORKER_NAME",
      label: "Worker name",
      rawValue: "Sofia Alvarez",
      normalizedValue: "Sofia Alvarez",
      confidence: 0.99,
      reviewStatus: "CONFIRMED",
      affects: ["WAGE_BENCHMARK", "EMPLOYMENT_FACTS"],
      evidence: workerEvidence,
    }),
    makeFact(caseId, "employer-name", {
      type: "EMPLOYER_NAME",
      label: "Petitioning employer",
      rawValue: "Harborview Technical Services Inc.",
      normalizedValue: "HARBORVIEW TECHNICAL SERVICES INC",
      confidence: 0.98,
      reviewStatus: "CONFIRMED",
      affects: ["WAGE_BENCHMARK", "EMPLOYMENT_FACTS"],
      evidence: employerEvidence,
    }),
    makeFact(caseId, "position", {
      type: "POSITION_TITLE",
      label: "Position",
      rawValue: "Cloud Support Engineer",
      normalizedValue: "CLOUD SUPPORT ENGINEER",
      confidence: 0.98,
      reviewStatus: "CONFIRMED",
      affects: ["EMPLOYMENT_FACTS"],
      evidence: offerEvidence,
    }),
    makeFact(caseId, "employment-status", {
      type: "EMPLOYMENT_STATUS",
      label: "Employment status",
      rawValue: "Full-time employment begins March 9, 2026",
      normalizedValue: "ACTIVE_FULL_TIME|START=2026-03-09",
      confidence: 0.98,
      reviewStatus: "CONFIRMED",
      affects: ["WAGE_BENCHMARK", "NONPRODUCTIVE_TIME"],
      evidence: offerEvidence,
    }),
    makeFact(caseId, "lca-wage", {
      type: "LCA_WAGE_ANNUAL_CENTS",
      label: "LCA-listed annual wage",
      rawValue: "$110,000.00 per year",
      normalizedValue: "11000000",
      unit: "USD_CENTS_PER_YEAR",
      confidence: 0.99,
      reviewStatus: "CONFIRMED",
      affects: ["WAGE_BENCHMARK", "NONPRODUCTIVE_TIME"],
      evidence: lcaWageEvidence,
    }),
    makeFact(caseId, "offer-wage", {
      type: "OFFER_WAGE_ANNUAL_CENTS",
      label: "Offer annual base salary",
      rawValue: "$110,000.00 per year",
      normalizedValue: "11000000",
      unit: "USD_CENTS_PER_YEAR",
      confidence: 0.98,
      reviewStatus: "CONFIRMED",
      affects: ["WAGE_BENCHMARK", "NONPRODUCTIVE_TIME"],
      evidence: offerEvidence,
    }),
    makeFact(caseId, "pay-frequency", {
      type: "PAY_FREQUENCY",
      label: "Pay frequency",
      rawValue: "Paid biweekly",
      normalizedValue: "BIWEEKLY",
      confidence: 0.98,
      reviewStatus: "CONFIRMED",
      affects: ["WAGE_BENCHMARK"],
      evidence: offerEvidence,
    }),
    makeFact(caseId, "lca-worksite", {
      type: "LCA_WORKSITE",
      label: "LCA worksite",
      rawValue: "Indianapolis, Indiana 46204",
      normalizedValue: "INDIANAPOLIS|IN",
      confidence: 0.99,
      reviewStatus: "CONFIRMED",
      affects: ["EMPLOYMENT_FACTS"],
      evidence: lcaWorksiteEvidence,
    }),
    makeFact(caseId, "offer-worksite", {
      type: "OFFER_WORKSITE",
      label: "Offer worksite",
      rawValue: "Indianapolis, Indiana",
      normalizedValue: "INDIANAPOLIS|IN",
      confidence: 0.98,
      reviewStatus: "CONFIRMED",
      affects: ["EMPLOYMENT_FACTS"],
      evidence: offerEvidence,
    }),
    makeFact(caseId, "partial-period", {
      type: "PAY_PERIOD_COMPLETENESS",
      label: "First pay-period completeness",
      rawValue: "Employment begins one week into the pay period",
      normalizedValue: "PARTIAL_FIRST_PERIOD",
      confidence: 0.99,
      reviewStatus: "NEEDS_REVIEW",
      affects: ["WAGE_BENCHMARK"],
      evidence: partialPayEvidence,
    }),
    makeFact(caseId, "unknown-deduction", {
      type: "DEDUCTION_CATEGORY",
      label: "Unexplained deduction code",
      rawValue: "Deduction code 401 -$650.00",
      normalizedValue: "UNKNOWN",
      confidence: 0.42,
      reviewStatus: "NEEDS_REVIEW",
      affects: ["DEDUCTIONS_FEES"],
      evidence: unknownDeductionEvidence,
    }),
    makeFact(caseId, "delay-date", {
      type: "NONPRODUCTIVE_TIME_EVENT_DATE",
      label: "Project-delay message date",
      rawValue: "Apr 8 (year not visible)",
      normalizedValue: "MONTH_DAY_ONLY|04-08",
      confidence: 0.61,
      reviewStatus: "NEEDS_REVIEW",
      affects: ["NONPRODUCTIVE_TIME"],
      evidence: delayEvidence,
    }),
    makeFact(caseId, "remote-duration", {
      type: "WORKSITE_CHANGE",
      label: "Remote-work duration and location",
      rawValue: "Starting next month, work remotely until another update",
      normalizedValue: "REMOTE|LOCATION=UNKNOWN|DURATION=UNKNOWN",
      confidence: 0.76,
      reviewStatus: "NEEDS_REVIEW",
      affects: ["EMPLOYMENT_FACTS"],
      evidence: remoteEvidence,
    }),
  ];

  const deductions: DeductionObservation[] = [
    {
      id: `${caseId}-deduction-code-401`,
      description: "Deduction code 401",
      amountCents: 65_000,
      date: "2026-04-03",
      category: "UNKNOWN",
      transactionStatus: "PAYROLL_OBSERVED",
      descriptionConfidence: 0.42,
      evidence: unknownDeductionEvidence,
    },
  ];

  const events: EmploymentEvent[] = [
    {
      id: `${caseId}-event-employment-start`,
      kind: "EMPLOYMENT_START",
      title: "Employment begins during an open pay period",
      start: "2026-03-09",
      certainty: "CONFIRMED",
      employmentActive: true,
      worksite: "Indianapolis, Indiana",
      evidence: [offerEvidence, lcaWorksiteEvidence],
    },
    ...makePayPeriodEvents(caseId, payPeriods),
    {
      id: `${caseId}-event-undated-delay`,
      kind: "NONPRODUCTIVE_TIME",
      title: "Project-delay message cannot be aligned to payroll",
      start: "2026-04-08",
      certainty: "UNKNOWN",
      attribution: "UNKNOWN",
      workerAvailable: null,
      employmentActive: true,
      voluntaryLeave: null,
      observedBaseCents: null,
      evidence: [delayEvidence],
    },
    {
      id: `${caseId}-event-remote-work`,
      kind: "WORKSITE_CHANGE",
      title: "Remote-work instruction has no location or duration",
      start: "2026-05-01",
      certainty: "UNKNOWN",
      attribution: "EMPLOYER",
      employmentActive: true,
      worksite: "Remote - physical location not stated",
      qualifier: "REMOTE",
      evidence: [remoteEvidence, lcaWorksiteEvidence, offerEvidence],
    },
  ];

  const findings: Finding[] = [
    makeFinding(caseId, "wage-benchmark", {
      module: "WAGE_BENCHMARK",
      status: "HUMAN_REVIEW_REQUIRED",
      attention: "CONTEXT_NEEDED",
      headline: "The first pay period is partial and should not be annualized",
      summary:
        "Employment began one week into the first payroll period; the next complete period matches the documented benchmark within rounding tolerance.",
      period: { start: "2026-03-02", end: "2026-03-30" },
      calculation: {
        formula: "Complete periods only: $110,000 / 26 compared with $4,230.77",
        rows: [
          { label: "Partial first-period base", value: "$2,115.38" },
          { label: "Expected complete-period base", value: "$4,230.77" },
          { label: "Observed next complete period", value: "$4,230.77" },
          { label: "Automatic first-period comparison", value: "Excluded", emphasis: true },
        ],
        method:
          "The partial first period is excluded from automatic discrepancy status; only the complete period is directly comparable.",
      },
      evidence: [lcaWageEvidence, offerEvidence, partialPayEvidence, regularPayEvidence],
      source: SOURCES.WAGE_BENCHMARK,
      assumptions: ["The offer start date is accurate."],
      limitations: ["The exact payroll proration method is not shown."],
      questions: [
        "Did the first paystub cover only the week after the start date?",
        "Was another onboarding or off-cycle payment issued?",
      ],
      confidence: { extraction: 0.98, evidence: 0.97, context: 0.57 },
      diagnostics: ["WAGE_PERIOD_PARTIAL"],
      includeInReport: true,
      disposition: "NEEDS_REVIEW",
    }),
    makeFinding(caseId, "nonproductive-time", {
      module: "NONPRODUCTIVE_TIME",
      status: "HUMAN_REVIEW_REQUIRED",
      attention: "CONTEXT_NEEDED",
      headline: "More evidence is needed to understand the project-delay message",
      summary:
        "The screenshot omits the year and end date, does not establish readiness, and cannot be aligned to a missing-pay interval.",
      calculation: null,
      evidence: [delayEvidence],
      source: SOURCES.NONPRODUCTIVE_TIME,
      assumptions: ["The visible message text was extracted accurately."],
      limitations: [
        "No matching pay record, availability statement, or complete date interval is available.",
      ],
      questions: [
        "What year and date range did the message cover?",
        "Was the worker ready and available?",
        "Which paystub covers that interval?",
      ],
      confidence: { extraction: 0.86, evidence: 0.64, context: 0.22 },
      diagnostics: ["NPT_EVENT_DATE_UNCERTAIN", "NPT_PAY_EVIDENCE_MISSING"],
      includeInReport: true,
      disposition: "NEEDS_REVIEW",
    }),
    makeFinding(caseId, "deductions-fees", {
      module: "DEDUCTIONS_FEES",
      status: "INSUFFICIENT_EVIDENCE",
      attention: "CONTEXT_NEEDED",
      headline: "The purpose of deduction code 401 is unclear",
      summary:
        "A $650 payroll deduction is visible, but the code does not provide enough information to assign an issue category.",
      amountCents: 65_000,
      amountLabel: "observed deduction with unknown purpose",
      period: { start: "2026-03-16", end: "2026-04-03" },
      calculation: null,
      evidence: [unknownDeductionEvidence, regularPayEvidence],
      source: SOURCES.DEDUCTIONS_FEES,
      assumptions: ["The OCR correctly read the code as 401."],
      limitations: ["A payroll legend, authorization, or benefits record is missing."],
      questions: [
        "What does code 401 mean in this payroll system?",
        "Is there a deduction authorization or benefit election?",
      ],
      confidence: { extraction: 0.82, evidence: 0.78, context: 0.18 },
      diagnostics: ["DEDUCTION_DESCRIPTION_UNCLEAR"],
      includeInReport: true,
      disposition: "NEEDS_REVIEW",
    }),
    makeFinding(caseId, "employment-facts", {
      module: "EMPLOYMENT_FACTS",
      status: "HUMAN_REVIEW_REQUIRED",
      attention: "CONTEXT_NEEDED",
      headline: "Remote-work instructions do not identify a location or duration",
      summary:
        "The LCA and offer name Indianapolis, while the later message says to work remotely without stating where or for how long.",
      period: { start: "2026-05-01", end: "2026-06-30" },
      calculation: null,
      evidence: [lcaWorksiteEvidence, offerEvidence, remoteEvidence],
      source: SOURCES.EMPLOYMENT_FACTS,
      assumptions: ["The remote-work message applies to this employment period."],
      limitations: [
        "The worker's physical location, duration, commuting-area context, and other filings are not available.",
      ],
      questions: [
        "From what location was remote work expected?",
        "Was the instruction temporary?",
        "Is another LCA or amendment available?",
      ],
      confidence: { extraction: 0.91, evidence: 0.86, context: 0.27 },
      diagnostics: ["WORKSITE_CONTEXT_REQUIRED"],
      includeInReport: true,
      disposition: "NEEDS_REVIEW",
    }),
  ];

  return {
    ...commonCaseFields(caseId, ownerUserId, times),
    scenario: "ambiguous",
    title: "Sofia Alvarez - synthetic ambiguous review",
    workerName: "Sofia Alvarez",
    employerName: "Harborview Technical Services Inc.",
    position: "Cloud Support Engineer",
    reviewStart: "2026-03-02",
    reviewEnd: "2026-06-30",
    state: "RESULTS_READY",
    stateVersion: 7,
    documents,
    facts,
    payPeriods,
    deductions,
    events,
    findings,
    lastAnalysisAt: times.analyzedAt,
  };
}

function createCustomCase(
  caseId: string,
  ownerUserId: string,
  times: LifecycleTimes,
): CasePayload {
  const end = times.updatedAt.slice(0, 10);
  const year = end.slice(0, 4);
  return {
    ...commonCaseFields(caseId, ownerUserId, times),
    scenario: "custom",
    title: "Custom private evidence review",
    workerName: "",
    employerName: "",
    position: "",
    reviewStart: `${year}-01-01`,
    reviewEnd: end,
    state: "INTAKE_COMPLETE",
    stateVersion: 2,
    documents: [],
    facts: [],
    payPeriods: [],
    deductions: [],
    events: [],
    findings: [],
  };
}

export async function createFixtureCase(
  scenario: Scenario,
  caseId: string,
  ownerUserId: string,
  now?: FixtureNow,
): Promise<CasePayload> {
  if (!caseId.trim()) throw new TypeError("caseId is required");
  if (!ownerUserId.trim()) throw new TypeError("ownerUserId is required");

  const times = lifecycleTimes(now);
  switch (scenario) {
    case "hero":
      return createHeroCase(caseId, ownerUserId, times);
    case "clean":
      return createCleanCase(caseId, ownerUserId, times);
    case "ambiguous":
      return createAmbiguousCase(caseId, ownerUserId, times);
    case "custom":
      return createCustomCase(caseId, ownerUserId, times);
    default: {
      const unreachable: never = scenario;
      throw new TypeError(`Unsupported fixture scenario: ${String(unreachable)}`);
    }
  }
}
