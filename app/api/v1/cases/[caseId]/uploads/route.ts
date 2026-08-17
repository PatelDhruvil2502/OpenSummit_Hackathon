import { z } from "zod";
import {
  AI_EVIDENCE_PROMPT_VERSION,
  AI_EVIDENCE_VERIFIER_PROMPT_VERSION,
  AiEvidenceCopilotError,
  aiEvidenceConfiguration,
  runAiEvidenceCopilot,
  type AiEvidenceCopilotResult,
} from "@/lib/ai-evidence";
import { prepareAiEvidenceInput } from "@/lib/ai-evidence-input";
import { authenticationRequired, errorResponse, internalError, notFound } from "@/lib/api";
import { authenticateCaseRequest } from "@/lib/case-auth";
import { invalidateDerivedResults, refreshDocumentReviewStatus } from "@/lib/case-workflow";
import { extractDocument } from "@/lib/extraction";
import {
  API_POLICY,
  UPLOAD_POLICY,
  formatByteSize,
  maximumUploadRequestBytes,
} from "@/lib/product-config";
import { mutationGuard, parseFormDataBody } from "@/lib/security";
import { jsonResponse } from "@/lib/session";
import {
  appendAudit,
  caseStorageUsage,
  deleteDocumentObject,
  getCase,
  saveCase,
  sha256,
  storeDocument,
} from "@/lib/storage";
import type {
  AiDocumentExtraction,
  AiEvidenceProvenance,
  DeductionObservation,
  DocumentRecord,
  EvidenceRef,
  FactRecord,
  FindingModule,
  PayPeriod,
} from "@/lib/types";

const MAX_FILE_BYTES = UPLOAD_POLICY.maximumFileBytes;
const MAX_REQUEST_BYTES = maximumUploadRequestBytes();
const MAX_CASE_BYTES = UPLOAD_POLICY.maximumCaseBytes;
const MAX_CASE_DOCUMENTS = UPLOAD_POLICY.maximumCaseDocuments;
const MAX_FILE_LABEL = formatByteSize(MAX_FILE_BYTES);
const MAX_CASE_LABEL = formatByteSize(MAX_CASE_BYTES);
const TypeSchema = z.enum([
  "LCA_CERTIFIED",
  "OFFER_OR_EMPLOYMENT_LETTER",
  "PAYSTUB",
  "TIMESHEET",
  "WORK_MESSAGE",
  "LEAVE_NOTICE",
  "TERMINATION_NOTICE",
  "PETITION_SUPPORT_LETTER",
  "OTHER",
]);

type Context = { params: Promise<{ caseId: string }> };

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
}

function endsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  const offset = bytes.length - signature.length;
  return signature.every((value, index) => bytes[offset + index] === value);
}

function detectedMime(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  return null;
}

