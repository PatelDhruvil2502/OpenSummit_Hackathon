import { z } from "zod";
import {
  authenticationRequired,
  errorResponse,
  internalError,
  notFound,
  validationDetails,
} from "@/lib/api";
import { createStandardCase } from "@/lib/case-factory";
import { authenticateCaseRequest } from "@/lib/case-auth";
import { createFixtureCase } from "@/lib/fixtures";
import { generateFixtureDocumentPdf } from "@/lib/fixture-documents";
import { API_POLICY, RETENTION_POLICY } from "@/lib/product-config";
import { runAllRules } from "@/lib/rules";
import { sandboxIsEnabled } from "@/lib/runtime-flags";
import { mutationGuard, parseJsonBody, requireIdempotencyKey } from "@/lib/security";
import { jsonResponse } from "@/lib/session";
import {
  completeIdempotencyKey,
  countActiveCases,
  createCase,
  deleteCase,
  getCase,
  listCases,
  releaseIdempotencyKey,
  reserveIdempotencyKey,
  saveCase,
  sha256,
  storeDocument,
} from "@/lib/storage";

const SharedSchema = z.object({
  retention_hours: z
    .number()
    .int()
    .min(RETENTION_POLICY.minimumHours)
    .max(RETENTION_POLICY.maximumHours)
    .default(RETENTION_POLICY.defaultHours),
  authorized_use_confirmed: z.literal(true),
});

const StandardCaseSchema = SharedSchema.extend({
  mode: z.literal("standard"),
  title: z.string().trim().min(1).max(100),
  worker_name: z.string().trim().min(1).max(100),
  employer_name: z.string().trim().min(1).max(140),
  position: z.string().trim().min(1).max(120),
  review_start: z.iso.date(),
  review_end: z.iso.date(),
});

const SandboxCaseSchema = SharedSchema.extend({
  mode: z.literal("sandbox"),
  scenario: z.enum(["hero", "clean", "ambiguous"]),
});

const CreateCaseSchema = z.discriminatedUnion("mode", [StandardCaseSchema, SandboxCaseSchema]);

export async function GET(request: Request) {
  const identity = await authenticateCaseRequest(request);
  if (!identity) return authenticationRequired(request);
  try {
    const url = new URL(request.url);
    const { cases, nextCursor } = await listCases(identity.user.userId, {
      cursor: url.searchParams.get("cursor"),
      limit: Number(url.searchParams.get("limit") ?? API_POLICY.defaultCasePageSize),
    });
    return jsonResponse({ cases, nextCursor });
  } catch (error) {
    return internalError(error);
  }
}

export async function POST(request: Request) {
  const identity = await authenticateCaseRequest(request);
  if (!identity) return authenticationRequired(request);
  const guarded = mutationGuard(request);
  if (guarded) return guarded;
  const idempotency = requireIdempotencyKey(request);
  if (!idempotency.ok) return idempotency.response;
  const scope = "cases:create";
  let reserved = false;
  let createdCaseId = "";

  try {
    const prior = await reserveIdempotencyKey(identity.user.userId, scope, idempotency.key);
    if (prior === "IN_PROGRESS") {
      return errorResponse(
        "OPERATION_IN_PROGRESS",
        "This review is already being created. Wait a moment, then retry with the same key.",
        409,
        true,
      );
    }
    if (prior !== "RESERVED") {
      const caseData =
        prior.reference.kind === "case"
          ? await getCase(prior.reference.caseId, identity.user.userId)
          : null;
      return caseData ? jsonResponse({ case: caseData }, { status: prior.status }) : notFound();
    }
    reserved = true;

    const body = await parseJsonBody(request);
    if (!body.ok) {
      await releaseIdempotencyKey(identity.user.userId, scope, idempotency.key);
      return body.response;
    }
    const parsed = CreateCaseSchema.safeParse(body.value);
    if (!parsed.success) {
      await releaseIdempotencyKey(identity.user.userId, scope, idempotency.key);
      return errorResponse(
        "INVALID_REQUEST",
        "Confirm authorized use and complete all required review details.",
        400,
        false,
        validationDetails(parsed.error),
      );
    }

    if (parsed.data.mode === "sandbox" && !sandboxIsEnabled()) {
      await releaseIdempotencyKey(identity.user.userId, scope, idempotency.key);
      return errorResponse(
        "INVALID_REQUEST",
        "Fictional sandbox cases are disabled for this deployment.",
        400,
      );
    }

    if (parsed.data.mode === "standard" && parsed.data.review_start > parsed.data.review_end) {
      await releaseIdempotencyKey(identity.user.userId, scope, idempotency.key);
      return errorResponse(
        "INVALID_REQUEST",
        "The review start date must be on or before the end date.",
        400,
      );
    }

    if ((await countActiveCases(identity.user.userId)) >= API_POLICY.maximumActiveCases) {
      await releaseIdempotencyKey(identity.user.userId, scope, idempotency.key);
      return errorResponse(
        "CASE_QUOTA_EXCEEDED",
        `An account can keep at most ${API_POLICY.maximumActiveCases} active reviews. Delete or wait for an existing review to expire before creating another.`,
        409,
      );
    }

    createdCaseId = `case_${crypto.randomUUID()}`;
    const caseData =
      parsed.data.mode === "standard"
        ? createStandardCase(createdCaseId, identity.user.userId, {
            title: parsed.data.title,
            workerName: parsed.data.worker_name,
            employerName: parsed.data.employer_name,
            position: parsed.data.position,
            reviewStart: parsed.data.review_start,
            reviewEnd: parsed.data.review_end,
            retentionHours: parsed.data.retention_hours,
          })
        : await createFixtureCase(parsed.data.scenario, createdCaseId, identity.user.userId);

    caseData.retentionHours = parsed.data.retention_hours;
    caseData.retentionExpiresAt = new Date(
      Date.now() + parsed.data.retention_hours * 60 * 60 * 1000,
    ).toISOString();
    caseData.authorizedUseConfirmed = true;

    const fixtureBytes = new Map<string, Uint8Array>();
    if (caseData.mode === "SANDBOX") {
      caseData.findings = runAllRules(caseData);
      caseData.state = "RESULTS_READY";
      caseData.lastAnalysisAt = new Date().toISOString();
      for (const document of caseData.documents) {
        document.objectKey = `private/demo/${caseData.id}/original/${document.id}/v1/source.pdf`;
        const bytes = await generateFixtureDocumentPdf(caseData, document);
        document.bytes = bytes.byteLength;
        document.hash = await sha256(bytes);
        fixtureBytes.set(document.id, bytes);
      }
    }

    await createCase(caseData);
    for (const document of caseData.documents) {
      const bytes = fixtureBytes.get(document.id);
      if (bytes) await storeDocument(caseData, document, bytes);
    }
    if (fixtureBytes.size) await saveCase(caseData);

    const responseBody = { case: caseData };
    createdCaseId = "";
    try {
      await completeIdempotencyKey(identity.user.userId, scope, idempotency.key, {
        status: 201,
        reference: { kind: "case", caseId: caseData.id },
      });
    } catch {
      // The case itself is committed and remains authoritative.
    }
    return jsonResponse(responseBody, { status: 201 });
  } catch (error) {
    if (createdCaseId) {
      try {
        await deleteCase(createdCaseId, identity.user.userId);
      } catch {
        // The original operation error remains the client-facing error.
      }
    }
    if (reserved) {
      await releaseIdempotencyKey(identity.user.userId, scope, idempotency.key);
    }
    return internalError(error);
  }
}
