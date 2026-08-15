import { z } from "zod";
import { authenticationRequired, errorResponse, internalError, notFound, validationDetails } from "@/lib/api";
import { authenticateCaseRequest } from "@/lib/case-auth";
import { mutationGuard, parseJsonBody } from "@/lib/security";
import { jsonResponse } from "@/lib/session";
import { appendAudit, getCase, saveCase } from "@/lib/storage";

const FindingPatchSchema = z.object({
  include_in_report: z.boolean().optional(),
  disposition: z.enum(["UNREVIEWED", "EXPLAINED", "IRRELEVANT", "NEEDS_REVIEW"]).optional(),
});

type Context = { params: Promise<{ caseId: string; findingId: string }> };

export async function PATCH(request: Request, context: Context) {
  const identity = await authenticateCaseRequest(request);
  if (!identity) return authenticationRequired(request);
  const rejected = mutationGuard(request);
  if (rejected) return rejected;
  try {
    const { caseId, findingId } = await context.params;
    const caseData = await getCase(caseId, identity.user.userId);
    if (!caseData) return notFound();
    const finding = caseData.findings.find((candidate) => candidate.id === findingId);
    if (!finding) return notFound();
    const body = await parseJsonBody(request);
    if (!body.ok) return body.response;
    const parsed = FindingPatchSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(
        "INVALID_REQUEST",
        "The finding update is invalid.",
        400,
        false,
        validationDetails(parsed.error),
      );
    }
    if (parsed.data.include_in_report !== undefined) {
      finding.includeInReport = parsed.data.include_in_report;
    }
    if (parsed.data.disposition) finding.disposition = parsed.data.disposition;
    await saveCase(caseData);
    await appendAudit(caseData.id, "FINDING_UPDATED", {
      findingId,
      included: finding.includeInReport,
      disposition: finding.disposition,
    });
    return jsonResponse({ case: caseData, finding });
  } catch (error) {
    return internalError(error);
  }
}
