import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";
import { formatCents } from "./money";
import type { CasePayload, Finding } from "./types";

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const NAVY = rgb(0.055, 0.13, 0.18);
const TEAL = rgb(0.04, 0.42, 0.39);
const AMBER = rgb(0.75, 0.43, 0.06);
const SLATE = rgb(0.29, 0.36, 0.4);
const LIGHT = rgb(0.94, 0.955, 0.95);
const WHITE = rgb(1, 1, 1);

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes: Uint8Array<ArrayBuffer> =
    typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface ReportOptions {
  includedFindingIds: string[];
  redactWorkerName: boolean;
  redactEmployerName: boolean;
  includeCaseTitle: boolean;
  includePosition: boolean;
}

export interface GeneratedReport {
  bytes: Uint8Array;
  sha256: string;
  manifest: {
    verificationCode: string;
    generatedAt: string;
    caseSnapshotVersion: number;
    ruleSetVersion: string;
    sourceCorpusVersion: string;
    includedFindingIds: string[];
    redactions: string[];
  };
}

interface WriterState {
  pdf: PDFDocument;
  regular: PDFFont;
  bold: PDFFont;
  mono: PDFFont;
  page: PDFPage;
  y: number;
}

export function correctionsForSelectedFindings(
  caseData: CasePayload,
  findings: Finding[],
): CasePayload["corrections"] {
  const selectedEvidenceIds = new Set(
    findings.flatMap((finding) => finding.evidence.map((item) => item.id)),
  );
  const selectedRecordIds = new Set([
    ...caseData.facts
      .filter((fact) => selectedEvidenceIds.has(fact.evidence.id))
      .map((fact) => fact.id),
    ...caseData.payPeriods
      .filter((period) => selectedEvidenceIds.has(period.evidence.id))
      .map((period) => period.id),
    ...caseData.deductions
      .filter((deduction) => selectedEvidenceIds.has(deduction.evidence.id))
      .map((deduction) => deduction.id),
  ]);
  return caseData.corrections.filter((correction) =>
    selectedRecordIds.has(correction.factId),
  );
}

function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const paragraphs = text.split(/\n+/);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }
    let line = words.shift() ?? "";
    if (font.widthOfTextAtSize(line, size) > width) {
      const chunks: string[] = [];
      let chunk = "";
      for (const character of line) {
        if (!chunk || font.widthOfTextAtSize(`${chunk}${character}`, size) <= width) {
          chunk += character;
        } else {
          chunks.push(chunk);
          chunk = character;
        }
      }
      if (chunk) chunks.push(chunk);
      line = chunks.pop() ?? "";
      lines.push(...chunks);
    }
    for (const word of words) {
      const candidate = `${line} ${word}`;
      if (font.widthOfTextAtSize(candidate, size) <= width) line = candidate;
      else {
        lines.push(line);
        if (font.widthOfTextAtSize(word, size) <= width) {
          line = word;
        } else {
          let chunk = "";
          for (const character of word) {
            if (!chunk || font.widthOfTextAtSize(`${chunk}${character}`, size) <= width) {
              chunk += character;
            } else {
              lines.push(chunk);
              chunk = character;
            }
          }
          line = chunk;
        }
      }
    }
    lines.push(line);
  }
  return lines;
}

function newPage(state: WriterState): void {
  state.page = state.pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  state.page.drawRectangle({ x: 0, y: PAGE_HEIGHT - 12, width: PAGE_WIDTH, height: 12, color: TEAL });
  state.y = PAGE_HEIGHT - 48;
}

function ensureRoom(state: WriterState, needed: number): void {
  if (state.y - needed < 54) newPage(state);
}

function heading(state: WriterState, text: string, size = 18): void {
  const lines = wrapText(text, state.bold, size, CONTENT_WIDTH);
  const lineHeight = size * 1.2;
  ensureRoom(state, lines.length * lineHeight + 12);
  lines.forEach((line) => {
    state.page.drawText(line, { x: MARGIN, y: state.y, size, font: state.bold, color: NAVY });
    state.y -= lineHeight;
  });
  state.y -= 12;
}

