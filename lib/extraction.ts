import { API_POLICY, UPLOAD_POLICY } from "./product-config";

export type ExtractionMethod = "PDF_TEXT_LAYER" | "IMAGE_REVIEW_REQUIRED";

export interface ProposedFact {
  id: string;
  type: string;
  label: string;
  rawValue: string;
  normalizedValue: string;
  confidence: number;
  page: number;
  evidenceText: string;
  groupId?: string;
}

export interface ProposedPayPeriod {
  id: string;
  start: string;
  end: string;
  payDate: string;
  ordinaryBaseCents: number;
  grossCents: number;
  page: number;
  evidenceText: string;
  confidence: number;
}

export interface ProposedDeduction {
  id: string;
  description: string;
  amountCents: number;
  date: string;
  page: number;
  evidenceText: string;
  confidence: number;
}

export interface DocumentExtraction {
  method: ExtractionMethod;
  pageCount: number;
  characterCount: number;
  facts: ProposedFact[];
  payPeriods: ProposedPayPeriod[];
  deductions: ProposedDeduction[];
  warnings: string[];
}

const MAX_PAGES = UPLOAD_POLICY.maximumPdfPages;
const MAX_PAGE_CHARACTERS = 40_000;
const MAX_TOTAL_CHARACTERS = 300_000;
const MAX_PDF_IMAGE_PIXELS = 4_000_000;
const PDF_PARSE_TIMEOUT_MS = 15_000;

class PdfDomMatrix {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;

  constructor(initial?: number[]) {
    if (Array.isArray(initial) && initial.length === 6) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = initial;
    }
  }

  translateSelf(x: number, y = 0): this {
    this.e = this.a * x + this.c * y + this.e;
    this.f = this.b * x + this.d * y + this.f;
    return this;
  }

  scaleSelf(x: number, y = x): this {
    this.a *= x;
    this.b *= x;
    this.c *= y;
    this.d *= y;
    return this;
  }
}

/** PDF.js reads DOMMatrix while its module is evaluated, including in Workers. */
async function loadPdfJs() {
  const runtime = globalThis as unknown as {
    DOMMatrix?: typeof PdfDomMatrix;
    pdfjsWorker?: { WorkerMessageHandler: unknown };
  };
  runtime.DOMMatrix ??= PdfDomMatrix;
  // Cloudflare Workers cannot spawn PDF.js' browser worker, so PDF.js falls
  // back to its in-process message handler. Import that handler explicitly so
  // the production bundle contains it instead of attempting a runtime import
  // of a non-existent `pdf.worker.mjs` asset.
  const workerModule = await import("pdfjs-dist/build/pdf.worker.mjs");
  runtime.pdfjsWorker ??= { WorkerMessageHandler: workerModule.WorkerMessageHandler };
  return import("pdfjs-dist");
}

function textContentToString(items: ReadonlyArray<unknown>): string {
  let output = "";
  for (const candidate of items) {
    if (!candidate || typeof candidate !== "object" || !("str" in candidate)) continue;
    const item = candidate as { str?: unknown; hasEOL?: unknown };
    if (typeof item.str !== "string") continue;
    output += item.str;
    output += item.hasEOL === true ? "\n" : " ";
  }
  return output;
}

function cleanText(value: string): string {
  return value
    .replaceAll("\u0000", "")
    .replace(/[\t\f\v]+/g, " ")
    .replace(/ +/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, text.lastIndexOf("\n", Math.max(0, index - 140)) + 1);
  const nextLine = text.indexOf("\n", index + length);
  const end = Math.min(text.length, nextLine < 0 ? index + length + 180 : nextLine);
  return cleanText(text.slice(start, end)).slice(0, 360);
}

