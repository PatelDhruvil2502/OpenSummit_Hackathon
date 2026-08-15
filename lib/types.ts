export type Scenario = "hero" | "clean" | "ambiguous" | "custom";
export type CaseMode = "STANDARD" | "SANDBOX";

export type CaseState =
  | "DRAFT"
  | "INTAKE_COMPLETE"
  | "UPLOADING"
  | "PROCESSING"
  | "FACT_REVIEW_REQUIRED"
  | "READY_FOR_ANALYSIS"
  | "ANALYZING"
  | "RESULTS_READY"
  | "REPORTING"
  | "REPORT_FAILED"
  | "PROCESSING_FAILED"
  | "ANALYSIS_FAILED"
  | "UPLOAD_FAILED"
  | "DELETION_PENDING"
  | "DELETION_FAILED"
  | "DELETED";

export type FindingStatus =
  | "NO_MISMATCH_DETECTED"
  | "POSSIBLE_DISCREPANCY"
  | "INSUFFICIENT_EVIDENCE"
  | "CONFLICTING_EVIDENCE"
  | "HUMAN_REVIEW_REQUIRED";

export type FindingModule =
  | "WAGE_BENCHMARK"
  | "NONPRODUCTIVE_TIME"
  | "DEDUCTIONS_FEES"
  | "EMPLOYMENT_FACTS";

export type DocumentType =
  | "LCA_CERTIFIED"
  | "OFFER_OR_EMPLOYMENT_LETTER"
  | "PAYSTUB"
  | "TIMESHEET"
  | "WORK_MESSAGE"
  | "LEAVE_NOTICE"
  | "TERMINATION_NOTICE"
  | "PETITION_SUPPORT_LETTER"
  | "OTHER";

export type ReviewStatus = "CONFIRMED" | "USER_CORRECTED" | "NEEDS_REVIEW";

export interface EvidenceRef {
  id: string;
  documentId: string;
  documentName: string;
  page: number;
  label: string;
  text: string;
  role: "benchmark" | "observed" | "context" | "contradiction";
}

export interface SourcePassage {
  id: string;
  authority: string;
  title: string;
  url: string;
  section: string;
  retrievedAt: string;
  reviewedAt: string;
  version: string;
  paraphrase: string;
  caveat: string;
}

export interface CalculationRow {
  label: string;
  value: string;
  emphasis?: boolean;
}

export interface Finding {
  id: string;
  module: FindingModule;
  status: FindingStatus;
  attention: "REVIEW_NOW" | "REVIEW_SOON" | "CONTEXT_NEEDED" | "INFORMATIONAL";
  headline: string;
  summary: string;
  amountCents?: number;
  amountLabel?: string;
  period?: { start: string; end: string };
  calculation: {
    formula: string;
    rows: CalculationRow[];
    method: string;
  } | null;
  evidence: EvidenceRef[];
  source: SourcePassage;
  assumptions: string[];
  limitations: string[];
  questions: string[];
  confidence: {
    extraction: number;
    evidence: number;
    context: number;
  };
  diagnostics: string[];
  includeInReport: boolean;
  disposition: "UNREVIEWED" | "EXPLAINED" | "IRRELEVANT" | "NEEDS_REVIEW";
  ruleVersion: string;
}

export interface DocumentRecord {
  id: string;
  name: string;
  type: DocumentType;
  required: boolean;
  status: "READY" | "PROCESSING" | "NEEDS_REVIEW" | "REJECTED";
  pages: number;
  bytes: number;
  contentType: string;
  hash: string;
  synthetic: boolean;
  uploadedAt: string;
  objectKey?: string;
  note?: string;
  extraction?: {
    method: "PDF_TEXT_LAYER" | "IMAGE_REVIEW_REQUIRED";
    characterCount: number;
    proposedFactCount: number;
    proposedPayPeriodCount: number;
    proposedDeductionCount: number;
    warnings: string[];
    completedAt: string;
  };
}