function paragraph(
  state: WriterState,
  text: string,
  options: { size?: number; color?: ReturnType<typeof rgb>; indent?: number; gap?: number } = {},
): void {
  const size = options.size ?? 9.5;
  const indent = options.indent ?? 0;
  const lineHeight = size * 1.42;
  const lines = wrapText(text, state.regular, size, CONTENT_WIDTH - indent);
  ensureRoom(state, lines.length * lineHeight + (options.gap ?? 8));
  for (const line of lines) {
    state.page.drawText(line, {
      x: MARGIN + indent,
      y: state.y,
      size,
      font: state.regular,
      color: options.color ?? SLATE,
    });
    state.y -= lineHeight;
  }
  state.y -= options.gap ?? 8;
}

function labelValue(state: WriterState, label: string, value: string): void {
  const normalizedLabel = label.toUpperCase();
  const labelWidth = state.bold.widthOfTextAtSize(normalizedLabel, 7.5);
  const valueOffset = Math.max(150, labelWidth + 18);
  const availableWidth = CONTENT_WIDTH - valueOffset;
  const valueLines = wrapText(value, state.regular, 9.5, Math.max(160, availableWidth));
  const stacked = valueLines.length > 1 || state.regular.widthOfTextAtSize(value, 9.5) > availableWidth;
  const lineHeight = 13;
  const needed = stacked ? 20 + valueLines.length * lineHeight : 22;
  ensureRoom(state, needed);
  state.page.drawText(normalizedLabel, {
    x: MARGIN,
    y: state.y,
    size: 7.5,
    font: state.bold,
    color: TEAL,
  });
  valueLines.forEach((line, index) => {
    state.page.drawText(line, {
      x: stacked ? MARGIN + 12 : MARGIN + valueOffset,
      y: stacked ? state.y - 16 - index * lineHeight : state.y - 1,
      size: 9.5,
      font: state.regular,
      color: NAVY,
    });
  });
  state.y -= needed;
}

function findingBlock(
  state: WriterState,
  finding: Finding,
  index: number,
  redact: (value: string) => string,
): void {
  const headingLines = wrapText(redact(`${index}. ${finding.headline}`), state.bold, 10.5, CONTENT_WIDTH - 24);
  const headerHeight = Math.max(32, headingLines.length * 14 + 14);
  ensureRoom(state, 120 + headerHeight);
  state.page.drawRectangle({
    x: MARGIN,
    y: state.y - headerHeight + 4,
    width: CONTENT_WIDTH,
    height: headerHeight,
    color: finding.status === "POSSIBLE_DISCREPANCY" ? rgb(1, 0.965, 0.88) : LIGHT,
  });
  headingLines.forEach((line, lineIndex) => {
    state.page.drawText(line, {
      x: MARGIN + 12,
      y: state.y - 15 - lineIndex * 14,
      size: 10.5,
      font: state.bold,
      color: NAVY,
    });
  });
  state.y -= headerHeight + 11;
  labelValue(state, "Status", finding.status.replaceAll("_", " "));
  if (finding.amountCents !== undefined) {
    labelValue(
      state,
      redact(finding.amountLabel ?? "Documented comparison amount"),
      formatCents(finding.amountCents),
    );
  }
  paragraph(state, redact(finding.summary), { gap: 5 });
  labelValue(state, "Reviewer disposition", finding.disposition.replaceAll("_", " "));

  if (finding.calculation) {
    paragraph(state, redact(`Method: ${finding.calculation.method}`), { size: 8.5, color: NAVY, gap: 4 });
    for (const row of finding.calculation.rows) {
      labelValue(state, redact(row.label), redact(row.value));
    }
  }

  paragraph(state, "Evidence reviewed", { size: 8.5, color: TEAL, gap: 4 });
  for (const evidence of finding.evidence) {
    paragraph(
      state,
      redact(`${evidence.documentName}, page ${evidence.page}: “${evidence.text}”`),
      { size: 8.5, indent: 12, gap: 4 },
    );
  }

  paragraph(state, "Official context", { size: 8.5, color: TEAL, gap: 4 });
  paragraph(state, redact(`${finding.source.title}. ${finding.source.paraphrase}`), {
    size: 8.5,
    indent: 12,
    gap: 3,
  });
  paragraph(state, finding.source.url, { size: 7.5, indent: 12, color: TEAL, gap: 7 });

  paragraph(state, "Questions for review", { size: 8.5, color: AMBER, gap: 4 });
  for (const question of finding.questions) paragraph(state, redact(`- ${question}`), { size: 8.5, indent: 12, gap: 3 });
  paragraph(state, redact(`Assumptions: ${finding.assumptions.join(" ")}`), {
    size: 8,
    color: SLATE,
    gap: 4,
  });
  paragraph(state, redact(`Limit: ${finding.limitations.join(" ")}`), { size: 8, color: SLATE, gap: 12 });
}

