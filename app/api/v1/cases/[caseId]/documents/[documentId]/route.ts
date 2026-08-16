import { authenticationRequired, internalError, notFound } from "@/lib/api";
import { authenticateCaseRequest } from "@/lib/case-auth";
import { invalidateDerivedResults } from "@/lib/case-workflow";
import { mutationGuard } from "@/lib/security";
import { jsonResponse } from "@/lib/session";
import { privateResponseHeaders } from "@/lib/session";
import {
  appendAudit,
  deleteDocumentObject,
  getCase,
  getDocumentBytes,
  saveCase,
} from "@/lib/storage";

type Context = { params: Promise<{ caseId: string; documentId: string }> };

export async function GET(request: Request, context: Context) {
  const identity = await authenticateCaseRequest(request);
  if (!identity) return authenticationRequired(request);
  try {
    const { caseId, documentId } = await context.params;
    const result = await getDocumentBytes(caseId, documentId, identity.user.userId);
    if (!result) return notFound();
    const headers = privateResponseHeaders();
    result.object.writeHttpMetadata(headers);
    headers.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(result.name)}`);
    headers.set("Content-Security-Policy", "sandbox");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(result.object.body, { headers });
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
    const { caseId, documentId } = await context.params;
    const caseData = await getCase(caseId, identity.user.userId);
    if (!caseData) return notFound();
    const knownInSnapshot = caseData.documents.some((document) => document.id === documentId);
    if (knownInSnapshot) {
      const removedFactIds = new Set(
        caseData.facts
          .filter((fact) => fact.evidence.documentId === documentId)
          .map((fact) => fact.id),
      );
      caseData.documents = caseData.documents.filter((document) => document.id !== documentId);
      caseData.facts = caseData.facts.filter((fact) => fact.evidence.documentId !== documentId);
      caseData.corrections = caseData.corrections.filter(
        (correction) => !removedFactIds.has(correction.factId),
      );
      caseData.payPeriods = caseData.payPeriods.filter(
        (period) =>
          period.sourceDocumentId !== documentId && period.evidence.documentId !== documentId,
      );
      caseData.deductions = caseData.deductions.filter(
        (deduction) =>
          deduction.sourceDocumentId !== documentId && deduction.evidence.documentId !== documentId,
      );
      caseData.events = caseData.events
        .map((event) => ({
          ...event,
          evidence: event.evidence.filter((item) => item.documentId !== documentId),
        }))
        .filter((event) => event.evidence.length > 0);
      invalidateDerivedResults(caseData);
      await saveCase(caseData);
    }
    const deleted = await deleteDocumentObject(caseId, documentId, identity.user.userId);
    if (!deleted) return notFound();
    await appendAudit(caseId, "DOCUMENT_DELETED", { documentId });
    return jsonResponse({ deletion: { status: "DELETED", document_id: documentId }, case: caseData });
  } catch (error) {
    return internalError(error);
  }
}
