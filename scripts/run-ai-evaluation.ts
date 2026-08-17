/**
 * Execute the real AI Evidence Copilot over generated synthetic fixtures.
 *
 * This runner intentionally has no mock-provider mode. Unit tests cover mocks;
 * a benchmark artifact is created only after real configured inference succeeds
 * for every case.
 */
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import {
  aiEvidenceConfiguration,
  aiEvidenceIsConfigured,
  runAiEvidenceCopilot,
} from "../lib/ai-evidence";
import { prepareAiEvidenceInput } from "../lib/ai-evidence-input";
import type { DocumentType } from "../lib/types";

interface SourcePage {
  documentId: string;
  page: number;
  text: string;
}

interface GoldCase {
  id: string;
  documentType: DocumentType;
  inputFormat: "PDF" | "IMAGE";
  sourcePages: SourcePage[];
}

interface GoldDataset {
  schemaVersion: 1;
  datasetId: string;
  syntheticOnly: true;
  cases: GoldCase[];
}

interface Arguments {
  gold: string;
  predictions: string;
}

function fail(message: string): never {
  throw new TypeError(message);
}

function parseArguments(values: string[]): Arguments {
  const result: Partial<Arguments> = {};
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === "--gold" || argument === "--predictions") {
      const value = values[index + 1];
      if (!value) fail(`${argument} requires a path`);
      result[argument.slice(2) as keyof Arguments] = value;
      index += 1;
      continue;
    }
    fail(`Unknown argument: ${argument}`);
  }
  if (!result.gold || !result.predictions) {
    fail("Usage: run-ai-evaluation.ts --gold <gold.json> --predictions <predictions.json>");
  }
  return result as Arguments;
}

function validateGold(value: unknown): GoldDataset {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Gold dataset must be an object");
  const dataset = value as Partial<GoldDataset>;
  if (dataset.schemaVersion !== 1 || dataset.syntheticOnly !== true) {
    fail("Gold dataset must use schemaVersion 1 and syntheticOnly=true");
  }
  if (typeof dataset.datasetId !== "string" || !dataset.datasetId.trim()) fail("Gold datasetId is required");
  if (!Array.isArray(dataset.cases) || !dataset.cases.length) fail("Gold dataset cases are required");
  for (const item of dataset.cases) {
    if (!item || typeof item.id !== "string" || !item.id.trim()) fail("Every gold case requires an id");
    if (item.inputFormat !== "PDF" && item.inputFormat !== "IMAGE") fail(`Invalid inputFormat for ${item.id}`);
    if (!Array.isArray(item.sourcePages) || !item.sourcePages.length) fail(`Missing sourcePages for ${item.id}`);
    if (item.inputFormat === "IMAGE" && item.sourcePages.length !== 1) fail(`Image case ${item.id} must have one page`);
    for (const [pageIndex, page] of item.sourcePages.entries()) {
      if (page.page !== pageIndex + 1) fail(`Pages for ${item.id} must be contiguous from 1`);
      if (typeof page.documentId !== "string" || !page.documentId.trim()) fail(`Missing documentId for ${item.id}`);
      if (typeof page.text !== "string" || !page.text.includes("FICTIONAL SYNTHETIC")) {
        fail(`Case ${item.id} is not visibly marked FICTIONAL SYNTHETIC`);
      }
    }
  }
  return dataset as GoldDataset;
}

function wrapLine(value: string, maximum = 78): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= maximum) line = next;
    else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function displayLines(text: string): string[] {
  return text.split("\n").flatMap((line) => wrapLine(line));
}

async function syntheticPdf(item: GoldCase): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  for (const source of item.sourcePages) {
    const page = document.addPage([612, 792]);
    page.drawRectangle({ x: 0, y: 756, width: 612, height: 36, color: rgb(0.08, 0.22, 0.25) });
    page.drawText("FICTIONAL SYNTHETIC AI EVALUATION", {
      x: 48,
      y: 770,
      size: 10,
      font: bold,
      color: rgb(1, 1, 1),
    });
    let y = 724;
    for (const line of displayLines(source.text)) {
      if (y < 58) fail(`Synthetic page content overflowed in ${item.id}`);
      page.drawText(line || " ", {
        x: 48,
        y,
        size: 11,
        font: line.includes("FICTIONAL SYNTHETIC") ? bold : regular,
        color: line.includes("FICTIONAL SYNTHETIC") ? rgb(0.68, 0.12, 0.12) : rgb(0.08, 0.12, 0.13),
      });
      y -= 22;
    }
    page.drawText(`Synthetic case ${item.id} · page ${source.page}`, {
      x: 48,
      y: 30,
      size: 8,
      font: regular,
      color: rgb(0.4, 0.44, 0.45),
    });
  }
  return document.save({ useObjectStreams: false });
}

function syntheticImage(item: GoldCase): Uint8Array {
  const lines = displayLines(item.sourcePages[0].text);
  const width = 1_280;
  const height = Math.max(720, 190 + lines.length * 42);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#15383e";
  context.fillRect(0, 0, width, 82);
  context.fillStyle = "#ffffff";
  context.font = "bold 26px sans-serif";
  context.fillText("FICTIONAL SYNTHETIC AI EVALUATION", 64, 52);
  let y = 132;
  for (const line of lines) {
    context.fillStyle = line.includes("FICTIONAL SYNTHETIC") ? "#a52626" : "#142326";
    context.font = `${line.includes("FICTIONAL SYNTHETIC") ? "bold " : ""}24px sans-serif`;
    context.fillText(line, 64, y);
    y += 42;
  }
  context.fillStyle = "#667477";
  context.font = "18px sans-serif";
  context.fillText(`Synthetic case ${item.id}`, 64, height - 42);
  return canvas.toBuffer("image/jpeg", 90);
}

