import type { FindingModule } from "./types";

/** Versioned whenever deterministic findings can materially change. */
export const RULE_SET_VERSION = "wageshield.rules.1.2.0";

export const FINDING_RULE_VERSIONS = {
  WAGE_BENCHMARK: "wage_benchmark.v1.2.0",
  NONPRODUCTIVE_TIME: "nonproductive_time.v1.2.0",
  DEDUCTIONS_FEES: "deductions_fees.v1.2.0",
  EMPLOYMENT_FACTS: "employment_facts.v1.2.0",
} satisfies Record<FindingModule, string>;
