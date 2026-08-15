import type { FindingModule, SourcePassage } from "./types";

const RETRIEVED_AT = "2026-08-15";
const VERSION = "h1b_sources.2026-08-15";

export const SOURCES: Record<FindingModule, SourcePassage> = {
  WAGE_BENCHMARK: {
    id: "src-dol-62g",
    authority: "U.S. Department of Labor, Wage and Hour Division",
    title: "Fact Sheet #62G: H-1B required wage",
    url: "https://www.dol.gov/agencies/whd/fact-sheets/62g-h1b-required-wage",
    section: "Required wage and guaranteed hours",
    retrievedAt: RETRIEVED_AT,
    reviewedAt: RETRIEVED_AT,
    version: VERSION,
    paraphrase:
      "DOL guidance describes the required wage as the higher of the applicable prevailing wage and the employer's actual wage for similarly employed workers.",
    caveat:
      "WageShield compares worker documents with the LCA-listed amount; it cannot establish the employer's internal actual-wage obligation.",
  },
  NONPRODUCTIVE_TIME: {
    id: "src-dol-62i",
    authority: "U.S. Department of Labor, Wage and Hour Division",
    title: "Fact Sheet #62I: H-1B nonproductive time",
    url: "https://www.dol.gov/agencies/whd/fact-sheets/62i-h1b-nonproductive-time",
    section: "Employment-related and worker-requested nonproductive time",
    retrievedAt: RETRIEVED_AT,
    reviewedAt: RETRIEVED_AT,
    version: VERSION,
    paraphrase:
      "DOL guidance distinguishes nonproductive time caused by employment-related conditions from time caused by a worker's voluntary absence or inability to work.",
    caveat:
      "The source describes general program requirements; case-specific leave, termination, availability, and payroll context still require human review.",
  },
  DEDUCTIONS_FEES: {
    id: "src-dol-62h",
    authority: "U.S. Department of Labor, Wage and Hour Division",
    title: "Fact Sheet #62H: Deductions from H-1B pay",
    url: "https://www.dol.gov/agencies/whd/fact-sheets/62h-h1b-pay-deductions",
    section: "Filing fees, employer business expenses, and authorized deductions",
    retrievedAt: RETRIEVED_AT,
    reviewedAt: RETRIEVED_AT,
    version: VERSION,
    paraphrase:
      "DOL guidance separates ordinary authorized deductions from certain filing fees, penalties, and employer business expenses that receive different treatment.",
    caveat:
      "A payroll label alone does not establish who ultimately bore a fee or whether an exception applies.",
  },
  EMPLOYMENT_FACTS: {
    id: "src-dol-62j",
    authority: "U.S. Department of Labor, Wage and Hour Division",
    title: "Fact Sheet #62J: H-1B place of employment",
    url: "https://www.dol.gov/agencies/whd/fact-sheets/62j-h1b-worksite",
    section: "Place of employment and temporary work",
    retrievedAt: RETRIEVED_AT,
    reviewedAt: RETRIEVED_AT,
    version: VERSION,
    paraphrase:
      "DOL guidance explains that worksite analysis depends on the geographic area of employment and distinguishes some temporary activity from an ongoing place of employment.",
    caveat:
      "Different locations in uploaded records are a review signal only; duration, commuting area, remote-work facts, and other filings may change the analysis.",
  },
};

export const SOURCE_CORPUS_VERSION = VERSION;