function safeDisplayName(value: string, redact: boolean, fallback: string): string {
  if (!value) return fallback;
  return redact ? "[REDACTED BY USER]" : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createTextRedactor(
  caseData: CasePayload,
  options: ReportOptions,
): (value: string) => string {
  const identifiers = new Set<string>();
  if (options.redactWorkerName) {
    identifiers.add(caseData.workerName);
    caseData.workerName
      .split(/[\s,]+/)
      .filter((part) => part.length >= 3)
      .forEach((part) => identifiers.add(part));
  }
  if (options.redactEmployerName) {
    identifiers.add(caseData.employerName);
    identifiers.add(
      caseData.employerName.replace(/\b(?:LLC|L\.L\.C\.|INC\.?|CORP\.?|CORPORATION|LTD\.?)\b/gi, "").trim(),
    );
  }
  if (!options.includeCaseTitle) identifiers.add(caseData.title);
  if (!options.includePosition) identifiers.add(caseData.position);
  const patterns = Array.from(identifiers)
    .filter((value) => value.trim().length >= 3)
    .sort((left, right) => right.length - left.length)
    .map((identifier) =>
      new RegExp(
        escapeRegExp(identifier.trim()).replace(/\\ /g, "[\\s._-]+"),
        "gi",
      ),
    );
  return (value) => {
    const redacted = patterns.reduce(
      (current, pattern) => current.replace(pattern, "[REDACTED BY USER]"),
      value,
    );
    return redacted
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\x20-\x7E\u00A0-\u00FF]/g, "?");
  };
}

