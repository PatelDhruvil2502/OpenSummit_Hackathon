import { authenticationRequired, internalError, notFound } from "@/lib/api";
import { authenticateCaseRequest } from "@/lib/case-auth";
import { mutationGuard } from "@/lib/security";
import { jsonResponse } from "@/lib/session";
import { privateResponseHeaders } from "@/lib/session";
import { deleteReportObject, getCase, getReportBytes, saveCase } from "@/lib/storage";

type Context = { params: Promise<{ caseId: string; reportId: string }> };

export async function GET(request: Request, context: Context) {
  const identity = await authenticateCaseRequest(request);
  if (!identity) return authenticationRequired(request);
  try {
    const { caseId, reportId } = await context.params;
    const object = await getReportBytes(caseId, reportId, identity.user.userId);
    if (!object) return notFound();
    const headers = privateResponseHeaders();
    object.writeHttpMetadata(headers);
    headers.set("Content-Type", "application/pdf");
    headers.set("Content-Disposition", `attachment; filename="wageshield-evidence-report.pdf"`);
    headers.set("ETag", `"${object.customMetadata?.sha256 ?? reportId}"`);
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(object.body, { headers });
  } catch (error) {
    return internalError(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  const identity = await authenticateCaseRequest(request);
  if (!identity) return authenticationRequired(request);
  const guarded = mutationGuard(request);
  if (guarded) return guarded;
  try {
    const { caseId, reportId } = await context.params;
    const caseData = await getCase(caseId, identity.user.userId);
    if (!caseData) return notFound();
    const knownInSnapshot =
      caseData.lastReport?.id === reportId ||
      (caseData.reports ?? []).some((report) => report.id === reportId);
    if (knownInSnapshot) {
      caseData.reports = (caseData.reports ?? []).filter((report) => report.id !== reportId);
      if (caseData.lastReport?.id === reportId) {
        const next = caseData.reports.at(-1);
        if (next) {
          next.status = "CURRENT";
          caseData.lastReport = next;
        } else {
          delete caseData.lastReport;
        }
      }
      await saveCase(caseData);
    }
    const deleted = await deleteReportObject(caseId, reportId, identity.user.userId);
    if (!deleted) return notFound();
    return jsonResponse({ deletion: { status: "DELETED", report_id: reportId } });
  } catch (error) {
    return internalError(error);
  }
}
