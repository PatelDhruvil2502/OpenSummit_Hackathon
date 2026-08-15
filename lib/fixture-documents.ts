import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { CasePayload, DocumentRecord, EvidenceRef } from "./types";

const WATERMARK = "FICTIONAL SYNTHETIC DATA - NOT A REAL PERSON OR EMPLOYER";

function evidenceForDocument(caseData: CasePayload, documentId: string): EvidenceRef[] {
  const all = [
    ...caseData.facts.map((fact) => fact.evidence),
    ...caseData.payPeriods.map((period) => period.evidence),
    ...caseData.deductions.map((deduction) => deduction.evidence),
    ...caseData.events.flatMap((event) => event.evidence),
    ...caseData.findings.flatMap((finding) => finding.evidence),
  ].filter((evidence) => evidence.documentId === documentId);
  const seen = new Set<string>();
  return all.filter((evidence) => {
    const key = `${evidence.page}:${evidence.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function wrap(text: string, max = 82): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= max) line = next;
    else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export async function generateFixtureDocumentPdf(
  caseData: CasePayload,
  document: DocumentRecord,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(document.name);
  pdf.setAuthor("WageShield synthetic fixture generator");
  pdf.setSubject(WATERMARK);
  pdf.setCreationDate(new Date(caseData.createdAt));
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  const evidence = evidenceForDocument(caseData, document.id);

  for (let pageNumber = 1; pageNumber <= document.pages; pageNumber += 1) {
    const page = pdf.addPage([612, 792]);
    page.drawRectangle({ x: 0, y: 774, width: 612, height: 18, color: rgb(0.05, 0.17, 0.21) });
    page.drawText(WATERMARK, {
      x: 54,
      y: 746,
      size: 8,
      font: bold,
      color: rgb(0.65, 0.22, 0.22),
    });
    page.drawText("WAGESHIELD SYNTHETIC FIXTURE", {
      x: 54,
      y: 710,
      size: 9,
      font: bold,
      color: rgb(0.07, 0.45, 0.41),
    });
    page.drawText(document.name.replace(/\.pdf$/i, ""), {
      x: 54,
      y: 677,
      size: 18,
      font: bold,
      color: rgb(0.05, 0.17, 0.21),
    });
    page.drawText(`${document.type.replaceAll("_", " ")}  |  page ${pageNumber} of ${document.pages}`, {
      x: 54,
      y: 658,
      size: 8,
      font: mono,
      color: rgb(0.34, 0.42, 0.44),
    });

    page.drawRectangle({
      x: 54,
      y: 582,
      width: 504,
      height: 50,
      borderColor: rgb(0.8, 0.86, 0.84),
      borderWidth: 1,
      color: rgb(0.96, 0.98, 0.97),
    });
    page.drawText("Worker", { x: 68, y: 612, size: 7, font: bold, color: rgb(0.07, 0.45, 0.41) });
    page.drawText(caseData.workerName || "Synthetic worker", { x: 68, y: 595, size: 10, font: regular, color: rgb(0.05, 0.17, 0.21) });
    page.drawText("Employer", { x: 300, y: 612, size: 7, font: bold, color: rgb(0.07, 0.45, 0.41) });
    page.drawText(caseData.employerName || "Synthetic employer", { x: 300, y: 595, size: 10, font: regular, color: rgb(0.05, 0.17, 0.21) });

    let y = 544;
    const pageEvidence = evidence.filter((item) => item.page === pageNumber);
    const rows = pageEvidence.length
      ? pageEvidence
      : pageNumber === 1
        ? [{ label: "Fixture description", text: document.note ?? WATERMARK } as Pick<EvidenceRef, "label" | "text">]
        : [{ label: "Continuation", text: "Synthetic supporting page reserved for document-layout testing." } as Pick<EvidenceRef, "label" | "text">];
    for (const row of rows) {
      const lines = wrap(row.text);
      const height = 38 + lines.length * 14;
      if (y - height < 85) break;
      page.drawText(row.label.toUpperCase(), {
        x: 54,
        y,
        size: 7,
        font: bold,
        color: rgb(0.07, 0.45, 0.41),
      });
      y -= 16;
      page.drawRectangle({
        x: 54,
        y: y - lines.length * 14 - 10,
        width: 504,
        height: lines.length * 14 + 18,
        borderColor: rgb(0.86, 0.88, 0.87),
        borderWidth: 1,
        color: rgb(1, 1, 1),
      });
      lines.forEach((line, index) => {
        page.drawText(line, {
          x: 68,
          y: y - 4 - index * 14,
          size: 9,
          font: regular,
          color: rgb(0.12, 0.22, 0.25),
        });
      });
      y -= lines.length * 14 + 35;
    }

    page.drawLine({
      start: { x: 54, y: 52 },
      end: { x: 558, y: 52 },
      color: rgb(0.82, 0.86, 0.85),
      thickness: 0.5,
    });
    page.drawText("Synthetic fixture for product demonstration and automated evaluation only.", {
      x: 54,
      y: 35,
      size: 7,
      font: regular,
      color: rgb(0.4, 0.47, 0.48),
    });
    page.drawText(String(pageNumber), {
      x: 548,
      y: 35,
      size: 7,
      font: mono,
      color: rgb(0.4, 0.47, 0.48),
    });
  }

  return pdf.save({ useObjectStreams: false });
}