export async function generateReportPdf(
  caseData: CasePayload,
  options: ReportOptions,
): Promise<GeneratedReport> {
  const findings = caseData.findings.filter((finding) =>
    options.includedFindingIds.includes(finding.id),
  );
  if (!findings.length) throw new Error("Select at least one finding for the report");
  const selectedCorrections = correctionsForSelectedFindings(caseData, findings);
  const redact = createTextRedactor(caseData, options);
  const selectedEvidenceIds = new Set(
    findings.flatMap((finding) => finding.evidence.map((item) => item.id)),
  );
  const selectedRecords = [
    ...caseData.facts,
    ...caseData.payPeriods,
    ...caseData.deductions,
  ].filter((record) => selectedEvidenceIds.has(record.evidence.id));
  const usesAiProposals = selectedRecords.some((record) => record.aiProvenance);

  const generatedAt = new Date().toISOString();
  const redactions = [
    ...(options.redactWorkerName ? ["worker_name"] : []),
    ...(options.redactEmployerName ? ["employer_name"] : []),
    ...(!options.includeCaseTitle ? ["case_title"] : []),
    ...(!options.includePosition ? ["position"] : []),
  ];
  const manifestInput = JSON.stringify({
    caseId: caseData.id,
    caseSnapshotVersion: caseData.stateVersion,
    ruleSetVersion: caseData.ruleSetVersion,
    sourceCorpusVersion: caseData.sourceCorpusVersion,
    includedFindingIds: options.includedFindingIds,
    redactions,
  });
  const verificationCode = (await sha256(manifestInput)).slice(0, 16).toUpperCase();
  const manifest = {
    verificationCode,
    generatedAt,
    caseSnapshotVersion: caseData.stateVersion,
    ruleSetVersion: caseData.ruleSetVersion,
    sourceCorpusVersion: caseData.sourceCorpusVersion,
    includedFindingIds: options.includedFindingIds,
    redactions,
  };

  const pdf = await PDFDocument.create();
  pdf.setTitle("WageShield H-1B evidence review");
  pdf.setAuthor("WageShield H-1B");
  pdf.setSubject("User-controlled evidence packet - not a legal determination");
  pdf.setKeywords(["WageShield", "H-1B", "evidence review"]);
  pdf.setCreationDate(new Date(generatedAt));
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  const firstPage = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const state: WriterState = { pdf, regular, bold, mono, page: firstPage, y: PAGE_HEIGHT - 72 };

  firstPage.drawRectangle({ x: 0, y: PAGE_HEIGHT - 18, width: PAGE_WIDTH, height: 18, color: TEAL });
  firstPage.drawRectangle({ x: MARGIN, y: PAGE_HEIGHT - 132, width: 42, height: 42, color: NAVY });
  firstPage.drawText("W", { x: MARGIN + 11, y: PAGE_HEIGHT - 120, size: 20, font: bold, color: WHITE });
  firstPage.drawText("WAGESHIELD H-1B", {
    x: MARGIN + 58,
    y: PAGE_HEIGHT - 103,
    size: 10,
    font: bold,
    color: TEAL,
  });
  firstPage.drawText("Evidence review packet", {
    x: MARGIN,
    y: PAGE_HEIGHT - 190,
    size: 28,
    font: bold,
    color: NAVY,
  });
  state.y = PAGE_HEIGHT - 228;
  paragraph(
    state,
    "A user-controlled, point-in-time summary of uploaded records, deterministic comparisons, and official context. This packet organizes evidence for human review. It is not legal advice, a complaint, or a legal determination.",
    { size: 11, color: SLATE, gap: 24 },
  );
  labelValue(
    state,
    "Worker",
    redact(safeDisplayName(caseData.workerName, options.redactWorkerName, "Not provided")),
  );
  labelValue(
    state,
    "Employer",
    redact(safeDisplayName(caseData.employerName, options.redactEmployerName, "Not provided")),
  );
  labelValue(state, "Review period", `${caseData.reviewStart} through ${caseData.reviewEnd}`);
  labelValue(state, "Generated", generatedAt.replace("T", " ").replace(".000Z", " UTC"));
  labelValue(state, "Verification code", verificationCode);
  state.y -= 18;
  firstPage.drawRectangle({ x: MARGIN, y: state.y - 72, width: CONTENT_WIDTH, height: 82, color: LIGHT });
  firstPage.drawText("EVIDENCE FIRST. HUMAN REVIEWED.", {
    x: MARGIN + 18,
    y: state.y - 18,
    size: 9,
    font: bold,
    color: TEAL,
  });
  const notice = wrapText(
    caseData.mode === "STANDARD"
      ? "This packet contains user-provided structured facts. Verify every excerpt against the original document before relying on it."
      : "FICTIONAL SYNTHETIC DEMO DATA - NOT A REAL PERSON OR EMPLOYER",
    regular,
    9,
    CONTENT_WIDTH - 36,
  );
  notice.forEach((line, lineIndex) => {
    firstPage.drawText(line, {
      x: MARGIN + 18,
      y: state.y - 40 - lineIndex * 13,
      size: 9,
      font: regular,
      color: NAVY,
    });
  });

  newPage(state);
  heading(state, "Case snapshot");
  labelValue(state, "Case title", options.includeCaseTitle ? redact(caseData.title) : "[OMITTED BY USER]");
  labelValue(state, "Position", options.includePosition ? redact(caseData.position || "Not provided") : "[OMITTED BY USER]");
  labelValue(state, "Documents reviewed", String(caseData.documents.length));
  labelValue(state, "Findings selected", String(findings.length));
  labelValue(state, "Retention expiry", caseData.retentionExpiresAt);

  state.y -= 8;
  const selectedDocumentIds = new Set(
    findings.flatMap((finding) => finding.evidence.map((item) => item.documentId)),
  );
  const selectedDocuments = caseData.documents.filter((document) => selectedDocumentIds.has(document.id));
  heading(state, "Selected evidence inventory", 15);
  for (const document of selectedDocuments) {
    const hash = document.hash ? `${document.hash.slice(0, 12)}…` : "not available";
    paragraph(
      state,
      redact(`${document.name} • ${document.type.replaceAll("_", " ")} • ${document.pages} page${document.pages === 1 ? "" : "s"} • SHA-256 ${hash}`),
      { size: 8.5, gap: 5 },
    );
  }
  if (!selectedDocuments.length) {
    paragraph(state, "No source document metadata was selected by the included findings.");
  }

  newPage(state);
  heading(state, "Selected findings");
  paragraph(
    state,
    "Statuses describe documentary comparisons only. Context not present in the uploaded record can change how a qualified reviewer understands a result.",
    { size: 9.5, gap: 18 },
  );
  findings.forEach((finding, index) => {
    if (index > 0 && state.y < 480) newPage(state);
    findingBlock(state, finding, index + 1, redact);
  });

  newPage(state);
  heading(state, "Corrections, assumptions, and method");
  if (selectedCorrections.length) {
    paragraph(state, "User corrections", { size: 9, color: TEAL, gap: 4 });
    selectedCorrections.forEach((correction) =>
      paragraph(
        state,
        redact(`Fact ${correction.factId}: ${correction.previousValue} → ${correction.newValue} (${correction.createdAt})`),
        { size: 8.5, indent: 12, gap: 4 },
      ),
    );
  } else {
    paragraph(state, "No user corrections apply to the selected evidence.");
  }
  paragraph(
    state,
    "Methodology: WageShield uses reviewed structured facts and versioned, deterministic rules for money, date, tolerance, and status logic. Official-source text supplies general context only. The application does not infer an employer's internal actual-wage records, determine an immigration outcome, or calculate a legally owed amount.",
  );
  if (usesAiProposals) {
    paragraph(
      state,
      "AI provenance: one or more selected values began as model-proposed document evidence, passed a separate citation-grounding check, and were then confirmed or corrected by a person. AI output never determines a finding; all finding statuses and calculations in this packet come from the versioned deterministic rule engine.",
    );
  }
  paragraph(
    state,
    "Redaction method: this PDF is reconstructed from an allowlist of selected structured fields and excerpts. Original document layers are never copied into the report, so excluded content is absent rather than visually covered.",
  );

  heading(state, "Technical manifest", 15);
  labelValue(state, "Case snapshot", String(manifest.caseSnapshotVersion));
  labelValue(state, "Rule set", manifest.ruleSetVersion);
  labelValue(state, "Source corpus", manifest.sourceCorpusVersion);
  labelValue(state, "Verification", manifest.verificationCode);
  paragraph(state, `Included finding IDs: ${manifest.includedFindingIds.join(", ")}`, { size: 8.5 });
  paragraph(
    state,
    `Redactions: ${manifest.redactions.length ? manifest.redactions.join(", ") : "none selected"}`,
    { size: 8.5 },
  );

  const pages = pdf.getPages();
  pages.forEach((page, index) => {
    page.drawLine({
      start: { x: MARGIN, y: 38 },
      end: { x: PAGE_WIDTH - MARGIN, y: 38 },
      color: rgb(0.84, 0.87, 0.86),
      thickness: 0.5,
    });
    page.drawText(
      "WageShield issue-spotting report - generated from user-provided records - not a legal determination.",
      { x: MARGIN, y: 23, size: 6.5, font: regular, color: SLATE },
    );
    page.drawText(`${index + 1} / ${pages.length}`, {
      x: PAGE_WIDTH - MARGIN - 28,
      y: 23,
      size: 6.5,
      font: mono,
      color: SLATE,
    });
  });

  const bytes = await pdf.save({ useObjectStreams: false });
  return { bytes, sha256: await sha256(bytes), manifest };
}
