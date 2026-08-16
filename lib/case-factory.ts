import type { CasePayload } from "./types";
import { RULE_SET_VERSION } from "./versions";

export interface StandardCaseInput {
  title: string;
  workerName: string;
  employerName: string;
  position: string;
  reviewStart: string;
  reviewEnd: string;
  retentionHours: number;
}

export function createStandardCase(
  caseId: string,
  ownerUserId: string,
  input: StandardCaseInput,
  now = new Date(),
): CasePayload {
  const createdAt = now.toISOString();
  return {
    id: caseId,
    ownerUserId,
    mode: "STANDARD",
    scenario: "custom",
    title: input.title,
    workerName: input.workerName,
    employerName: input.employerName,
    position: input.position,
    reviewStart: input.reviewStart,
    reviewEnd: input.reviewEnd,
    state: "INTAKE_COMPLETE",
    stateVersion: 1,
    consentVersion: "2026-08-15.2",
    authorizedUseConfirmed: true,
    retentionHours: input.retentionHours,
    retentionExpiresAt: new Date(
      now.getTime() + input.retentionHours * 60 * 60 * 1000,
    ).toISOString(),
    createdAt,
    updatedAt: createdAt,
    ruleSetVersion: RULE_SET_VERSION,
    sourceCorpusVersion: "h1b_sources.2026-08-15",
    documents: [],
    facts: [],
    payPeriods: [],
    deductions: [],
    events: [],
    findings: [],
    corrections: [],
    reports: [],
  };
}
