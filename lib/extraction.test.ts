import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractDocument, extractionInternals } from "./extraction";

async function textPdf(lines: string[]): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  lines.forEach((line, index) =>
    page.drawText(line, { x: 54, y: 730 - index * 22, size: 11, font }),
  );
  return document.save();
}

test("normalizes exact dates and integer cents without floating point", () => {
  assert.equal(extractionInternals.isoDate("02/16/2026"), "2026-02-16");
  assert.equal(extractionInternals.isoDate("February 16, 2026"), "2026-02-16");
  assert.equal(extractionInternals.isoDate("02/31/2026"), null);
  assert.equal(extractionInternals.dollarsToCents("$3,769.23"), 376_923);
  assert.equal(extractionInternals.dollarsToCents("1.999"), null);
});

test("extracts proposed LCA facts but leaves review to the caller", async () => {
  const bytes = await textPdf([
    "Employer Legal Business Name: Northstar Data Systems LLC",
    "Job Title: Data Engineer",
    "Rate of Pay: $120,000.00 Per Year",
    "Place of Employment: Indianapolis, Indiana 46204",
  ]);
  const extraction = await extractDocument(bytes, "application/pdf", "LCA_CERTIFIED");
  assert.equal(extraction.method, "PDF_TEXT_LAYER");
  assert.equal(extraction.pageCount, 1);
  assert.equal(
    extraction.facts.find((fact) => fact.type === "LCA_WAGE_ANNUAL_CENTS")?.normalizedValue,
    "12000000",
  );
  assert.match(
    extraction.facts.find((fact) => fact.type === "LCA_WORKSITE")?.rawValue ?? "",
    /Indianapolis/i,
  );
});

test("extracts a pay period and a fee candidate from readable payroll", async () => {
  const bytes = await textPdf([
    "Pay Period: 2026-04-13 through 2026-04-26",
    "Pay Date: 2026-05-01",
    "Regular Salary $3,769.23",
    "Gross Pay $3,769.23",
    "H-1B filing/legal fee recovery -$1,500.00",
  ]);
  const extraction = await extractDocument(bytes, "application/pdf", "PAYSTUB");
  assert.deepEqual(
    extraction.payPeriods.map((period) => [period.start, period.end, period.ordinaryBaseCents]),
    [["2026-04-13", "2026-04-26", 376_923]],
  );
  assert.equal(extraction.deductions[0]?.amountCents, 150_000);
});

test("extracts annual wages written as dollars per year", async () => {
  const bytes = await textPdf([
    "Wage offered $95,000.00 per year",
    "Place of Employment: Austin, Texas",
  ]);
  const extraction = await extractDocument(bytes, "application/pdf", "LCA_CERTIFIED");
  assert.equal(
    extraction.facts.find((fact) => fact.type === "LCA_WAGE_ANNUAL_CENTS")?.normalizedValue,
    "9500000",
  );
});

test("infers biweekly frequency from pay period length", async () => {
  const bytes = await textPdf([
    "Period Beginning: 04/13/2026",
    "Period Ending: 04/26/2026",
    "Regular Earnings $3,769.23",
  ]);
  const extraction = await extractDocument(bytes, "application/pdf", "PAYSTUB");
  assert.equal(extraction.payPeriods[0]?.ordinaryBaseCents, 376_923);
  assert.equal(
    extraction.facts.find((fact) => fact.type === "PAY_FREQUENCY")?.normalizedValue,
    "BIWEEKLY",
  );
});

test("images explicitly require visual review", async () => {
  const extraction = await extractDocument(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg", "PAYSTUB");
  assert.equal(extraction.method, "IMAGE_REVIEW_REQUIRED");
  assert.equal(extraction.facts.length, 0);
  assert.match(extraction.warnings[0], /did not guess/i);
});
