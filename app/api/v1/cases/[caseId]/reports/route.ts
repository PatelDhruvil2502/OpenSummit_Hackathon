import { z } from "zod";
import {
  authenticationRequired,
  errorResponse,
  internalError,
  notFound,
  validationDetails,
} from "@/lib/api";
import { authenticateCaseRequest } from "@/lib/case-auth";
import { assertCaseTransition } from "@/lib/case-workflow";
import { generateReportPdf } from "@/lib/report";
import { API_POLICY } from "@/lib/product-config";
import { mutationGuard, parseJsonBody, requireIdempotencyKey } from "@/lib/security";
import { jsonResponse } from "@/lib/session";
import {
  completeIdempotencyKey,
  deleteReportObject,
  getCase,
  getReportManifest,
  listReports,
  releaseIdempotencyKey,
  reserveIdempotencyKey,
  saveCase,
  storeReport,
  type StoredReportManifest,
} from "@/lib/storage";
import type { ReportRecord } from "@/lib/types";

const ReportSchema = z.object({
  included_finding_ids: z
    .array(z.string().min(1))
    .min(1)
    .max(API_POLICY.maximumReportFindings)
    .refine((ids) => new Set(ids).size === ids.length, "Finding IDs must be unique"),
  redact_worker_name: z.boolean().default(true),
  redact_employer_name: z.boolean().default(false),
  include_case_title: z.boolean().default(false),
  include_position: z.boolean().default(false),
});

type Context = { params: Promise<{ caseId: string }> };

export async function GET(request: Request, context: Context) {
  const identity = await authenticateCaseRequest(request);
  if (!identity) return authenticationRequired(request);
  try {
    const { caseId } = await context.params;
    const caseData = await getCase(caseId, identity.user.userId);
    if (!caseData) return notFound();
    return jsonResponse({
      reports: await listReports(caseId, identity.user.userId, caseData.reports),
    });
  } catch (error) {
    return internalError(error);
  }
}

