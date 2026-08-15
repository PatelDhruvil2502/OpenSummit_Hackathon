const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatCents(cents: number): string {
  return USD_FORMATTER.format(cents / 100);
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function roundDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("denominator must be positive");
  if (numerator >= 0n) return (numerator + denominator / 2n) / denominator;
  return -((-numerator + denominator / 2n) / denominator);
}

export function expectedPeriodCents(annualCents: number, periodsPerYear: number): number {
  return Number(roundDivide(BigInt(annualCents), BigInt(periodsPerYear)));
}

export function aggregateExpectedCents(
  annualCents: number,
  periodCount: number,
  periodsPerYear: number,
): number {
  return Number(
    roundDivide(BigInt(annualCents) * BigInt(periodCount), BigInt(periodsPerYear)),
  );
}

export function differenceExceedsTolerance(
  expectedCents: number,
  observedCents: number,
): boolean {
  const difference = expectedCents - observedCents;
  const toleranceCents = Math.max(100, Math.ceil(expectedCents / 1000));
  return difference > toleranceCents;
}

export function parseDollarsToCents(value: string): number {
  const normalized = value.trim().replaceAll(",", "").replace(/^\$/, "");
  const match = normalized.match(/^(\d{1,9})(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error("Enter a dollar amount with up to two decimal places");
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const cents = whole * 100 + fraction;
  if (!Number.isSafeInteger(cents)) throw new Error("Dollar amount is too large");
  return cents;
}
