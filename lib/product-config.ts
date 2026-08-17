/**
 * Single source of truth for product limits shown in the UI and enforced by the
 * API. Server routes and client components must import the same constant so a
 * limit can never drift between the copy a user reads and the check that runs.
 */

export const UPLOAD_POLICY = {
  /** Largest single evidence file accepted by `POST /uploads`. */
  maximumFileBytes: 12 * 1024 * 1024,
  /** Multipart envelope allowance on top of the file itself. */
  requestOverheadBytes: 512 * 1024,
  /** Total private object bytes retained for one review. */
  maximumCaseBytes: 100 * 1024 * 1024,
  /** Documents retained for one review. */
  maximumCaseDocuments: 50,
  /** Pages read from a single PDF text layer. */
  maximumPdfPages: 200,
  acceptedContentTypes: ["application/pdf", "image/png", "image/jpeg"] as const,
  acceptedExtensions: [".pdf", ".png", ".jpg", ".jpeg"] as const,
} as const;

export const UPLOAD_ACCEPT_ATTRIBUTE = UPLOAD_POLICY.acceptedExtensions.join(",");

export function maximumUploadRequestBytes(): number {
  return UPLOAD_POLICY.maximumFileBytes + UPLOAD_POLICY.requestOverheadBytes;
}

export const RETENTION_POLICY = {
  defaultHours: 24,
  minimumHours: 1,
  maximumHours: 168,
  options: [
    { hours: 1, label: "1 hour" },
    { hours: 24, label: "24 hours" },
    { hours: 72, label: "3 days" },
    { hours: 168, label: "7 days" },
  ] as ReadonlyArray<{ hours: number; label: string }>,
  /** Cron cadence configured in `render.yaml` for the retention sweeper. */
  sweepCron: "*/15 * * * *",
} as const;

export const API_POLICY = {
  defaultCasePageSize: 25,
  maximumCasePageSize: 50,
  /** Findings selectable into one generated report. */
  maximumReportFindings: 20,
  /** Reviews one account may keep at once. */
  maximumActiveCases: 25,
  /** Generated report objects retained for one review. */
  maximumReportsPerCase: 25,
  /** Structured records retained in one review payload. */
  maximumFactsPerCase: 250,
  maximumPayPeriodsPerCase: 250,
  maximumDeductionsPerCase: 250,
  maximumEventsPerCase: 250,
  maximumCorrectionsPerCase: 500,
  /** Metadata-only audit events retained for one review. */
  maximumAuditEventsPerCase: 1_000,
} as const;

export function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const megabytes = bytes / (1024 * 1024);
    return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
  }
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
