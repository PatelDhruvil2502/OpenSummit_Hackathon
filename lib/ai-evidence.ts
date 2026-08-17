/**
 * Server-only entry point for the AI Evidence Copilot. This module reads secret
 * Node environment variables and must only be imported by server routes.
 */
import { env } from "node:process";

import {
  AiEvidenceCopilotError,
  executeAiEvidenceCopilot,
  type AiEvidenceCopilotResult,
  type AiEvidenceRuntimeConfiguration,
} from "./ai-evidence-core";
import type { AiEvidencePreparedInput } from "./ai-evidence-input";

const DEFAULT_BASE_URL = "https://api.featherless.ai/v1";
const DEFAULT_MODEL = "Qwen/Qwen3-VL-8B-Instruct";
const DEFAULT_TIMEOUT_MS = 20_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;

export interface AiEvidenceConfiguration {
  configured: boolean;
  provider: string;
  model: string;
  verifierModel: string;
}

function modelName(value: string | undefined, fallback: string): string | null {
  const candidate = value?.trim() || fallback;
  if (!candidate || candidate.length > 200 || /[\r\n\0]/.test(candidate)) return null;
  return candidate;
}

function baseUrl(value: string | undefined): URL | null {
  try {
    const candidate = new URL(value?.trim() || DEFAULT_BASE_URL);
    if (
      candidate.protocol !== "https:" ||
      candidate.username ||
      candidate.password ||
      candidate.search ||
      candidate.hash
    ) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

function providerLabel(url: URL | null): string {
  return url?.hostname === "api.featherless.ai" ? "Featherless" : "OpenAI-compatible";
}

function requestTimeout(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value.trim())) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, parsed));
}

function runtimeConfiguration(): AiEvidenceRuntimeConfiguration | null {
  const url = baseUrl(env.AI_EVIDENCE_BASE_URL);
  const model = modelName(env.AI_EVIDENCE_MODEL, DEFAULT_MODEL);
  const verifierModel = model
    ? modelName(env.AI_EVIDENCE_VERIFIER_MODEL, model)
    : null;
  const apiKey = env.AI_EVIDENCE_API_KEY?.trim();
  if (
    !url ||
    !model ||
    !verifierModel ||
    !apiKey ||
    apiKey.length > 4_096 ||
    /[\r\n\0]/.test(apiKey)
  ) {
    return null;
  }
  return {
    apiKey,
    baseUrl: url.toString().replace(/\/$/, ""),
    provider: providerLabel(url),
    model,
    verifierModel,
    timeoutMs: requestTimeout(env.AI_EVIDENCE_TIMEOUT_MS),
  };
}

/** Safe for health/UI responses: never returns a key or provider endpoint. */
export function aiEvidenceConfiguration(): AiEvidenceConfiguration {
  const runtime = runtimeConfiguration();
  const url = baseUrl(env.AI_EVIDENCE_BASE_URL);
  const model = modelName(env.AI_EVIDENCE_MODEL, DEFAULT_MODEL) ?? DEFAULT_MODEL;
  const verifierModel =
    modelName(env.AI_EVIDENCE_VERIFIER_MODEL, model) ?? model;
  return {
    configured: runtime !== null,
    provider: providerLabel(url),
    model,
    verifierModel,
  };
}

export function aiEvidenceIsConfigured(): boolean {
  return runtimeConfiguration() !== null;
}

export async function runAiEvidenceCopilot(
  input: AiEvidencePreparedInput,
): Promise<AiEvidenceCopilotResult> {
  const runtime = runtimeConfiguration();
  if (!runtime) throw new AiEvidenceCopilotError("AI_EVIDENCE_NOT_CONFIGURED");
  return executeAiEvidenceCopilot(input, runtime);
}

export {
  AI_EVIDENCE_PROMPT_VERSION,
  AI_EVIDENCE_VERIFIER_PROMPT_VERSION,
  AiEvidenceCopilotError,
  type AiEvidenceCopilotResult,
} from "./ai-evidence-core";