function gitValue(...arguments_: string[]): string | null {
  try {
    return execFileSync("git", arguments_, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function mappedSupported(
  result: Awaited<ReturnType<typeof runAiEvidenceCopilot>>,
  documentId: string,
) {
  return [
    ...result.facts.map((candidate) => ({
      kind: "fact",
      field: candidate.type,
      normalizedValue: candidate.normalized_value,
      evidence: {
        documentId,
        page: candidate.verifiedPage,
        quote: candidate.verifiedExcerpt,
      },
    })),
    ...result.payPeriods.map((candidate) => ({
      kind: "payPeriod",
      field: "PAY_PERIOD",
      normalizedValue: {
        start: candidate.start,
        end: candidate.end,
        payDate: candidate.pay_date,
        ordinaryBaseCents: candidate.ordinary_base_cents,
        grossCents: candidate.gross_cents,
      },
      evidence: {
        documentId,
        page: candidate.verifiedPage,
        quote: candidate.verifiedExcerpt,
      },
    })),
    ...result.deductions.map((candidate) => ({
      kind: "deduction",
      field: "DEDUCTION",
      normalizedValue: {
        description: candidate.description,
        amountCents: candidate.amount_cents,
        date: candidate.date,
      },
      evidence: {
        documentId,
        page: candidate.verifiedPage,
        quote: candidate.verifiedExcerpt,
      },
    })),
  ];
}

async function evaluateCase(item: GoldCase) {
  const bytes = item.inputFormat === "PDF" ? await syntheticPdf(item) : syntheticImage(item);
  const contentType = item.inputFormat === "PDF" ? "application/pdf" : "image/jpeg";
  const prepared = await prepareAiEvidenceInput(bytes, contentType, item.documentType);
  const result = await runAiEvidenceCopilot(prepared);
  const documentIds = [...new Set(item.sourcePages.map((page) => page.documentId))];
  return {
    id: item.id,
    supported: mappedSupported(result, documentIds[0]),
    abstentions: result.abstentions.map((abstention) => ({
      field: abstention.field,
      reasonCode: abstention.reasonCode,
      page: abstention.page,
      stage: abstention.stage,
    })),
    // Runtime conflicts are represented conservatively as explicit
    // CONFLICTING_EVIDENCE abstentions, not a separate product conclusion.
    conflicts: result.abstentions
      .filter((abstention) => abstention.reasonCode === "CONFLICTING_EVIDENCE")
      .map((abstention) => ({ field: abstention.field, documentIds })),
    provenance: {
      runId: result.runId,
      inputMode: result.inputMode,
      candidateCount: result.candidateCount,
      verifiedCount: result.verifiedCount,
      rejectedCount: result.rejectedCount,
      abstentionCount: result.abstentionCount,
    },
    runConfiguration: {
      provider: result.provider,
      model: result.model,
      verifierModel: result.verifierModel,
      promptVersion: result.promptVersion,
      verifierPromptVersion: result.verifierPromptVersion,
    },
  };
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  if (!aiEvidenceIsConfigured()) {
    fail("AI Evidence Copilot is not configured. Set OPENROUTER_API_KEY server-side; no artifact was written.");
  }
  const gold = validateGold(JSON.parse(await readFile(arguments_.gold, "utf8")) as unknown);
  const configuration = aiEvidenceConfiguration();
  process.stderr.write(
    `Running ${gold.cases.length} synthetic cases with ${configuration.provider} / ${configuration.model}; no real records are used.\n`,
  );

  const cases = [];
  for (const [index, item] of gold.cases.entries()) {
    process.stderr.write(`[${index + 1}/${gold.cases.length}] ${item.id}\n`);
    try {
      cases.push(await evaluateCase(item));
    } catch (error) {
      const code = error instanceof Error ? error.message : "unknown error";
      throw new Error(`Case ${item.id} failed (${code}); no prediction artifact was written.`);
    }
  }

  const firstRun = cases[0]?.runConfiguration;
  const artifact = {
    schemaVersion: 1,
    datasetId: gold.datasetId,
    syntheticOnly: true,
    run: {
      provider: firstRun?.provider ?? configuration.provider,
      model: firstRun?.model ?? configuration.model,
      verifierModel: firstRun?.verifierModel ?? configuration.verifierModel,
      promptVersion: firstRun?.promptVersion ?? null,
      verifierPromptVersion: firstRun?.verifierPromptVersion ?? null,
      generatedAt: new Date().toISOString(),
      gitCommit: gitValue("rev-parse", "HEAD"),
      worktreeDirty: Boolean(gitValue("status", "--porcelain")),
      fixtureGeneration: "RUNTIME_SYNTHETIC_PDF_AND_IMAGE",
    },
    cases: cases.map((item) => ({
      id: item.id,
      supported: item.supported,
      abstentions: item.abstentions,
      conflicts: item.conflicts,
      provenance: item.provenance,
    })),
  };
  await writeFile(arguments_.predictions, `${JSON.stringify(artifact, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  process.stderr.write(`Wrote real synthetic prediction artifact to ${arguments_.predictions}.\n`);
}

main().catch((error) => {
  process.stderr.write(`AI evaluation failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
