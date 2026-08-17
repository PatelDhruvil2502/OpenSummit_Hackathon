import assert from "node:assert/strict";
import test from "node:test";

import { scoreEvaluationDataset } from "../../scripts/ai-eval-score.mjs";

// These objects test scorer arithmetic only. They are not model responses and
// must never be reported as a WageShield model-evaluation result.
const gold = {
  schemaVersion: 1,
  datasetId: "scorer-unit-test",
  syntheticOnly: true,
  cases: [
    {
      id: "synthetic-case",
      sourcePages: [
        {
          documentId: "doc-a",
          page: 1,
          text: "FICTIONAL SYNTHETIC RECORD. Annual wage: $100,000.00.",
        },
      ],
      targets: [
        {
          id: "wage",
          kind: "fact",
          field: "ANNUAL_WAGE_CENTS",
          normalizedValue: "10000000",
          evidence: {
            documentId: "doc-a",
            page: 1,
            quote: "Annual wage: $100,000.00.",
          },
        },
      ],
      requiredAbstentions: [{ id: "worksite", field: "WORKSITE", reasonCode: "MISSING" }],
      expectedConflicts: [
        { id: "wage-conflict", field: "ANNUAL_WAGE_CENTS", documentIds: ["doc-a"] },
      ],
    },
  ],
};

function predictions(overrides = {}) {
  return {
    schemaVersion: 1,
    datasetId: "scorer-unit-test",
    syntheticOnly: true,
    run: { fixtureType: "SCORER_UNIT_TEST_NOT_A_MODEL_RUN" },
    cases: [
      {
        id: "synthetic-case",
        supported: [
          {
            kind: "fact",
            field: "ANNUAL_WAGE_CENTS",
            normalizedValue: "10000000",
            evidence: {
              documentId: "doc-a",
              page: 1,
              quote: "Annual wage: $100,000.00.",
            },
          },
        ],
        abstentions: [{ field: "WORKSITE", reasonCode: "MISSING" }],
        conflicts: [{ field: "ANNUAL_WAGE_CENTS", documentIds: ["doc-a"] }],
        ...overrides,
      },
    ],
  };
}

test("scores exact extraction, grounding, abstention, and conflict matches", () => {
  const result = scoreEvaluationDataset(gold, predictions());
  assert.equal(result.extraction.f1, 1);
  assert.equal(result.citations.sourceValidity.rate, 1);
  assert.equal(result.citations.targetPageAccuracy.rate, 1);
  assert.equal(result.citations.targetQuoteAccuracy.rate, 1);
  assert.equal(result.citations.groundedAccuracy.rate, 1);
  assert.equal(result.abstention.f1, 1);
  assert.equal(result.conflict.f1, 1);
});

test("counts wrong values, unsupported citations, and missing abstentions", () => {
  const result = scoreEvaluationDataset(
    gold,
    predictions({
      supported: [
        {
          kind: "fact",
          field: "ANNUAL_WAGE_CENTS",
          normalizedValue: "9999999",
          evidence: { documentId: "doc-a", page: 1, quote: "text that is not on the page" },
        },
      ],
      abstentions: [],
      conflicts: [],
    }),
  );
  assert.deepEqual(result.extraction, {
    truePositive: 0,
    falsePositive: 1,
    falseNegative: 1,
    precision: 0,
    recall: 0,
    f1: 0,
  });
  assert.equal(result.abstention.recall, 0);
  assert.equal(result.conflict.recall, 0);
  assert.equal(result.citations.groundedAccuracy.rate, null);
});

test("rejects artifacts that are not explicitly synthetic", () => {
  assert.throws(
    () => scoreEvaluationDataset(gold, { ...predictions(), syntheticOnly: false }),
    /syntheticOnly must be true/,
  );
});

test("a duplicate supported candidate is a false positive", () => {
  const candidate = predictions().cases[0].supported[0];
  const result = scoreEvaluationDataset(gold, predictions({ supported: [candidate, candidate] }));
  assert.equal(result.extraction.truePositive, 1);
  assert.equal(result.extraction.falsePositive, 1);
  assert.equal(result.extraction.precision, 0.5);
});
