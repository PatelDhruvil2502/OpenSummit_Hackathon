import { authenticationRequired, internalError, notFound } from "@/lib/api";
import { authenticateCaseRequest } from "@/lib/case-auth";
import { jsonResponse } from "@/lib/session";
import { getReportManifest } from "@/lib/storage";

type Context = { params: Promise<{ caseId: string; reportId: string }> };

export async function GET(request: Request, context: Context) {
  const identity = await authenticateCaseRequest(request);
  if (!identity) return authenticationRequired(request);
  try {
    const { caseId, reportId } = await context.params;
    const manifest = await getReportManifest(caseId, reportId, identity.user.userId);
    return manifest ? jsonResponse({ manifest }) : notFound();
  } catch (error) {
    return internalError(error);
  }
}