function validContainer(bytes: Uint8Array, mime: string): boolean {
  if (mime === "image/jpeg") return bytes.length >= 32 && endsWith(bytes, [0xff, 0xd9]);
  if (mime === "image/png") {
    return bytes.length >= 45 && endsWith(bytes, [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  }
  if (mime === "application/pdf") {
    if (bytes.length < 100) return false;
    const tail = new TextDecoder("latin1").decode(bytes.slice(Math.max(0, bytes.length - 4096)));
    const eof = tail.lastIndexOf("%%EOF");
    return eof >= 0 && /^[\s\0]*$/.test(tail.slice(eof + 5));
  }
  return false;
}

function extensionMatches(name: string, mime: string): boolean {
  const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (mime === "application/pdf") return extension === "pdf";
  if (mime === "image/png") return extension === "png";
  if (mime === "image/jpeg") return extension === "jpg" || extension === "jpeg";
  return false;
}

function safeName(value: string): string {
  return (
    Array.from(value.normalize("NFKC"))
      .map((character) => {
        const code = character.charCodeAt(0);
        return character === "/" || character === "\\" || code < 32 || code === 127 ? "-" : character;
      })
      .join("")
      .replace(/\.{2,}/g, ".")
      .slice(0, 120) || "document"
  );
}

function affectsForFact(type: string): FindingModule[] {
  if (type.includes("WAGE") || type === "PAY_FREQUENCY") {
    return type.startsWith("LCA")
      ? ["WAGE_BENCHMARK", "NONPRODUCTIVE_TIME"]
      : ["WAGE_BENCHMARK"];
  }
  if (type.includes("WORKSITE") || type.includes("POSITION") || type.includes("EMPLOYER")) {
    return ["EMPLOYMENT_FACTS"];
  }
  return ["EMPLOYMENT_FACTS"];
}

function evidence(
  document: DocumentRecord,
  page: number,
  label: string,
  text: string,
  role: EvidenceRef["role"],
): EvidenceRef {
  return {
    id: `span_${crypto.randomUUID()}`,
    documentId: document.id,
    documentName: document.name,
    page,
    label,
    text,
    role,
  };
}

function deductionCategory(description: string): DeductionObservation["category"] {
  if (/h\s*-?\s*1b|petition|filing|legal\s+fee|attorney/i.test(description)) {
    return "PETITION_OR_LEGAL_FEE_REFERENCE";
  }
  if (/training|relocation/i.test(description)) return "TRAINING_OR_RELOCATION_REFERENCE";
  if (/early\s+departure/i.test(description)) return "EARLY_DEPARTURE_REFERENCE";
  if (/business\s+expense|equipment|tools?|uniform|employer\s+expense/i.test(description)) {
    return "EMPLOYER_BUSINESS_EXPENSE_REFERENCE";
  }
  return "UNKNOWN";
}

function uniqueBy<Value>(values: Value[], keyFor: (value: Value) => string): Value[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = keyFor(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function aiProvenance(
  result: AiEvidenceCopilotResult,
  candidate: {
    candidate_id: string;
    verifierReason: string;
    verifiedPage: number;
    verifiedExcerpt: string;
  },
): AiEvidenceProvenance {
  return {
    provider: result.provider,
    model: result.model,
    verifierModel: result.verifierModel,
    promptVersion: result.promptVersion,
    verifierPromptVersion: result.verifierPromptVersion,
    runId: result.runId,
    candidateId: candidate.candidate_id,
    status: "VERIFIED",
    verifierReason: candidate.verifierReason,
    evidencePage: candidate.verifiedPage,
    evidenceExcerpt: candidate.verifiedExcerpt,
  };
}

async function requestedAiExtraction(
  bytes: Uint8Array,
  contentType: string,
  documentType: DocumentRecord["type"],
): Promise<{ result: AiEvidenceCopilotResult | null; metadata: AiDocumentExtraction }> {
  const requestedAt = new Date().toISOString();
  const configuration = aiEvidenceConfiguration();
  const base = {
    provider: configuration.provider,
    model: configuration.model,
    verifierModel: configuration.verifierModel,
    promptVersion: AI_EVIDENCE_PROMPT_VERSION,
    verifierPromptVersion: AI_EVIDENCE_VERIFIER_PROMPT_VERSION,
    requestedAt,
    deterministicFallbackUsed: true,
  } as const;

  if (!configuration.configured) {
    return {
      result: null,
      metadata: {
        ...base,
        status: "UNAVAILABLE",
        completedAt: new Date().toISOString(),
        candidateCount: 0,
        verifiedCount: 0,
        rejectedCount: 0,
        abstentionCount: 0,
        warnings: [
          "AI processing was requested but is not configured. No document content was sent externally; local extraction remains available.",
        ],
      },
    };
  }

  let inputMode: AiDocumentExtraction["inputMode"];
  try {
    const prepared = await prepareAiEvidenceInput(bytes, contentType, documentType);
    inputMode = prepared.inputMode;
    const result = await runAiEvidenceCopilot(prepared);
    const status: AiDocumentExtraction["status"] =
      result.verifiedCount === 0
        ? "ABSTAINED"
        : result.verifiedCount === result.candidateCount && result.abstentionCount === 0
          ? "VERIFIED"
          : "PARTIAL";
    const warnings = [...result.warnings];
    for (const abstention of result.abstentions.slice(0, 8)) {
      const reason = abstention.reasonCode.replaceAll("_", " ").toLocaleLowerCase("en-US");
      const page = abstention.page ? ` on page ${abstention.page}` : "";
      warnings.push(
        `The ${abstention.stage.toLocaleLowerCase("en-US")} pass abstained${page}: ${reason}.`,
      );
    }
    if (result.verifiedCount === 0) {
      warnings.push(
        "No AI candidate passed grounding verification. Local extraction or manual transcription remains available.",
      );
    }
    return {
      result,
      metadata: {
        ...base,
        status,
        runId: result.runId,
        completedAt: new Date().toISOString(),
        inputMode: result.inputMode,
        candidateCount: result.candidateCount,
        verifiedCount: result.verifiedCount,
        rejectedCount: result.rejectedCount,
        abstentionCount: result.abstentionCount,
        warnings,
      },
    };
  } catch (error) {
    const failureCode =
      error instanceof AiEvidenceCopilotError ? error.code : "AI_EVIDENCE_INTERNAL_ERROR";
    // Deliberately content-free: never log a user/case/document ID, provider
    // response body, prompt, evidence excerpt, or credential.
    console.error(
      JSON.stringify({
        event: "ai_evidence_failed",
        code: failureCode,
        provider: configuration.provider,
        model: configuration.model,
        verifier_model: configuration.verifierModel,
        input_mode: inputMode ?? "NOT_PREPARED",
      }),
    );
    return {
      result: null,
      metadata: {
        ...base,
        status: "FAILED",
        completedAt: new Date().toISOString(),
        inputMode,
        candidateCount: 0,
        verifiedCount: 0,
        rejectedCount: 0,
        abstentionCount: 0,
        warnings: [
          aiFailureWarning(failureCode),
        ],
      },
    };
  }
}

function aiFailureWarning(code: string): string {
  const guidance: Record<string, string> = {
    AI_PROVIDER_BAD_REQUEST:
      "The provider rejected the vision request format. The operator should inspect the content-free Render diagnostic and verify provider compatibility.",
    AI_PROVIDER_AUTHENTICATION_FAILED:
      "The provider rejected the server credential. The operator should verify or rotate the configured API key.",
    AI_PROVIDER_ACCESS_DENIED:
      "The provider account or plan cannot access the configured model. The operator should verify model access and account credit.",
    AI_PROVIDER_MODEL_NOT_FOUND:
      "The configured model ID was not found by the provider. The operator should verify the exact model ID.",
    AI_PROVIDER_REQUEST_TOO_LARGE:
      "The provider rejected the bounded page request as too large. Try a shorter document while the operator reviews the provider limit.",
    AI_PROVIDER_TIMEOUT:
      "The provider did not finish within the bounded timeout. Try again once; repeated timeouts require an operator review.",
    AI_PROVIDER_TRANSIENT_ERROR:
      "The provider reported a temporary capacity or rate-limit failure. Try again once after a short delay.",
    AI_PROVIDER_UNAVAILABLE:
      "The provider could not be reached. Try again once; repeated failures require an operator review.",
    AI_PROVIDER_JSON_INVALID:
      "The provider returned invalid JSON, so no AI output was trusted.",
    AI_PROVIDER_SCHEMA_INVALID:
      "The provider response did not match the expected chat-completions envelope, so no AI output was trusted.",
    AI_MODEL_JSON_INVALID:
      "The model did not return valid JSON, so no AI output was trusted.",
    AI_MODEL_CONTENT_INVALID:
      "The model returned empty or oversized content, so no AI output was trusted.",
    AI_EXTRACTION_SCHEMA_INVALID:
      "The extraction output failed the strict evidence schema, so no AI output was trusted.",
    AI_EXTRACTION_PAGE_INVALID:
      "The extraction output cited a page that was not supplied, so no AI output was trusted.",
    AI_VERIFICATION_SCHEMA_INVALID:
      "The grounding output failed the strict verification schema, so no AI output was trusted.",
    AI_VERIFICATION_CANDIDATE_INVALID:
      "The grounding output referenced an unknown candidate, so no AI output was trusted.",
  };
  const fallback =
    "AI processing did not complete, so no AI output was trusted. Local extraction or manual transcription remains available.";
  return `${guidance[code] ?? fallback} Diagnostic code: ${code}.`;
}

export async function POST(request: Request, context: Context) {
  const identity = await authenticateCaseRequest(request);
  if (!identity) return authenticationRequired(request);
  const guarded = mutationGuard(request);
  if (guarded) return guarded;
  const declaredRequestBytes = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredRequestBytes) && declaredRequestBytes > MAX_REQUEST_BYTES) {
    return errorResponse("FILE_TOO_LARGE", `Files must be ${MAX_FILE_LABEL} or smaller.`, 413);
  }

  let storedDocument: DocumentRecord | null = null;
  let activeCaseId = "";
  try {
    const { caseId } = await context.params;
    activeCaseId = caseId;
    const caseData = await getCase(caseId, identity.user.userId);
    if (!caseData) return notFound();
    const usage = await caseStorageUsage(caseId, identity.user.userId);
    if (usage.documentCount >= MAX_CASE_DOCUMENTS) {
      return errorResponse(
        "CASE_QUOTA_EXCEEDED",
        `A review can contain at most ${MAX_CASE_DOCUMENTS} documents.`,
        409,
      );
    }

    const body = await parseFormDataBody(request, MAX_REQUEST_BYTES);
    if (!body.ok) return body.response;
    const form = body.value;
    const file = form.get("file");
    const typeResult = TypeSchema.safeParse(form.get("document_type"));
    const aiProcessingConsented = form.get("ai_processing_consent") === "accepted";
    if (!(file instanceof File) || !typeResult.success || file.size < 1) {
      return errorResponse(
        "INVALID_REQUEST",
        "Choose a supported non-empty document and identify its type.",
        400,
      );
    }
    if (file.size > MAX_FILE_BYTES) {
      return errorResponse("FILE_TOO_LARGE", `Files must be ${MAX_FILE_LABEL} or smaller.`, 413);
    }
    if (usage.totalBytes + file.size > MAX_CASE_BYTES) {
      return errorResponse(
        "CASE_QUOTA_EXCEEDED",
        `This review has reached its ${MAX_CASE_LABEL} private-storage limit.`,
        409,
      );
    }

    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const actualMime = detectedMime(bytes);
    if (!actualMime || !extensionMatches(file.name, actualMime)) {
      return errorResponse(
        "INVALID_UPLOAD_TYPE",
        "Upload a PDF, PNG, or JPEG whose extension matches its contents.",
        415,
      );
    }
    if (!validContainer(bytes, actualMime)) {
      return errorResponse(
        "INVALID_UPLOAD_TYPE",
        "The file is incomplete or has content after its expected end marker.",
        400,
      );
    }
    if (
      file.type &&
      file.type !== actualMime &&
      !(file.type === "image/jpg" && actualMime === "image/jpeg")
    ) {
      return errorResponse(
        "FILE_SIGNATURE_MISMATCH",
        "The file contents do not match the declared file type.",
        400,
      );
    }

    if (actualMime === "application/pdf") {
      const pdfText = new TextDecoder("latin1").decode(bytes);
      if (/\/Encrypt\b/.test(pdfText)) {
        return errorResponse(
          "DOCUMENT_PASSWORD_REQUIRED",
          "This PDF is protected. Create an unencrypted copy that you are authorized to use.",
          400,
        );
      }
      if (/\/(?:JavaScript|JS|EmbeddedFile|Launch|RichMedia)\b/.test(pdfText)) {
        return errorResponse(
          "DOCUMENT_ACTIVE_CONTENT",
          "This PDF contains active or embedded content and cannot be processed safely.",
          400,
        );
      }
    }

    const digest = await sha256(bytes);
    if (caseData.documents.some((document) => document.hash === digest)) {
      return errorResponse(
        "DUPLICATE_DOCUMENT",
        "This exact document is already in the review.",
        409,
      );
    }

    let extraction;
    try {
      // PDF.js may transfer/detach its input buffer. Give extraction an
      // isolated copy so the original bytes remain intact for private storage.
      extraction = await extractDocument(bytes.slice(), actualMime, typeResult.data);
    } catch (error) {
      if (error instanceof Error && error.message === "DOCUMENT_PAGE_LIMIT_EXCEEDED") {
        return errorResponse(
          "INVALID_REQUEST",
          `PDFs can contain at most ${UPLOAD_POLICY.maximumPdfPages} pages.`,
          400,
        );
      }
      return errorResponse(
        "INVALID_UPLOAD_TYPE",
        "The document parser could not safely read this file. Export a fresh PDF or image and try again.",
        422,
      );
    }

    const aiAttempt = aiProcessingConsented
      ? await requestedAiExtraction(bytes.slice(), actualMime, typeResult.data)
      : null;
    const aiResult = aiAttempt?.result ?? null;

    const factCandidates = uniqueBy(
      [
        ...(aiResult?.facts.map((candidate) => ({
          id: crypto.randomUUID(),
          type: candidate.type,
          label: candidate.label,
          rawValue: candidate.raw_value,
          normalizedValue: candidate.normalized_value,
          confidence: candidate.confidence,
          page: candidate.verifiedPage,
          evidenceText: candidate.verifiedExcerpt,
          ai: aiProvenance(aiResult, candidate),
        })) ?? []),
        ...extraction.facts.map((candidate) => ({ ...candidate, ai: undefined })),
      ],
      (candidate) => `${candidate.type}:${candidate.normalizedValue.toLocaleLowerCase("en-US")}`,
    );
    const payPeriodCandidates = uniqueBy(
      [
        ...(aiResult?.payPeriods.map((candidate) => ({
          id: crypto.randomUUID(),
          start: candidate.start,
          end: candidate.end,
          payDate: candidate.pay_date,
          ordinaryBaseCents: candidate.ordinary_base_cents,
          grossCents: candidate.gross_cents,
          confidence: candidate.confidence,
          page: candidate.verifiedPage,
          evidenceText: candidate.verifiedExcerpt,
          ai: aiProvenance(aiResult, candidate),
        })) ?? []),
        ...extraction.payPeriods.map((candidate) => ({ ...candidate, ai: undefined })),
      ],
      (candidate) =>
        `${candidate.start}:${candidate.end}:${candidate.ordinaryBaseCents}:${candidate.grossCents}`,
    );
    const deductionCandidates = uniqueBy(
      [
        ...(aiResult?.deductions.map((candidate) => ({
          id: crypto.randomUUID(),
          description: candidate.description,
          amountCents: candidate.amount_cents,
          date: candidate.date,
          confidence: candidate.confidence,
          page: candidate.verifiedPage,
          evidenceText: candidate.verifiedExcerpt,
          ai: aiProvenance(aiResult, candidate),
        })) ?? []),
        ...extraction.deductions.map((candidate) => ({ ...candidate, ai: undefined })),
      ],
      (candidate) =>
        `${candidate.amountCents}:${candidate.description
          .normalize("NFKC")
          .replace(/\s+/g, " ")
          .trim()
          .toLocaleLowerCase("en-US")}`,
    );

    const proposedWorksiteEvents = factCandidates.filter(
      (candidate) => candidate.type === "CURRENT_WORKSITE",
    ).length;
    const structuredLimitExceeded =
      caseData.facts.length + factCandidates.length > API_POLICY.maximumFactsPerCase ||
      caseData.payPeriods.length + payPeriodCandidates.length >
        API_POLICY.maximumPayPeriodsPerCase ||
      caseData.deductions.length + deductionCandidates.length >
        API_POLICY.maximumDeductionsPerCase ||
      caseData.events.length + proposedWorksiteEvents > API_POLICY.maximumEventsPerCase;
    if (structuredLimitExceeded) {
      return errorResponse(
        "CASE_QUOTA_EXCEEDED",
        "This document would exceed the review's structured-record limit. Remove older evidence or start a new review.",
        409,
      );
    }

    const documentId = `doc_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const document: DocumentRecord = {
      id: documentId,
      name: safeName(file.name),
      type: typeResult.data,
      required: ["LCA_CERTIFIED", "OFFER_OR_EMPLOYMENT_LETTER", "PAYSTUB"].includes(
        typeResult.data,
      ),
      status: extraction.method === "IMAGE_REVIEW_REQUIRED" ? "NEEDS_REVIEW" : "READY",
      pages: extraction.pageCount,
      bytes: file.size,
      contentType: actualMime,
      hash: digest,
      synthetic: false,
      uploadedAt: now,
      objectKey: `private/cases/${caseData.id}/original/${documentId}/v1/source`,
      note: aiAttempt
        ? "Validated and privately stored. AI-grounded and local proposals remain untrusted until you confirm or correct them."
        : "Validated, privately stored, and proposed values read from this file's text layer for your review.",
      extraction: {
        method: extraction.method,
        characterCount: extraction.characterCount,
        proposedFactCount: extraction.facts.length,
        proposedPayPeriodCount: extraction.payPeriods.length,
        proposedDeductionCount: extraction.deductions.length,
        warnings:
          aiResult && extraction.method === "IMAGE_REVIEW_REQUIRED"
            ? [
                "Local pixel extraction remains disabled. Separate opt-in AI proposals are shown with grounding provenance and still require your review.",
              ]
            : extraction.warnings,
        completedAt: now,
      },
      ...(aiAttempt ? { aiExtraction: aiAttempt.metadata } : {}),
    };
    storedDocument = document;
    await storeDocument(caseData, document, buffer);
    caseData.documents.push(document);

    const proposedFacts: FactRecord[] = factCandidates.map((candidate) => ({
      id: `fact_${candidate.id}`,
      type: candidate.type,
      label: candidate.label,
      rawValue: candidate.rawValue,
      normalizedValue: candidate.normalizedValue,
      confidence: candidate.confidence,
      reviewStatus: "NEEDS_REVIEW",
      affects: affectsForFact(candidate.type),
      evidence: evidence(
        document,
        candidate.page,
        candidate.label,
        candidate.evidenceText,
        candidate.type.startsWith("LCA") ? "benchmark" : "context",
      ),
      origin: candidate.ai ? "AI_EXTRACTED" : "EXTRACTED",
      originalRawValue: candidate.rawValue,
      ...(candidate.ai ? { aiProvenance: candidate.ai } : {}),
    }));
    caseData.facts.push(...proposedFacts);

    const proposedPeriods: PayPeriod[] = payPeriodCandidates.map((candidate) => ({
      id: `period_${candidate.id}`,
      start: candidate.start,
      end: candidate.end,
      payDate: candidate.payDate,
      ordinaryBaseCents: candidate.ordinaryBaseCents,
      grossCents: candidate.grossCents,
      complete: true,
      comparable: true,
      correctionStatus: "UNKNOWN",
      reviewStatus: "NEEDS_REVIEW",
      sourceDocumentId: document.id,
      evidence: evidence(
        document,
        candidate.page,
        "Proposed pay period",
        candidate.evidenceText,
        "observed",
      ),
      ...(candidate.ai ? { aiProvenance: candidate.ai } : {}),
    }));
    caseData.payPeriods.push(...proposedPeriods);

    const proposedDeductions: DeductionObservation[] = deductionCandidates.map((candidate) => ({
      id: `deduction_${candidate.id}`,
      description: candidate.description,
      amountCents: candidate.amountCents,
      date: candidate.date,
      category: deductionCategory(candidate.description),
      transactionStatus: "PAYROLL_OBSERVED",
      descriptionConfidence: candidate.confidence,
      reviewStatus: "NEEDS_REVIEW",
      sourceDocumentId: document.id,
      evidence: evidence(
        document,
        candidate.page,
        "Proposed deduction line",
        candidate.evidenceText,
        "observed",
      ),
      ...(candidate.ai ? { aiProvenance: candidate.ai } : {}),
    }));
    caseData.deductions.push(...proposedDeductions);

    for (const fact of proposedFacts.filter((item) => item.type === "CURRENT_WORKSITE")) {
      caseData.events.push({
        id: `event_${crypto.randomUUID()}`,
        kind: "WORKSITE_CHANGE",
        title: "Worksite instruction from uploaded record",
        start: caseData.reviewStart,
        certainty: "APPROXIMATE",
        attribution: "EMPLOYER",
        worksite: fact.rawValue,
        qualifier: "UNKNOWN",
        evidence: [fact.evidence],
      });
    }

    refreshDocumentReviewStatus(caseData, document.id);
    invalidateDerivedResults(caseData);
    await saveCase(caseData);
    await appendAudit(caseData.id, "DOCUMENT_PROPOSALS_CREATED", {
      documentId,
      type: document.type,
      pages: document.pages,
      factCount: proposedFacts.length,
      payPeriodCount: proposedPeriods.length,
      deductionCount: proposedDeductions.length,
      aiRequested: Boolean(aiAttempt),
      ...(aiAttempt
        ? {
            aiStatus: aiAttempt.metadata.status,
            aiProvider: aiAttempt.metadata.provider,
            aiModel: aiAttempt.metadata.model,
            aiVerifierModel: aiAttempt.metadata.verifierModel,
            aiPromptVersion: aiAttempt.metadata.promptVersion,
            aiVerifierPromptVersion: aiAttempt.metadata.verifierPromptVersion,
            aiCandidateCount: aiAttempt.metadata.candidateCount,
            aiVerifiedCount: aiAttempt.metadata.verifiedCount,
            aiRejectedCount: aiAttempt.metadata.rejectedCount,
            aiAbstentionCount: aiAttempt.metadata.abstentionCount,
          }
        : {}),
    });
    return jsonResponse({ document, extraction: document.extraction, case: caseData }, { status: 201 });
  } catch (error) {
    if (storedDocument && activeCaseId) {
      try {
        await deleteDocumentObject(activeCaseId, storedDocument.id, identity.user.userId);
      } catch {
        // A retention sweep also discovers case-prefix orphans.
      }
    }
    return internalError(error);
  }
}