export async function POST(request: Request, context: Context) {
  const identity = await authenticateCaseRequest(request);
  if (!identity) return authenticationRequired(request);
  const guarded = mutationGuard(request);
  if (guarded) return guarded;
  const idempotency = requireIdempotencyKey(request);
  if (!idempotency.ok) return idempotency.response;
  let activeCase: Awaited<ReturnType<typeof getCase>> = null;
  let reserved = false;
  let storedReportId = "";
  let scope = "";
  try {
    const { caseId } = await context.params;
    scope = `cases:${caseId}:report`;
    const prior = await reserveIdempotencyKey(identity.user.userId, scope, idempotency.key);
    if (prior === "IN_PROGRESS") {
      return errorResponse(
        "OPERATION_IN_PROGRESS",
        "This report is already being generated. Wait a moment, then retry with the same key.",
        409,
        true,
      );
    }
    if (prior !== "RESERVED") {
      const reference = prior.reference;
      if (reference.kind !== "report" || reference.caseId !== caseId) return notFound();
      const [caseData, manifest] = await Promise.all([
        getCase(caseId, identity.user.userId),
        getReportManifest(caseId, reference.reportId, identity.user.userId),
      ]);
      if (!caseData || !manifest) return notFound();
      const reports = await listReports(caseId, identity.user.userId, caseData.reports);
      const report = reports.find((item) => item.id === reference.reportId);
      if (!report) return notFound();
      caseData.reports = reports;
      return jsonResponse(
        {
          report: {
            id: report.id,
            status: "READY",
            sha256: report.sha256,
            manifest,
            download_url: `/api/v1/cases/${caseId}/reports/${report.id}`,
            manifest_url: `/api/v1/cases/${caseId}/reports/${report.id}/manifest`,
          },
          case: caseData,
        },
        { status: prior.status },
      );
    }
    reserved = true;

    const caseData = await getCase(caseId, identity.user.userId);
    if (!caseData) {
      await releaseIdempotencyKey(identity.user.userId, scope, idempotency.key);
      return notFound();
    }
    activeCase = caseData;
    if (
      (caseData.state !== "RESULTS_READY" && caseData.state !== "REPORT_FAILED") ||
      !caseData.findings.length
    ) {
      await releaseIdempotencyKey(identity.user.userId, scope, idempotency.key);
      return errorResponse(
        "FACT_REVIEW_REQUIRED",
        "Run the current reviewed evidence before generating a report.",
        409,
      );
    }
    if ((caseData.reports?.length ?? 0) >= API_POLICY.maximumReportsPerCase) {
      await releaseIdempotencyKey(identity.user.userId, scope, idempotency.key);
      return errorResponse(
        "CASE_QUOTA_EXCEEDED",
        `A review can retain at most ${API_POLICY.maximumReportsPerCase} generated reports. Delete an older report before generating another.`,
        409,
      );
    }

    const body = await parseJsonBody(request);
    if (!body.ok) {
      await releaseIdempotencyKey(identity.user.userId, scope, idempotency.key);
      return body.response;
    }
    const parsed = ReportSchema.safeParse(body.value);
    if (!parsed.success) {
      await releaseIdempotencyKey(identity.user.userId, scope, idempotency.key);
      return errorResponse(
        "INVALID_REQUEST",
        "Select at least one unique finding and valid redaction settings.",
        400,
        false,
        validationDetails(parsed.error),
      );
    }
    const available = new Set(caseData.findings.map((finding) => finding.id));
    if (parsed.data.included_finding_ids.some((id) => !available.has(id))) {
      await releaseIdempotencyKey(identity.user.userId, scope, idempotency.key);
      return errorResponse(
        "INVALID_REQUEST",
        "One or more selected findings are no longer current. Refresh the review and try again.",
        409,
      );
    }

    assertCaseTransition(caseData, "REPORTING");
    await saveCase(caseData);
    const report = await generateReportPdf(caseData, {
      includedFindingIds: parsed.data.included_finding_ids,
      redactWorkerName: parsed.data.redact_worker_name,
      redactEmployerName: parsed.data.redact_employer_name,
      includeCaseTitle: parsed.data.include_case_title,
      includePosition: parsed.data.include_position,
    });
    const reportId = `report_${crypto.randomUUID()}`;
    storedReportId = reportId;
    const objectKey = `private/cases/${caseData.id}/reports/${reportId}/v1/report.pdf`;
    const manifest: StoredReportManifest = {
      report_id: reportId,
      pdf_sha256: report.sha256,
      generated_at: report.manifest.generatedAt,
      case_snapshot_version: report.manifest.caseSnapshotVersion,
      rule_set_version: caseData.ruleSetVersion,
      source_corpus_version: caseData.sourceCorpusVersion,
      included_finding_ids: parsed.data.included_finding_ids,
      redactions: report.manifest.redactions,
      redaction_method: "allowlisted structured reconstruction",
    };
    await storeReport(
      caseData,
      reportId,
      objectKey,
      report.bytes,
      report.sha256,
      parsed.data.included_finding_ids,
      manifest,
    );
    const reportRecord: ReportRecord = {
      id: reportId,
      generatedAt: report.manifest.generatedAt,
      sha256: report.sha256,
      objectKey,
      caseSnapshotVersion: report.manifest.caseSnapshotVersion,
      includedFindingIds: parsed.data.included_finding_ids,
      redactions: report.manifest.redactions,
      status: "CURRENT",
    };
    caseData.reports = (caseData.reports ?? []).map((item) => ({
      ...item,
      status: "SUPERSEDED",
    }));
    caseData.reports.push(reportRecord);
    caseData.lastReport = reportRecord;
    assertCaseTransition(caseData, "RESULTS_READY");
    await saveCase(caseData);
    storedReportId = "";
    const responseBody = {
      report: {
        id: reportId,
        status: "READY",
        sha256: report.sha256,
        manifest,
        download_url: `/api/v1/cases/${caseData.id}/reports/${reportId}`,
        manifest_url: `/api/v1/cases/${caseData.id}/reports/${reportId}/manifest`,
      },
      case: caseData,
    };
    try {
      await completeIdempotencyKey(identity.user.userId, scope, idempotency.key, {
        status: 201,
        reference: { kind: "report", caseId: caseData.id, reportId },
      });
    } catch {
      // The report snapshot is committed and remains authoritative even if
      // replay metadata is temporarily unavailable.
    }
    return jsonResponse(responseBody, { status: 201 });
  } catch (error) {
    if (storedReportId && activeCase) {
      try {
        await deleteReportObject(activeCase.id, storedReportId, identity.user.userId);
      } catch {
        // The retention sweeper also discovers case-prefix orphans.
      }
    }
    if (activeCase?.state === "REPORTING") {
      activeCase.state = "REPORT_FAILED";
      try {
        await saveCase(activeCase);
      } catch {
        // Preserve the original safe error response.
      }
    }
    if (reserved && scope) {
      await releaseIdempotencyKey(identity.user.userId, scope, idempotency.key);
    }
    return internalError(error);
  }
}
