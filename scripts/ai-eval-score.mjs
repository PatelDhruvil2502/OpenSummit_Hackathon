#!/usr/bin/env node

/**
 * Pure scorer for the WageShield synthetic AI evidence benchmark.
 *
 * This module never calls a model and never contains model answers. It scores
 * a separately generated prediction artifact against human-authored synthetic
 * ground truth. Keeping scoring separate prevents a failed provider call from
 * being mistaken for a benchmark run.
 */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function invariant(condition, message) {
  if (!condition) throw new TypeError(message);
}

function object(value, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function array(value, label) {
  invariant(Array.isArray(value), `${label} must be an array`);
  return value;
}

function nonemptyString(value, label) {
  invariant(typeof value === "string" && value.trim().length > 0, `${label} must be a non-empty string`);
  return value.trim();
}

function positivePage(value, label) {
  invariant(Number.isInteger(value) && value > 0, `${label} must be a positive page number`);
  return value;
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function targetKey(candidate) {
  return [
    nonemptyString(candidate.kind, "candidate.kind"),
    nonemptyString(candidate.field, "candidate.field"),
    stableJson(candidate.normalizedValue),
  ].join("|");
}

function abstentionKey(candidate) {
  return `${nonemptyString(candidate.field, "abstention.field")}|${nonemptyString(candidate.reasonCode, "abstention.reasonCode")}`;
}

function conflictKey(candidate) {
  const documentIds = array(candidate.documentIds, "conflict.documentIds")
    .map((value, index) => nonemptyString(value, `conflict.documentIds[${index}]`))
    .sort();
  invariant(documentIds.length >= 1, "conflict.documentIds must not be empty");
  return `${nonemptyString(candidate.field, "conflict.field")}|${documentIds.join("|")}`;
}

function prf(truePositive, falsePositive, falseNegative) {
  const precision = truePositive + falsePositive === 0 ? null : truePositive / (truePositive + falsePositive);
  const recall = truePositive + falseNegative === 0 ? null : truePositive / (truePositive + falseNegative);
  const f1 = precision === null || recall === null || precision + recall === 0
    ? precision === 0 || recall === 0
      ? 0
      : null
    : (2 * precision * recall) / (precision + recall);
  return {
    truePositive,
    falsePositive,
    falseNegative,
    precision,
    recall,
    f1,
  };
}

function accuracy(correct, total) {
  return { correct, total, rate: total === 0 ? null : correct / total };
}

function matchByKey(expected, predicted, key) {
  const unused = expected.map((value, index) => ({ value, index, used: false }));
  const matches = [];
  let falsePositive = 0;
  for (const prediction of predicted) {
    const predictionKey = key(prediction);
    const match = unused.find((candidate) => !candidate.used && key(candidate.value) === predictionKey);
    if (!match) {
      falsePositive += 1;
      continue;
    }
    match.used = true;
    matches.push({ expected: match.value, predicted: prediction });
  }
  const falseNegative = unused.filter((candidate) => !candidate.used).length;
  return {
    matches,
    metric: prf(matches.length, falsePositive, falseNegative),
  };
}

function evidence(value, label) {
  const result = object(value, label);
  return {
    documentId: nonemptyString(result.documentId, `${label}.documentId`),
    page: positivePage(result.page, `${label}.page`),
    quote: nonemptyString(result.quote, `${label}.quote`),
  };
}

function pageKey(documentId, page) {
  return `${documentId}|${page}`;
}

function citationMetrics(sourcePages, matches) {
  const pages = new Map(
    sourcePages.map((source, index) => {
      const item = object(source, `sourcePages[${index}]`);
      const documentId = nonemptyString(item.documentId, `sourcePages[${index}].documentId`);
      const page = positivePage(item.page, `sourcePages[${index}].page`);
      return [pageKey(documentId, page), normalizeText(item.text)];
    }),
  );

  let sourceValid = 0;
  let targetPageCorrect = 0;
  let targetQuoteCorrect = 0;
  let groundedCorrect = 0;
  for (const match of matches) {
    const actual = evidence(match.predicted.evidence, "prediction.evidence");
    const expected = evidence(match.expected.evidence, "target.evidence");
    const pageText = pages.get(pageKey(actual.documentId, actual.page));
    const quote = normalizeText(actual.quote);
    const expectedQuote = normalizeText(expected.quote);
    const valid = Boolean(pageText && quote && pageText.includes(quote));
    const pageCorrect = actual.documentId === expected.documentId && actual.page === expected.page;
    const quoteCorrect = quote.includes(expectedQuote) || expectedQuote.includes(quote);
    if (valid) sourceValid += 1;
    if (pageCorrect) targetPageCorrect += 1;
    if (quoteCorrect) targetQuoteCorrect += 1;
    if (valid && pageCorrect && quoteCorrect) groundedCorrect += 1;
  }

  return {
    sourceValidity: accuracy(sourceValid, matches.length),
    targetPageAccuracy: accuracy(targetPageCorrect, matches.length),
    targetQuoteAccuracy: accuracy(targetQuoteCorrect, matches.length),
    groundedAccuracy: accuracy(groundedCorrect, matches.length),
  };
}

function validateDataset(dataset, label) {
  const value = object(dataset, label);
  invariant(value.schemaVersion === 1, `${label}.schemaVersion must equal 1`);
  invariant(value.syntheticOnly === true, `${label}.syntheticOnly must be true`);
  nonemptyString(value.datasetId, `${label}.datasetId`);
  array(value.cases, `${label}.cases`);
  return value;
}

function emptyPrediction(caseId) {
  return { id: caseId, supported: [], abstentions: [], conflicts: [] };
}

/**
 * Score a prediction artifact without retaining or printing source evidence.
 * Rates are null when a dataset contains no applicable denominator.
 */
export function scoreEvaluationDataset(goldInput, predictionInput) {
  const gold = validateDataset(goldInput, "gold");
  const predictions = validateDataset(predictionInput, "predictions");
  invariant(gold.datasetId === predictions.datasetId, "datasetId does not match the gold dataset");

  const knownCaseIds = new Set(gold.cases.map((item, index) => nonemptyString(object(item, `gold.cases[${index}]`).id, `gold.cases[${index}].id`)));
  const predictionsById = new Map();
  for (const [index, item] of predictions.cases.entries()) {
    const prediction = object(item, `predictions.cases[${index}]`);
    const id = nonemptyString(prediction.id, `predictions.cases[${index}].id`);
    invariant(knownCaseIds.has(id), `predictions contains unknown case ${id}`);
    invariant(!predictionsById.has(id), `predictions contains duplicate case ${id}`);
    predictionsById.set(id, prediction);
  }

  const allTargetMatches = [];
  const allAbstentionMatches = [];
  const allConflictMatches = [];
  const caseResults = [];

  let targetFalsePositive = 0;
  let targetFalseNegative = 0;
  let abstentionFalsePositive = 0;
  let abstentionFalseNegative = 0;
  let conflictFalsePositive = 0;
  let conflictFalseNegative = 0;

  for (const [index, item] of gold.cases.entries()) {
    const expected = object(item, `gold.cases[${index}]`);
    const id = nonemptyString(expected.id, `gold.cases[${index}].id`);
    const predicted = predictionsById.get(id) ?? emptyPrediction(id);
    const targets = array(expected.targets, `gold case ${id}.targets`);
    const supported = array(predicted.supported ?? [], `prediction case ${id}.supported`);
    const abstentions = array(expected.requiredAbstentions ?? [], `gold case ${id}.requiredAbstentions`);
    const predictedAbstentions = array(predicted.abstentions ?? [], `prediction case ${id}.abstentions`);
    const conflicts = array(expected.expectedConflicts ?? [], `gold case ${id}.expectedConflicts`);
    const predictedConflicts = array(predicted.conflicts ?? [], `prediction case ${id}.conflicts`);

    const targetResult = matchByKey(targets, supported, targetKey);
    const abstentionResult = matchByKey(abstentions, predictedAbstentions, abstentionKey);
    const conflictResult = matchByKey(conflicts, predictedConflicts, conflictKey);
    const citations = citationMetrics(array(expected.sourcePages, `gold case ${id}.sourcePages`), targetResult.matches);

    allTargetMatches.push(...targetResult.matches.map((match) => ({ ...match, sourcePages: expected.sourcePages })));
    allAbstentionMatches.push(...abstentionResult.matches);
    allConflictMatches.push(...conflictResult.matches);
    targetFalsePositive += targetResult.metric.falsePositive;
    targetFalseNegative += targetResult.metric.falseNegative;
    abstentionFalsePositive += abstentionResult.metric.falsePositive;
    abstentionFalseNegative += abstentionResult.metric.falseNegative;
    conflictFalsePositive += conflictResult.metric.falsePositive;
    conflictFalseNegative += conflictResult.metric.falseNegative;

    caseResults.push({
      id,
      extraction: targetResult.metric,
      citations,
      abstention: abstentionResult.metric,
      conflict: conflictResult.metric,
    });
  }

  const citationTotals = allTargetMatches.reduce(
    (totals, match) => {
      const metrics = citationMetrics(match.sourcePages, [match]);
      totals.sourceValid += metrics.sourceValidity.correct;
      totals.pageCorrect += metrics.targetPageAccuracy.correct;
      totals.quoteCorrect += metrics.targetQuoteAccuracy.correct;
      totals.grounded += metrics.groundedAccuracy.correct;
      return totals;
    },
    { sourceValid: 0, pageCorrect: 0, quoteCorrect: 0, grounded: 0 },
  );

  const matchedTargetCount = allTargetMatches.length;
  return {
    schemaVersion: 1,
    datasetId: gold.datasetId,
    syntheticOnly: true,
    counts: {
      cases: gold.cases.length,
      expectedTargets: gold.cases.reduce((sum, item) => sum + item.targets.length, 0),
      expectedAbstentions: gold.cases.reduce((sum, item) => sum + (item.requiredAbstentions?.length ?? 0), 0),
      expectedConflicts: gold.cases.reduce((sum, item) => sum + (item.expectedConflicts?.length ?? 0), 0),
    },
    extraction: prf(matchedTargetCount, targetFalsePositive, targetFalseNegative),
    citations: {
      sourceValidity: accuracy(citationTotals.sourceValid, matchedTargetCount),
      targetPageAccuracy: accuracy(citationTotals.pageCorrect, matchedTargetCount),
      targetQuoteAccuracy: accuracy(citationTotals.quoteCorrect, matchedTargetCount),
      groundedAccuracy: accuracy(citationTotals.grounded, matchedTargetCount),
    },
    abstention: prf(allAbstentionMatches.length, abstentionFalsePositive, abstentionFalseNegative),
    conflict: prf(allConflictMatches.length, conflictFalsePositive, conflictFalseNegative),
    cases: caseResults,
    run: predictionInput.run ?? null,
  };
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--gold" || argument === "--predictions") {
      result[argument.slice(2)] = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--pretty") {
      result.pretty = true;
      continue;
    }
    throw new TypeError(`Unknown argument: ${argument}`);
  }
  invariant(result.gold, "Usage: node scripts/ai-eval-score.mjs --gold <gold.json> --predictions <predictions.json> [--pretty]");
  invariant(result.predictions, "--predictions is required");
  return result;
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const [gold, predictions] = await Promise.all([
    readFile(arguments_.gold, "utf8").then(JSON.parse),
    readFile(arguments_.predictions, "utf8").then(JSON.parse),
  ]);
  const result = scoreEvaluationDataset(gold, predictions);
  process.stdout.write(`${JSON.stringify(result, null, arguments_.pretty ? 2 : 0)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`AI evaluation scoring failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