export interface FactRecord {
  id: string;
  type: string;
  label: string;
  rawValue: string;
  normalizedValue: string;
  unit?: string;
  confidence: number;
  reviewStatus: ReviewStatus;
  affects: FindingModule[];
  evidence: EvidenceRef;
  origin?: "FIXTURE" | "EXTRACTED" | "USER_ENTERED";
  originalRawValue?: string;
  reviewedAt?: string;
  userEditedAt?: string;
}

export interface PayPeriod {
  id: string;
  start: string;
  end: string;
  payDate: string;
  ordinaryBaseCents: number;
  grossCents: number;
  complete: boolean;
  comparable: boolean;
  correctionStatus: "NONE" | "RESOLVED" | "EXPECTED" | "UNKNOWN";
  reviewStatus?: ReviewStatus;
  sourceDocumentId?: string;
  reviewedAt?: string;
  evidence: EvidenceRef;
}

export interface DeductionObservation {
  id: string;
  description: string;
  amountCents: number;
  date: string;
  category:
    | "PETITION_OR_LEGAL_FEE_REFERENCE"
    | "EMPLOYER_BUSINESS_EXPENSE_REFERENCE"
    | "EARLY_DEPARTURE_REFERENCE"
    | "TRAINING_OR_RELOCATION_REFERENCE"
    | "ORDINARY_TAX_OR_BENEFIT_DEDUCTION"
    | "UNKNOWN";
  transactionStatus: "PAYROLL_OBSERVED" | "DIRECT_REQUEST" | "CLAUSE_ONLY";
  descriptionConfidence: number;
  reviewStatus?: ReviewStatus;
  sourceDocumentId?: string;
  reviewedAt?: string;
  evidence: EvidenceRef;
}

export interface ReportRecord {
  id: string;
  generatedAt: string;
  sha256: string;
  objectKey: string;
  caseSnapshotVersion: number;
  includedFindingIds: string[];
  redactions: string[];
  status: "CURRENT" | "SUPERSEDED";
}

export interface EmploymentEvent {
  id: string;
  kind: "EMPLOYMENT_START" | "PAY_PERIOD" | "NONPRODUCTIVE_TIME" | "WORKSITE_CHANGE";
  title: string;
  start: string;
  end?: string;
  certainty: "CONFIRMED" | "APPROXIMATE" | "UNKNOWN";
  attribution?: "EMPLOYER" | "WORKER" | "UNKNOWN";
  workerAvailable?: boolean | null;
  employmentActive?: boolean | null;
  voluntaryLeave?: boolean | null;
  observedBaseCents?: number | null;
  worksite?: string;
  qualifier?: "ONGOING" | "TEMPORARY" | "REMOTE" | "UNKNOWN";
  evidence: EvidenceRef[];
}

export interface CasePayload {
  id: string;
  /** Stable Sites/ChatGPT user identifier. Never expose this in API payloads. */
  ownerUserId: string;
  mode: CaseMode;
  scenario: Scenario;
  title: string;
  workerName: string;
  employerName: string;
  position: string;
  reviewStart: string;
  reviewEnd: string;
  state: CaseState;
  stateVersion: number;
  consentVersion: string;
  authorizedUseConfirmed: boolean;
  retentionHours: number;
  retentionExpiresAt: string;
  createdAt: string;
  updatedAt: string;
  ruleSetVersion: string;
  sourceCorpusVersion: string;
  documents: DocumentRecord[];
  facts: FactRecord[];
  payPeriods: PayPeriod[];
  deductions: DeductionObservation[];
  events: EmploymentEvent[];
  findings: Finding[];
  corrections: Array<{
    id: string;
    factId: string;
    previousValue: string;
    newValue: string;
    createdAt: string;
  }>;
  lastAnalysisAt?: string;
  reports?: ReportRecord[];
  lastReport?: ReportRecord;
}

export interface CaseSummary {
  id: string;
  title: string;
  mode: CaseMode;
  scenario: Scenario;
  state: CaseState;
  workerName: string;
  employerName: string;
  reviewStart: string;
  reviewEnd: string;
  updatedAt: string;
  retentionExpiresAt: string;
  documentCount: number;
  findingCount: number;
}

export interface AuditEvent {
  id: string;
  caseId: string;
  eventType: string;
  safeMetadata: Record<string, string | number | boolean>;
  createdAt: string;
}