function dollarsToCents(value: string): number | null {
  const normalized = value.replace(/[$,\s]/g, "");
  if (!/^-?\d{1,12}(?:\.\d{1,2})?$/.test(normalized)) return null;
  const negative = normalized.startsWith("-");
  const [whole, decimal = ""] = normalized.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

const MONTHS: Record<string, string> = {
  jan: "01",
  january: "01",
  feb: "02",
  february: "02",
  mar: "03",
  march: "03",
  apr: "04",
  april: "04",
  may: "05",
  jun: "06",
  june: "06",
  jul: "07",
  july: "07",
  aug: "08",
  august: "08",
  sep: "09",
  sept: "09",
  september: "09",
  oct: "10",
  october: "10",
  nov: "11",
  november: "11",
  dec: "12",
  december: "12",
};

function isoDate(value: string): string | null {
  const input = value.trim().replace(/,$/, "");
  let year: string;
  let month: string;
  let day: string;

  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(input);
  if (iso) [, year, month, day] = iso;
  else {
    const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(input);
    if (numeric) [, month, day, year] = numeric;
    else {
      const named = /^([A-Za-z]{3,9})\s+(\d{1,2})\s+(\d{4})$/.exec(
        input.replace(/,/g, ""),
      );
      if (!named) return null;
      month = MONTHS[named[1].toLowerCase()];
      day = named[2];
      year = named[3];
      if (!month) return null;
    }
  }

  const candidate = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const date = new Date(`${candidate}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === candidate
    ? candidate
    : null;
}

function firstMatch(
  pages: string[],
  expression: RegExp,
): { match: RegExpExecArray; page: number; text: string } | null {
  for (let index = 0; index < pages.length; index += 1) {
    expression.lastIndex = 0;
    const match = expression.exec(pages[index]);
    if (match) return { match, page: index + 1, text: pages[index] };
  }
  return null;
}

function proposedFact(
  pages: string[],
  expression: RegExp,
  type: string,
  label: string,
  normalize: (value: string) => string | null,
  confidence: number,
): ProposedFact | null {
  const result = firstMatch(pages, expression);
  if (!result) return null;
  const rawValue = cleanText(result.match[1]);
  const normalizedValue = normalize(rawValue);
  if (!normalizedValue) return null;
  return {
    id: crypto.randomUUID(),
    type,
    label,
    rawValue,
    normalizedValue,
    confidence,
    page: result.page,
    evidenceText: excerpt(result.text, result.match.index, result.match[0].length),
  };
}

function moneyFact(
  pages: string[],
  expression: RegExp,
  type: string,
  label: string,
  confidence: number,
): ProposedFact | null {
  return proposedFact(
    pages,
    expression,
    type,
    label,
    (value) => {
      const cents = dollarsToCents(value);
      return cents === null ? null : String(Math.abs(cents));
    },
    confidence,
  );
}

function textFact(
  pages: string[],
  expression: RegExp,
  type: string,
  label: string,
  confidence: number,
): ProposedFact | null {
  return proposedFact(
    pages,
    expression,
    type,
    label,
    (value) => cleanText(value).slice(0, 180) || null,
    confidence,
  );
}

function firstMoneyFact(
  pages: string[],
  expressions: RegExp[],
  type: string,
  label: string,
  confidence: number,
): ProposedFact | null {
  for (const expression of expressions) {
    const fact = moneyFact(pages, expression, type, label, confidence);
    if (fact) return fact;
  }
  return null;
}

function firstTextFact(
  pages: string[],
  expressions: RegExp[],
  type: string,
  label: string,
  confidence: number,
): ProposedFact | null {
  for (const expression of expressions) {
    const fact = textFact(pages, expression, type, label, confidence);
    if (fact) return fact;
  }
  return null;
}

function normalizePayFrequency(value: string): string | null {
  const normalized = cleanText(value).toUpperCase().replaceAll("_", " ").replaceAll("-", "");
  if (/BI\s*WEEK/.test(normalized) || normalized.includes("BIWEEK")) return "BIWEEKLY";
  if (/SEMI\s*MONTH/.test(normalized) || normalized.includes("SEMIMONTH")) return "SEMI-MONTHLY";
  if (normalized.includes("WEEK")) return "WEEKLY";
  if (normalized.includes("MONTH")) return "MONTHLY";
  if (normalized.includes("YEAR") || normalized.includes("ANNUAL")) return "ANNUAL";
  return null;
}

function payFrequencyFact(pages: string[]): ProposedFact | null {
  return proposedFact(
    pages,
    /(?:pay\s+frequency|paid|compensation\s+schedule|salary\s+paid)\s*[:-]?\s*(weekly|biweekly|bi-weekly|bi weekly|semi-monthly|semimonthly|semi monthly|monthly|annually|annual)/i,
    "PAY_FREQUENCY",
    "Pay frequency",
    normalizePayFrequency,
    0.86,
  );
}

function uniqueFacts(facts: Array<ProposedFact | null>): ProposedFact[] {
  const seen = new Set<string>();
  const result: ProposedFact[] = [];
  for (const fact of facts) {
    if (!fact) continue;
    const key = `${fact.type}:${fact.normalizedValue}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(fact);
  }
  return result;
}

function extractLcaFacts(pages: string[]): ProposedFact[] {
  return uniqueFacts([
    firstMoneyFact(
      pages,
      [
        /(?:rate\s+of\s+pay|wage(?:\s+rate)?(?:\s+offered)?|offered\s+wage|prevailing\s+wage|lca\s+wage)[^\n$\d]{0,80}\$?\s*([\d,]+(?:\.\d{1,2})?)(?=[^\n]{0,40}(?:year|annual|annum))/i,
        /\$\s*([\d,]+(?:\.\d{1,2})?)\s*(?:per\s+year|\/\s*year|annually|per\s+annum)/i,
        /(?:annual\s+wage|yearly\s+wage|wage\s+offered)[^\n$\d]{0,40}\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
      ],
      "LCA_WAGE_ANNUAL_CENTS",
      "LCA-listed annual wage",
      0.92,
    ),
    firstTextFact(
      pages,
      [
        /(?:place\s+of\s+employment|worksite(?:\s+address)?|work\s+location|employment\s+location)\s*[:-]?\s*([^\n]{3,180})/i,
      ],
      "LCA_WORKSITE",
      "LCA worksite",
      0.82,
    ),
    firstTextFact(
      pages,
      [
        /(?:employer(?:'s)?(?:\s+legal\s+business)?\s+name|petitioning\s+employer|petitioner)\s*[:-]?\s*([^\n]{2,160})/i,
      ],
      "EMPLOYER_NAME",
      "Petitioning employer",
      0.78,
    ),
    firstTextFact(
      pages,
      [/(?:job\s+title|position\s+title|soc\s+title|occupation)\s*[:-]?\s*([^\n]{2,140})/i],
      "POSITION_TITLE",
      "Position",
      0.75,
    ),
    payFrequencyFact(pages),
  ]);
}

function extractOfferFacts(pages: string[]): ProposedFact[] {
  return uniqueFacts([
    firstMoneyFact(
      pages,
      [
        /(?:annual\s+base\s+salary|annual\s+salary|base\s+salary|yearly\s+salary|base\s+compensation)[^\n$\d]{0,80}\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
        /\$\s*([\d,]+(?:\.\d{1,2})?)\s*(?:per\s+year|\/\s*year|annually)/i,
      ],
      "OFFER_WAGE_ANNUAL_CENTS",
      "Offer annual base wage",
      0.88,
    ),
    firstTextFact(
      pages,
      [
        /(?:primary\s+work\s+location|work\s+location|worksite|place\s+of\s+employment|office\s+location)\s*[:-]?\s*([^\n]{3,180})/i,
      ],
      "OFFER_WORKSITE",
      "Offer worksite",
      0.8,
    ),
    firstTextFact(
      pages,
      [/(?:position|job\s+title|role)\s*[:-]?\s*([^\n]{2,140})/i],
      "POSITION_TITLE",
      "Offer position",
      0.7,
    ),
    payFrequencyFact(pages),
  ]);
}

function frequencyFromPeriodDays(start: string, end: string): string | null {
  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
  if (!Number.isFinite(days) || days <= 0) return null;
  if (days <= 8) return "WEEKLY";
  if (days <= 16) return "BIWEEKLY";
  if (days <= 20) return "SEMI-MONTHLY";
  if (days <= 35) return "MONTHLY";
  return null;
}

const DATE_VALUE =
  "(?:\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{4}|[A-Za-z]{3,9}\\s+\\d{1,2},?\\s+\\d{4})";

function extractPayPeriods(pages: string[]): ProposedPayPeriod[] {
  const periods: ProposedPayPeriod[] = [];
  pages.forEach((pageText, pageIndex) => {
    if (periods.length >= API_POLICY.maximumPayPeriodsPerCase) return;
    const range =
      new RegExp(
        `(?:pay\\s+period|period)(?:\\s+(?:begin|start|from))?\\s*[:\\-]?\\s*(${DATE_VALUE})\\s*(?:through|to|[-–—])\\s*(${DATE_VALUE})`,
        "i",
      ).exec(pageText) ??
      (() => {
        const start = new RegExp(
          `(?:period\\s+beginning|begin(?:ning)?\\s+date|start\\s+date|period\\s+start)\\s*[:\\-]?\\s*(${DATE_VALUE})`,
          "i",
        ).exec(pageText);
        const end = new RegExp(
          `(?:period\\s+ending|end(?:ing)?\\s+date|period\\s+end)\\s*[:\\-]?\\s*(${DATE_VALUE})`,
          "i",
        ).exec(pageText);
        if (!start || !end) return null;
        return Object.assign([start[0], start[1], end[1]] as unknown as RegExpExecArray, {
          index: start.index,
        });
      })();
    const base =
      /(?:regular\s+(?:salary|pay|earnings)|ordinary\s+base|base\s+pay|regular\s+earnings)\s*[:-]?\s*\$?\s*(-?[\d,]+(?:\.\d{1,2})?)/i.exec(
        pageText,
      ) ?? /(?:net\s+pay|gross\s+pay)\s*[:-]?\s*\$?\s*(-?[\d,]+(?:\.\d{1,2})?)/i.exec(pageText);
    if (!range || !base) return;
    const start = isoDate(range[1]);
    const end = isoDate(range[2]);
    const ordinaryBase = dollarsToCents(base[1]);
    if (!start || !end || ordinaryBase === null || start > end) return;
    const payDateMatch = new RegExp(`(?:pay\\s+date|check\\s+date)\\s*[:\\-]?\\s*(${DATE_VALUE})`, "i").exec(
      pageText,
    );
    const grossMatch = /(?:gross\s+(?:pay|earnings)|gross)\s*[:-]?\s*\$?\s*(-?[\d,]+(?:\.\d{1,2})?)/i.exec(
      pageText,
    );
    const payDate = payDateMatch ? isoDate(payDateMatch[1]) : null;
    const gross = grossMatch ? dollarsToCents(grossMatch[1]) : null;
    periods.push({
      id: crypto.randomUUID(),
      start,
      end,
      payDate: payDate ?? end,
      ordinaryBaseCents: Math.abs(ordinaryBase),
      grossCents: Math.abs(gross ?? ordinaryBase),
      page: pageIndex + 1,
      evidenceText: excerpt(pageText, range.index ?? 0, 80),
      confidence: payDate && gross !== null ? 0.9 : 0.82,
    });
  });
  return periods;
}

function extractDeductions(pages: string[]): ProposedDeduction[] {
  const deductions: ProposedDeduction[] = [];
  const relevant = /(?:h\s*-?\s*1b|petition|filing|legal\s+fee|attorney|training|relocation|early\s+departure)/i;
  pages.forEach((pageText, pageIndex) => {
    const lines = pageText.split("\n");
    lines.forEach((line) => {
      if (deductions.length >= API_POLICY.maximumDeductionsPerCase) return;
      if (!relevant.test(line)) return;
      const amount = /(?:-\s*\$\s*|\$\s*-?)([\d,]+(?:\.\d{1,2})?)/.exec(line);
      if (!amount) return;
      const cents = dollarsToCents(amount[1]);
      if (cents === null || cents === 0) return;
      const dateMatch = new RegExp(DATE_VALUE, "i").exec(pageText);
      deductions.push({
        id: crypto.randomUUID(),
        description: cleanText(line.replace(amount[0], "")).slice(0, 180) || "Fee-related line",
        amountCents: Math.abs(cents),
        date: dateMatch ? isoDate(dateMatch[0]) ?? "" : "",
        page: pageIndex + 1,
        evidenceText: cleanText(line).slice(0, 360),
        confidence: 0.8,
      });
    });
  });
  return deductions;
}

export async function extractDocument(
  bytes: Uint8Array,
  contentType: string,
  documentType: string,
): Promise<DocumentExtraction> {
  if (contentType !== "application/pdf") {
    return {
      method: "IMAGE_REVIEW_REQUIRED",
      pageCount: 1,
      characterCount: 0,
      facts: [],
      payPeriods: [],
      deductions: [],
      warnings: [
        "This image needs visual transcription. WageShield did not guess values from pixels.",
      ],
    };
  }

  const { getDocument, VerbosityLevel } = await loadPdfJs();
  const loadingTask = getDocument({
    data: bytes,
    canvasMaxAreaInBytes: 16 * 1024 * 1024,
    disableFontFace: true,
    enableXfa: false,
    isImageDecoderSupported: false,
    isOffscreenCanvasSupported: false,
    maxImageSize: MAX_PDF_IMAGE_PIXELS,
    stopAtErrors: true,
    useWasm: false,
    useSystemFonts: true,
    verbosity: VerbosityLevel.ERRORS,
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void loadingTask.destroy();
  }, PDF_PARSE_TIMEOUT_MS);
  let pageCount = 0;
  let pages: string[] = [];
  let remaining = MAX_TOTAL_CHARACTERS;
  try {
    const pdf = await loadingTask.promise;
    pageCount = pdf.numPages;
    if (pageCount > MAX_PAGES) throw new Error("DOCUMENT_PAGE_LIMIT_EXCEEDED");
    pages = [];
    for (let pageNumber = 1; pageNumber <= pageCount && remaining > 0; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent({ disableNormalization: false });
        const cleaned = cleanText(textContentToString(content.items)).slice(
          0,
          Math.min(MAX_PAGE_CHARACTERS, remaining),
        );
        pages.push(cleaned);
        remaining -= cleaned.length;
      } finally {
        page.cleanup();
      }
    }
  } catch (error) {
    if (timedOut) throw new Error("DOCUMENT_PARSE_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timeout);
    await loadingTask.destroy();
  }
  const characterCount = pages.reduce((total, page) => total + page.length, 0);
  const warnings: string[] = [];
  if (characterCount < 40) {
    warnings.push(
      "No usable text layer was found. Review the document visually and enter only verified values.",
    );
  }
  if (remaining === 0) {
    warnings.push("Extracted text reached the safety limit; confirm that later pages were not omitted.");
  }

  let facts: ProposedFact[] = [];
  let payPeriods: ProposedPayPeriod[] = [];
  let deductions: ProposedDeduction[] = [];
  if (documentType === "LCA_CERTIFIED") facts = extractLcaFacts(pages);
  else if (documentType === "OFFER_OR_EMPLOYMENT_LETTER") facts = extractOfferFacts(pages);
  else if (documentType === "PAYSTUB" || documentType === "TIMESHEET") {
    payPeriods = extractPayPeriods(pages);
    deductions = extractDeductions(pages);
    facts = uniqueFacts([payFrequencyFact(pages)]);
  } else if (documentType === "WORK_MESSAGE") {
    facts = uniqueFacts([
      firstTextFact(
        pages,
        [
          /(?:report(?:ing)?\s+to|relocate(?:d)?\s+to|work\s+from|new\s+worksite|worksite)\s*[:-]?\s*([^\n]{3,180})/i,
        ],
        "CURRENT_WORKSITE",
        "Instructed worksite",
        0.74,
      ),
    ]);
  } else {
    facts = uniqueFacts([...extractLcaFacts(pages), ...extractOfferFacts(pages)]);
    payPeriods = extractPayPeriods(pages);
    deductions = extractDeductions(pages);
  }

  if (
    !facts.some((fact) => fact.type === "PAY_FREQUENCY") &&
    payPeriods[0]
  ) {
    const inferred = frequencyFromPeriodDays(payPeriods[0].start, payPeriods[0].end);
    if (inferred) {
      facts.push({
        id: crypto.randomUUID(),
        type: "PAY_FREQUENCY",
        label: "Pay frequency inferred from pay period length",
        rawValue: inferred,
        normalizedValue: inferred,
        confidence: 0.7,
        page: payPeriods[0].page,
        evidenceText: payPeriods[0].evidenceText,
      });
    }
  }

  if (!facts.length && !payPeriods.length && !deductions.length && characterCount >= 40) {
    warnings.push(
      "Text was readable, but no supported material fields were identified automatically. Manual review is required.",
    );
  }

  return {
    method: "PDF_TEXT_LAYER",
    pageCount,
    characterCount,
    facts,
    payPeriods,
    deductions,
    warnings,
  };
}

export const extractionInternals = { cleanText, dollarsToCents, isoDate };
