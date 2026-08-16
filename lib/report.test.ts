import assert from "node:assert/strict";
import test from "node:test";

import { createFixtureCase } from "./fixtures";
import { correctionsForSelectedFindings, generateReportPdf } from "./report";

test("report corrections are limited to records used by selected findings", async () => {
  const caseData = await createFixtureCase("hero", "case-report-privacy", "owner-report-privacy");
  const wageFinding = caseData.findings.find((finding) => finding.module === "WAGE_BENCHMARK");
  const wageFact = caseData.facts.find((fact) => fact.type === "LCA_WAGE_ANNUAL_CENTS");
  const worksiteFact = caseData.facts.find((fact) => fact.type === "OFFER_WORKSITE");

  assert.ok(wageFinding);
  assert.ok(wageFact);
  assert.ok(worksiteFact);

  caseData.corrections = [
    {
      id: "correction-selected",
      factId: wageFact.id,
      previousValue: "$110,000",
      newValue: "$120,000",
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    {
      id: "correction-private",
      factId: worksiteFact.id,
      previousValue: "Private worksite A",
      newValue: "Private worksite B",
      createdAt: "2026-08-02T00:00:00.000Z",
    },
  ];

  assert.deepEqual(
    correctionsForSelectedFindings(caseData, [wageFinding]).map((item) => item.id),
    ["correction-selected"],
  );
});

test("report omits case title and position unless the user opts in", async () => {
  const caseData = await createFixtureCase("hero", "case-report-fields", "owner-report-fields");
  const finding = caseData.findings[0];
  assert.ok(finding);

  const report = await generateReportPdf(caseData, {
    includedFindingIds: [finding.id],
    redactWorkerName: true,
    redactEmployerName: false,
    includeCaseTitle: false,
    includePosition: false,
  });

  assert.deepEqual(
    report.manifest.redactions.filter((field) => ["case_title", "position"].includes(field)),
    ["case_title", "position"],
  );
  assert.ok(report.bytes.length > 0);
});
