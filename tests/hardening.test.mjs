import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  createWorkerHarness,
  expectJsonError,
  minimalPdf,
  minimalPdfVariant,
} from "./helpers/worker-harness.mjs";

const ALICE = {
  id: "user-alice-hardening",
  email: "alice@example.test",
  name: "Alice Reviewer",
};
const BOB = {
  id: "user-bob-hardening",
  email: "bob@example.test",
  name: "Bob Reviewer",
};

let harness;
let anonymous;
let alice;
let bob;
let idempotencySequence = 0;

before(async () => {
  harness = await createWorkerHarness();
  anonymous = harness.anonymous;
  alice = harness.client(ALICE);
  bob = harness.client(BOB);
});

after(async () => {
  await harness?.dispose();
});

function caseCreationBody(scenario = "custom", overrides = {}) {
  if (scenario !== "custom") {
    return {
      mode: "sandbox",
      scenario,
      authorized_use_confirmed: true,
      retention_hours: 24,
      ...overrides,
    };
  }
  return {
    mode: "standard",
    title: "Private evidence review",
    worker_name: "Synthetic Test Worker",
    employer_name: "Synthetic Test Employer LLC",
    position: "Data Engineer",
    review_start: "2026-01-01",
    review_end: "2026-12-31",
    authorized_use_confirmed: true,
    retention_hours: 24,
    ...overrides,
  };
}

function nextIdempotencyKey(label = "create") {
  idempotencySequence += 1;
  return `hardening:${label}:${process.pid}:${Date.now()}:${idempotencySequence}`;
}

async function createCase(client, scenario = "custom", overrides = {}) {
  const { response, payload } = await client.json("/api/v1/cases", {
    method: "POST",
    headers: { "idempotency-key": nextIdempotencyKey(scenario) },
    json: caseCreationBody(scenario, overrides),
  });
  assert.equal(response.status, 201, JSON.stringify(payload));
  assert.ok(payload.case?.id);
  return payload.case;
}

async function getCase(client, caseId) {
  return client.json(`/api/v1/cases/${caseId}`);
}

function uploadForm(bytes, options = {}) {
  const form = new FormData();
  form.set(
    "file",
    new File([bytes], options.filename ?? "synthetic-record.pdf", {
      type: options.contentType ?? "application/pdf",
    }),
  );
  form.set("document_type", options.documentType ?? "PAYSTUB");
  form.set("is_synthetic", String(options.synthetic ?? true));
  return form;
}

async function uploadSupportingDocument(client, caseId, documentType, variant) {
  const result = await client.json(`/api/v1/cases/${caseId}/uploads`, {
    method: "POST",
    body: uploadForm(minimalPdfVariant(variant), {
      filename: `${String(variant).padStart(2, "0")}-${documentType.toLowerCase()}.pdf`,
      documentType,
    }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.payload));
  return result.payload.document;
}

function findingProjection(findings) {
  return findings.map((finding) => ({
    id: finding.id,
    module: finding.module,
    status: finding.status,
    amountCents: finding.amountCents,
    diagnostics: finding.diagnostics,
    calculation: finding.calculation,
    evidenceIds: finding.evidence.map((item) => item.id),
    ruleVersion: finding.ruleVersion,
  }));
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function extractPdfText(bytes) {
  const directory = await mkdtemp(join(tmpdir(), "wageshield-report-test-"));
  const file = join(directory, "report.pdf");
  try {
    await writeFile(file, bytes);
    return execFileSync("pdftotext", [file, "-"], { encoding: "utf8" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("anonymous API calls are denied without creating an identity cookie", async () => {
  for (const [method, path, json] of [
    ["GET", "/api/v1/cases", undefined],
    [
      "POST",
      "/api/v1/cases",
      { scenario: "custom", authorized_use_confirmed: true, retention_hours: 24 },
    ],
  ]) {
    const response = await anonymous.request(path, { method, json });
    const error = await expectJsonError(response, 401, "AUTHENTICATION_REQUIRED");
    assert.equal(error.retryable, false);
    assert.ok(error.request_id);
    assert.equal(response.headers.get("x-request-id"), error.request_id);
    assert.ok(error.sign_in_url);
    assert.match(response.headers.get("cache-control") ?? "", /private.*no-store/i);
    assert.doesNotMatch(response.headers.get("set-cookie") ?? "", /wageshield_session=/i);
  }
});

test("email signup and signin persist an account in D1 and isolate cases", async () => {
  const local = harness.client(null, { origin: "http://localhost" });
  const page = await local.request("/signin?return_to=%2Fcases", {
    headers: { accept: "text/html" },
  });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Sign in|Create an account/i);

  const signupForm = new URLSearchParams({
    email: "local@example.test",
    full_name: "Local Reviewer",
    password: "correct-horse-battery",
    return_to: "/cases",
  });
  const signup = await local.request("/api/auth/signup", {
    method: "POST",
    body: signupForm,
  });
  assert.equal(signup.status, 303);
  assert.equal(signup.headers.get("location"), "/cases");
  const loginCookie = signup.headers.get("set-cookie") ?? "";
  assert.match(loginCookie, /^wageshield_auth=/i);
  assert.match(loginCookie, /Path=\//i);
  assert.match(loginCookie, /HttpOnly/i);
  assert.match(loginCookie, /SameSite=Lax/i);
  assert.match(loginCookie, /Max-Age=2592000/i);

  const authenticated = await local.request("/api/v1/cases");
  assert.equal(authenticated.status, 200);

  const duplicate = await harness.client(null, { origin: "http://localhost" }).request("/api/auth/signup", {
    method: "POST",
    body: signupForm,
  });
  assert.equal(duplicate.status, 303);
  assert.match(duplicate.headers.get("location") ?? "", /error=exists/);

  const signout = await local.request("/signout?return_to=%2F", {
    headers: { accept: "text/html" },
  });
  assert.equal(signout.status, 303);
  assert.equal(signout.headers.get("location"), "/");
  assert.match(signout.headers.get("set-cookie") ?? "", /Max-Age=0/i);

  const afterSignout = await local.request("/api/v1/cases");
  assert.equal(afterSignout.status, 401);

  const signedOutClient = harness.client(null, { origin: "http://localhost" });
  const signin = await signedOutClient.request("/api/auth/signin", {
    method: "POST",
    body: new URLSearchParams({
      email: "local@example.test",
      password: "correct-horse-battery",
      return_to: "/cases",
    }),
  });
  assert.equal(signin.status, 303);
  assert.equal(signin.headers.get("location"), "/cases");
  assert.equal((await signedOutClient.request("/api/v1/cases")).status, 200);

  const owner = harness.client(null, { origin: "http://localhost" });
  await owner.request("/api/auth/signup", {
    method: "POST",
    body: new URLSearchParams({
      email: "owner@example.test",
      full_name: "Case Owner",
      password: "correct-horse-battery",
      return_to: "/cases",
    }),
  });
  const createdPrivate = await createCase(owner, "custom", { title: "Owner only review" });
  const stranger = harness.client(null, { origin: "http://localhost" });
  await stranger.request("/api/auth/signup", {
    method: "POST",
    body: new URLSearchParams({
      email: "stranger@example.test",
      full_name: "Other User",
      password: "correct-horse-battery",
      return_to: "/cases",
    }),
  });
  const strangerList = await stranger.json("/api/v1/cases");
  assert.equal(strangerList.response.status, 200);
  assert.equal(
    strangerList.payload.cases.some((item) => item.id === createdPrivate.id),
    false,
  );
  assert.equal((await getCase(stranger, createdPrivate.id)).response.status, 404);

  const productionHost = harness.client(null, { origin: "https://wageshield.test" });
  const disabled = await productionHost.request("/api/auth/dev/session", {
    method: "POST",
    body: new URLSearchParams({
      email: "local@example.test",
      full_name: "Local Reviewer",
      return_to: "/cases",
    }),
  });
  assert.equal(disabled.status, 404);
});

test("authenticated identity is stable and cases are isolated by owner", async () => {
  const created = await createCase(alice, "custom", { title: "Alice private review" });
  assert.doesNotMatch(JSON.stringify(created), /ownerUserId|owner_user_id/i);

  const firstList = await alice.json("/api/v1/cases");
  const secondList = await alice.json("/api/v1/cases");
  assert.equal(firstList.response.status, 200);
  assert.deepEqual(
    firstList.payload.cases.map((item) => item.id),
    secondList.payload.cases.map((item) => item.id),
  );
  assert.ok(firstList.payload.cases.some((item) => item.id === created.id));

  const aliceRead = await getCase(alice, created.id);
  assert.equal(aliceRead.response.status, 200);
  assert.equal(aliceRead.payload.case.id, created.id);

  const renamedAlice = harness.client({
    id: ALICE.id,
    email: "alice-renamed@example.test",
    name: "Alice Updated Name",
  });
  const stableIdentityRead = await getCase(renamedAlice, created.id);
  assert.equal(stableIdentityRead.response.status, 200);

  const bobList = await bob.json("/api/v1/cases");
  assert.equal(bobList.response.status, 200);
  assert.ok(!bobList.payload.cases.some((item) => item.id === created.id));

  const denied = await bob.request(`/api/v1/cases/${created.id}`);
  const missing = await bob.request(`/api/v1/cases/case_does_not_exist`);
  const [deniedError, missingError] = await Promise.all([
    expectJsonError(denied, 404, "CASE_ACCESS_DENIED"),
    expectJsonError(missing, 404, "CASE_ACCESS_DENIED"),
  ]);
  assert.equal(deniedError.message, missingError.message);
});

test("case creation, validation, updates, and state versions obey the API contract", async () => {
  const beforeCreate = Date.now();
  const created = await createCase(alice, "custom", {
    title: "Lifecycle test",
    retention_hours: 1,
  });
  assert.equal(created.state, "INTAKE_COMPLETE");
  assert.equal(created.retentionHours, 1);
  assert.ok(Date.parse(created.retentionExpiresAt) >= beforeCreate + 59 * 60 * 1000);
  assert.ok(Date.parse(created.retentionExpiresAt) <= Date.now() + 61 * 60 * 1000);

  const missingConsent = await alice.request("/api/v1/cases", {
    method: "POST",
    headers: { "idempotency-key": nextIdempotencyKey("missing-consent") },
    json: caseCreationBody("custom", { authorized_use_confirmed: false }),
  });
  await expectJsonError(missingConsent, 400, "INVALID_REQUEST");

  const missingIdempotency = await alice.request("/api/v1/cases", {
    method: "POST",
    json: caseCreationBody("custom", { title: "Missing idempotency key" }),
  });
  await expectJsonError(missingIdempotency, 400, "IDEMPOTENCY_REQUIRED");

  const replayKey = nextIdempotencyKey("replay");
  const replayBody = caseCreationBody("custom", { title: "Idempotent replay" });
  const firstCreate = await alice.json("/api/v1/cases", {
    method: "POST",
    headers: { "idempotency-key": replayKey },
    json: replayBody,
  });
  const replayedCreate = await alice.json("/api/v1/cases", {
    method: "POST",
    headers: { "idempotency-key": replayKey },
    json: replayBody,
  });
  assert.equal(firstCreate.response.status, 201);
  assert.equal(replayedCreate.response.status, 201);
  assert.equal(replayedCreate.payload.case.id, firstCreate.payload.case.id);

  const crossSite = await alice.request("/api/v1/cases", {
    method: "POST",
    headers: {
      "idempotency-key": nextIdempotencyKey("cross-site"),
      origin: "https://attacker.example",
    },
    json: caseCreationBody("custom", { title: "Cross-site attempt" }),
  });
  await expectJsonError(crossSite, 403, "CSRF_REJECTED");

  const patched = await alice.json(`/api/v1/cases/${created.id}`, {
    method: "PATCH",
    json: {
      title: "Updated lifecycle test",
      review_start: "2026-01-01",
      review_end: "2026-12-31",
      retention_hours: 168,
    },
  });
  assert.equal(patched.response.status, 200);
  assert.equal(patched.payload.case.title, "Updated lifecycle test");
  assert.equal(patched.payload.case.retentionHours, 168);
  assert.ok(patched.payload.case.stateVersion > created.stateVersion);

  const reversed = await alice.request(`/api/v1/cases/${created.id}`, {
    method: "PATCH",
    json: { review_start: "2026-12-31", review_end: "2026-01-01" },
  });
  await expectJsonError(reversed, 400, "INVALID_REQUEST");

  const overRetention = await alice.request(`/api/v1/cases/${created.id}`, {
    method: "PATCH",
    json: { retention_hours: 169 },
  });
  await expectJsonError(overRetention, 400, "INVALID_REQUEST");
});

test("upload validation rejects unsafe inputs and stores only case-scoped valid bytes", async () => {
  const created = await createCase(alice, "custom", { title: "Upload validation" });
  const endpoint = `/api/v1/cases/${created.id}/uploads`;
  const bytes = minimalPdf();

  const accepted = await alice.json(endpoint, {
    method: "POST",
    body: uploadForm(bytes, { filename: "../unsafe/name.pdf" }),
  });
  assert.equal(accepted.response.status, 201, JSON.stringify(accepted.payload));
  assert.equal(accepted.payload.case.state, "FACT_REVIEW_REQUIRED");
  assert.equal(accepted.payload.document.contentType, "application/pdf");
  assert.equal(accepted.payload.document.synthetic, false);
  assert.match(accepted.payload.document.hash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(accepted.payload.document.name, /[\\/]/);
  assert.equal(accepted.payload.document.objectKey, undefined);
  const storedObject = await harness.DB.prepare(
    "SELECT object_key, byte_size FROM document_objects WHERE id = ? AND case_id = ?",
  )
    .bind(accepted.payload.document.id, created.id)
    .first();
  assert.match(storedObject.object_key, new RegExp(created.id));
  assert.equal(Number(storedObject.byte_size), bytes.byteLength);
  assert.equal((await harness.BUCKET.get(storedObject.object_key)).size, bytes.byteLength);

  const duplicate = await alice.request(endpoint, {
    method: "POST",
    body: uploadForm(bytes),
  });
  await expectJsonError(duplicate, 409, "DUPLICATE_DOCUMENT");

  const mismatch = await alice.request(endpoint, {
    method: "POST",
    body: uploadForm(bytes, { contentType: "image/png" }),
  });
  await expectJsonError(mismatch, 400, "FILE_SIGNATURE_MISMATCH");

  const unsupported = await alice.request(endpoint, {
    method: "POST",
    body: uploadForm(new TextEncoder().encode("plain text"), {
      contentType: "text/plain",
    }),
  });
  await expectJsonError(unsupported, 415, "INVALID_UPLOAD_TYPE");

  const encrypted = await alice.request(endpoint, {
    method: "POST",
    body: uploadForm(minimalPdf("/Encrypt")),
  });
  await expectJsonError(encrypted, 400, "DOCUMENT_PASSWORD_REQUIRED");

  const active = await alice.request(endpoint, {
    method: "POST",
    body: uploadForm(minimalPdf("/JavaScript")),
  });
  await expectJsonError(active, 400, "DOCUMENT_ACTIVE_CONTENT");

  const oversizedBytes = new Uint8Array(12 * 1024 * 1024 + 1);
  oversizedBytes.set(new TextEncoder().encode("%PDF-1.4"));
  const oversized = await alice.request(endpoint, {
    method: "POST",
    body: uploadForm(oversizedBytes),
  });
  await expectJsonError(oversized, 413, "FILE_TOO_LARGE");

  const documentId = accepted.payload.document.id;
  const aliceDownload = await alice.request(
    `/api/v1/cases/${created.id}/documents/${documentId}`,
  );
  assert.equal(aliceDownload.status, 200);
  assert.equal(aliceDownload.headers.get("content-security-policy"), "sandbox");
  assert.equal(aliceDownload.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(new Uint8Array(await aliceDownload.arrayBuffer()), bytes);

  const bobDownload = await bob.request(
    `/api/v1/cases/${created.id}/documents/${documentId}`,
  );
  await expectJsonError(bobDownload, 404, "CASE_ACCESS_DENIED");
});

test("manual fact review and correction invalidate findings and remain auditable", async () => {
  const created = await createCase(alice, "custom", { title: "Manual facts" });
  await uploadSupportingDocument(alice, created.id, "LCA_CERTIFIED", 1);
  await uploadSupportingDocument(
    alice,
    created.id,
    "OFFER_OR_EMPLOYMENT_LETTER",
    2,
  );
  await uploadSupportingDocument(alice, created.id, "PAYSTUB", 3);
  await uploadSupportingDocument(alice, created.id, "PAYSTUB", 4);
  const manual = await alice.json(`/api/v1/cases/${created.id}/facts/manual`, {
    method: "POST",
    json: {
      worker_name: "Synthetic Worker",
      employer_name: "Synthetic Employer LLC",
      position: "Data Engineer",
      lca_annual_dollars: "120000.00",
      offer_annual_dollars: "120000.00",
      pay_frequency: "BIWEEKLY",
      observed_biweekly_dollars: "3769.23",
      pay_period_start: "2026-04-01",
      pay_period_end: "2026-04-15",
      pay_date: "2026-04-17",
      lca_worksite: "Indianapolis, Indiana",
      offer_worksite: "Indianapolis, Indiana",
      current_worksite: "Columbus, Ohio",
      worksite_qualifier: "UNKNOWN",
      deduction_description: "H-1B filing/legal fee recovery",
      deduction_dollars: "1500.00",
      deduction_date: "2026-04-17",
      nonproductive_start: "2026-05-04",
      nonproductive_end: "2026-05-18",
      employer_related_reason: true,
      worker_available: true,
      employment_active: true,
      nonproductive_observed_dollars: "0.00",
    },
  });
  assert.equal(manual.response.status, 200, JSON.stringify(manual.payload));
  assert.equal(manual.payload.case.state, "READY_FOR_ANALYSIS");
  assert.equal(manual.payload.case.findings.length, 0);
  assert.ok(
    manual.payload.case.facts.every((item) => item.reviewStatus === "USER_CORRECTED"),
  );

  const lcaFact = manual.payload.case.facts.find(
    (item) => item.type === "LCA_WAGE_ANNUAL_CENTS",
  );
  assert.ok(lcaFact);
  const corrected = await alice.json(
    `/api/v1/cases/${created.id}/facts/${lcaFact.id}/corrections`,
    {
      method: "POST",
      json: { raw_value: "$125,000.00 per year", normalized_value: "12500000" },
    },
  );
  assert.equal(corrected.response.status, 200);
  assert.equal(corrected.payload.fact.reviewStatus, "USER_CORRECTED");
  assert.equal(corrected.payload.fact.normalizedValue, "12500000");
  assert.equal(corrected.payload.case.corrections.length, 1);
  assert.equal(corrected.payload.case.corrections[0].previousValue, "$120,000.00 per year");
  assert.equal(corrected.payload.case.state, "READY_FOR_ANALYSIS");
  assert.equal(corrected.payload.case.findings.length, 0);

  const unknownFact = await alice.request(
    `/api/v1/cases/${created.id}/facts/fact_missing/corrections`,
    { method: "POST", json: { raw_value: "x", normalized_value: "x" } },
  );
  await expectJsonError(unknownFact, 404, "CASE_ACCESS_DENIED");
});

test("canonical fixtures and repeated analyses produce deterministic findings", async () => {
  const expected = {
    WAGE_BENCHMARK: ["POSSIBLE_DISCREPANCY", 507_693],
    NONPRODUCTIVE_TIME: ["POSSIBLE_DISCREPANCY", 461_538],
    DEDUCTIONS_FEES: ["POSSIBLE_DISCREPANCY", 150_000],
    EMPLOYMENT_FACTS: ["HUMAN_REVIEW_REQUIRED", undefined],
  };
  const hero = await createCase(alice, "hero", { title: "Deterministic hero" });
  const initial = Object.fromEntries(
    hero.findings.map((finding) => [finding.module, [finding.status, finding.amountCents]]),
  );
  assert.deepEqual(initial, expected);

  const firstAnalysisKey = nextIdempotencyKey("analysis");
  const firstRun = await alice.json(`/api/v1/cases/${hero.id}/analyses`, {
    method: "POST",
    headers: { "idempotency-key": firstAnalysisKey },
  });
  const secondRun = await alice.json(`/api/v1/cases/${hero.id}/analyses`, {
    method: "POST",
    headers: { "idempotency-key": nextIdempotencyKey("analysis") },
  });
  const replayedRun = await alice.json(`/api/v1/cases/${hero.id}/analyses`, {
    method: "POST",
    headers: { "idempotency-key": firstAnalysisKey },
  });
  assert.equal(firstRun.response.status, 201);
  assert.equal(secondRun.response.status, 201);
  assert.equal(replayedRun.response.status, 201);
  assert.equal(replayedRun.payload.analysis.id, firstRun.payload.analysis.id);
  assert.deepEqual(
    findingProjection(firstRun.payload.case.findings),
    findingProjection(secondRun.payload.case.findings),
  );
  assert.equal(secondRun.payload.case.findings.length, 4);
  assert.equal(secondRun.payload.case.state, "RESULTS_READY");
});

test("finding updates are owner-scoped and preserve deterministic result fields", async () => {
  const hero = await createCase(alice, "hero", { title: "Finding update" });
  const finding = hero.findings[0];
  const updated = await alice.json(
    `/api/v1/cases/${hero.id}/findings/${finding.id}`,
    {
      method: "PATCH",
      json: { include_in_report: false, disposition: "EXPLAINED" },
    },
  );
  assert.equal(updated.response.status, 200);
  assert.equal(updated.payload.finding.includeInReport, false);
  assert.equal(updated.payload.finding.disposition, "EXPLAINED");
  assert.equal(updated.payload.finding.status, finding.status);
  assert.deepEqual(updated.payload.finding.calculation, finding.calculation);

  const denied = await bob.request(
    `/api/v1/cases/${hero.id}/findings/${finding.id}`,
    {
      method: "PATCH",
      json: { include_in_report: true },
    },
  );
  await expectJsonError(denied, 404, "CASE_ACCESS_DENIED");
});

test("report generation reconstructs redacted bytes and exposes a reproducible manifest", async () => {
  const hero = await createCase(alice, "hero", { title: "Report hardening" });
  const selected = [hero.findings[0].id, hero.findings[2].id];

  const empty = await alice.request(`/api/v1/cases/${hero.id}/reports`, {
    method: "POST",
    headers: { "idempotency-key": nextIdempotencyKey("empty-report") },
    json: { included_finding_ids: [] },
  });
  await expectJsonError(empty, 400, "INVALID_REQUEST");

  const duplicateSelection = await alice.request(
    `/api/v1/cases/${hero.id}/reports`,
    {
      method: "POST",
      headers: { "idempotency-key": nextIdempotencyKey("duplicate-report") },
      json: { included_finding_ids: [selected[0], selected[0]] },
    },
  );
  await expectJsonError(duplicateSelection, 400, "INVALID_REQUEST");

  const stale = await alice.request(`/api/v1/cases/${hero.id}/reports`, {
    method: "POST",
    headers: { "idempotency-key": nextIdempotencyKey("stale-report") },
    json: { included_finding_ids: ["finding_stale"] },
  });
  await expectJsonError(stale, 409, "INVALID_REQUEST");

  const reportKey = nextIdempotencyKey("report");
  const generated = await alice.json(`/api/v1/cases/${hero.id}/reports`, {
    method: "POST",
    headers: { "idempotency-key": reportKey },
    json: {
      included_finding_ids: selected,
      redact_worker_name: true,
      redact_employer_name: true,
    },
  });
  assert.equal(generated.response.status, 201, JSON.stringify(generated.payload));
  assert.equal(generated.payload.report.status, "READY");
  assert.deepEqual(generated.payload.report.manifest.included_finding_ids, selected);
  assert.deepEqual(generated.payload.report.manifest.redactions.sort(), [
    "employer_name",
    "worker_name",
  ]);

  const replayed = await alice.json(`/api/v1/cases/${hero.id}/reports`, {
    method: "POST",
    headers: { "idempotency-key": reportKey },
    json: {
      included_finding_ids: selected,
      redact_worker_name: true,
      redact_employer_name: true,
    },
  });
  assert.equal(replayed.response.status, 201);
  assert.equal(replayed.payload.report.id, generated.payload.report.id);

  const reportId = generated.payload.report.id;
  const download = await alice.request(
    `/api/v1/cases/${hero.id}/reports/${reportId}`,
  );
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-type") ?? "", /^application\/pdf/i);
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  const reportBytes = await download.arrayBuffer();
  assert.equal(await sha256Hex(reportBytes), generated.payload.report.sha256);
  assert.equal(new TextDecoder().decode(reportBytes.slice(0, 5)), "%PDF-");

  const text = await extractPdfText(new Uint8Array(reportBytes));
  assert.doesNotMatch(text, /Arjun Mehta/i);
  assert.doesNotMatch(text, /Northstar Data Systems LLC/i);
  assert.match(text, /REDACTED BY USER/i);
  assert.match(text, /Observed ordinary base pay is below/i);
  assert.match(text, /filing(?:\/| or )legal fee/i);
  assert.doesNotMatch(
    text,
    /unpaid interval may be related to an employer-side delay/i,
  );

  const manifest = await alice.json(
    `/api/v1/cases/${hero.id}/reports/${reportId}/manifest`,
  );
  assert.equal(manifest.response.status, 200);
  assert.equal(manifest.payload.manifest.pdf_sha256, generated.payload.report.sha256);
  assert.deepEqual(manifest.payload.manifest.included_finding_ids, selected);
  assert.equal(
    manifest.payload.manifest.redaction_method,
    "allowlisted structured reconstruction",
  );
  assert.equal(manifest.payload.manifest.rule_set_version, hero.ruleSetVersion);
  assert.equal(manifest.payload.manifest.source_corpus_version, hero.sourceCorpusVersion);

  const second = await alice.json(`/api/v1/cases/${hero.id}/reports`, {
    method: "POST",
    headers: { "idempotency-key": nextIdempotencyKey("second-report") },
    json: {
      included_finding_ids: [hero.findings[1].id],
      redact_worker_name: true,
      redact_employer_name: false,
    },
  });
  assert.equal(second.response.status, 201, JSON.stringify(second.payload));
  assert.notEqual(second.payload.report.id, reportId);

  const history = await alice.json(`/api/v1/cases/${hero.id}/reports`);
  assert.equal(history.response.status, 200);
  assert.equal(history.payload.reports.length, 2);
  assert.equal(history.payload.reports[0].status, "CURRENT");
  assert.equal(history.payload.reports[1].status, "SUPERSEDED");
  assert.ok(history.payload.reports.some((item) => item.id === reportId));

  const oldManifest = await alice.json(
    `/api/v1/cases/${hero.id}/reports/${reportId}/manifest`,
  );
  assert.equal(oldManifest.response.status, 200);
  assert.deepEqual(oldManifest.payload.manifest.included_finding_ids, selected);

  for (const path of [
    `/api/v1/cases/${hero.id}/reports/${reportId}`,
    `/api/v1/cases/${hero.id}/reports/${reportId}/manifest`,
  ]) {
    const denied = await bob.request(path);
    await expectJsonError(denied, 404, "CASE_ACCESS_DENIED");
  }

  const deniedDelete = await bob.request(
    `/api/v1/cases/${hero.id}/reports/${second.payload.report.id}`,
    { method: "DELETE" },
  );
  await expectJsonError(deniedDelete, 404, "CASE_ACCESS_DENIED");

  const removed = await alice.json(
    `/api/v1/cases/${hero.id}/reports/${second.payload.report.id}`,
    { method: "DELETE" },
  );
  assert.equal(removed.response.status, 200);
  assert.equal(removed.payload.deletion.status, "DELETED");
  await expectJsonError(
    await alice.request(
      `/api/v1/cases/${hero.id}/reports/${second.payload.report.id}`,
    ),
    404,
    "CASE_ACCESS_DENIED",
  );
});

test("verified case deletion removes database rows and private objects but keeps a hashed tombstone", async () => {
  const hero = await createCase(alice, "hero", { title: "Deletion verification" });
  const selected = [hero.findings[0].id];
  const generated = await alice.json(`/api/v1/cases/${hero.id}/reports`, {
    method: "POST",
    headers: { "idempotency-key": nextIdempotencyKey("deletion-report") },
    json: {
      included_finding_ids: selected,
      redact_worker_name: true,
      redact_employer_name: true,
    },
  });
  assert.equal(generated.response.status, 201);
  const reportId = generated.payload.report.id;
  const document = generated.payload.case.documents[0];
  assert.equal(document.objectKey, undefined);
  assert.equal(generated.payload.case.lastReport.objectKey, undefined);
  const documentObject = await harness.DB.prepare(
    "SELECT object_key FROM document_objects WHERE id = ? AND case_id = ?",
  )
    .bind(document.id, hero.id)
    .first();
  const reportObject = await harness.DB.prepare(
    "SELECT object_key FROM reports WHERE id = ? AND case_id = ?",
  )
    .bind(reportId, hero.id)
    .first();
  const documentObjectKey = documentObject.object_key;
  const reportObjectKey = reportObject.object_key;
  assert.ok(await harness.BUCKET.get(documentObjectKey));
  assert.ok(await harness.BUCKET.get(reportObjectKey));

  const denied = await bob.request(`/api/v1/cases/${hero.id}`, { method: "DELETE" });
  await expectJsonError(denied, 404, "CASE_ACCESS_DENIED");

  const deletion = await alice.json(`/api/v1/cases/${hero.id}`, {
    method: "DELETE",
    headers: { "idempotency-key": nextIdempotencyKey("case-delete") },
  });
  assert.equal(deletion.response.status, 200);
  assert.deepEqual(
    {
      status: deletion.payload.deletion.status,
      verified: deletion.payload.deletion.verified,
    },
    { status: "DELETED", verified: true },
  );

  await expectJsonError(
    await alice.request(`/api/v1/cases/${hero.id}`),
    404,
    "CASE_ACCESS_DENIED",
  );
  await expectJsonError(
    await alice.request(`/api/v1/cases/${hero.id}/documents/${document.id}`),
    404,
    "CASE_ACCESS_DENIED",
  );
  await expectJsonError(
    await alice.request(`/api/v1/cases/${hero.id}/reports/${reportId}`),
    404,
    "CASE_ACCESS_DENIED",
  );
  assert.equal(await harness.BUCKET.get(documentObjectKey), null);
  assert.equal(await harness.BUCKET.get(reportObjectKey), null);

  for (const table of ["cases", "document_objects", "reports", "audit_events"]) {
    const row = await harness.DB.prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE ${table === "cases" ? "id" : "case_id"} = ?`,
    )
      .bind(hero.id)
      .first();
    assert.equal(Number(row.count), 0, table);
  }
  const tombstone = await harness.DB.prepare(
    "SELECT case_id_hash, policy_version FROM deletion_tombstones ORDER BY completed_at DESC LIMIT 1",
  ).first();
  assert.match(tombstone.case_id_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(tombstone.case_id_hash, hero.id);
  assert.equal(tombstone.policy_version, "deletion.v1");
});

test("expired retention blocks lists, case reads, and private document downloads", async () => {
  const hero = await createCase(alice, "hero");
  const document = hero.documents[0];
  assert.ok(document);

  await harness.DB.prepare(
    "UPDATE cases SET retention_expires_at = ? WHERE id = ?",
  )
    .bind("2000-01-01T00:00:00.000Z", hero.id)
    .run();

  const listed = await alice.json("/api/v1/cases");
  assert.equal(listed.response.status, 200);
  assert.ok(!listed.payload.cases.some((item) => item.id === hero.id));
  await expectJsonError(
    await alice.request(`/api/v1/cases/${hero.id}`),
    404,
    "CASE_ACCESS_DENIED",
  );
  await expectJsonError(
    await alice.request(`/api/v1/cases/${hero.id}/documents/${document.id}`),
    404,
    "CASE_ACCESS_DENIED",
  );
});

test("public and authenticated critical routes render without private-data leakage", async () => {
  for (const [path, pattern] of [
    ["/", /Turn scattered employment records into a clear evidence map/i],
    ["/methodology", /Document understanding can assist/i],
    ["/api/v1/health", /ok|healthy/i],
  ]) {
    const response = await anonymous.request(path, {
      headers: { accept: path.startsWith("/api/") ? "application/json" : "text/html" },
    });
    assert.equal(response.status, 200, path);
    assert.match(await response.text(), pattern, path);
  }

  for (const path of ["/cases", "/cases/case_private"] ) {
    const response = await anonymous.request(path, {
      headers: { accept: "text/html" },
    });
    assert.ok([302, 303, 307, 308].includes(response.status), `${path}: ${response.status}`);
    assert.match(response.headers.get("location") ?? "", /sign|login/i);
  }

  const casesPage = await alice.request("/cases", {
    headers: { accept: "text/html" },
  });
  assert.equal(casesPage.status, 200);
  const casesHtml = await casesPage.text();
  assert.match(casesHtml, /My evidence reviews/i);
  assert.doesNotMatch(casesHtml, /Arjun Mehta|Northstar Data Systems/i);
});

test("expired retention is swept automatically and verifies every inventoried artifact", async () => {
  const hero = await createCase(alice, "hero", { title: "Scheduled retention sweep" });
  const generated = await alice.json(`/api/v1/cases/${hero.id}/reports`, {
    method: "POST",
    headers: { "idempotency-key": nextIdempotencyKey("retention-report") },
    json: {
      included_finding_ids: [hero.findings[0].id],
      redact_worker_name: true,
      redact_employer_name: true,
    },
  });
  assert.equal(generated.response.status, 201, JSON.stringify(generated.payload));

  const inventory = await harness.DB.prepare(
    `SELECT object_key, 'document' AS object_type FROM document_objects WHERE case_id = ?
      UNION ALL
      SELECT object_key, 'report' AS object_type FROM reports WHERE case_id = ?`,
  )
    .bind(hero.id, hero.id)
    .all();
  assert.equal(inventory.results.length, hero.documents.length + 1);
  assert.ok(inventory.results.some((item) => item.object_type === "document"));
  assert.ok(inventory.results.some((item) => item.object_type === "report"));
  for (const item of inventory.results) {
    assert.ok(await harness.BUCKET.get(item.object_key), item.object_key);
  }

  const retained = await createCase(alice, "clean", { title: "Unexpired control" });
  await harness.DB.prepare(
    "UPDATE cases SET retention_expires_at = ? WHERE id = ?",
  )
    .bind("2000-01-01T00:00:00.000Z", hero.id)
    .run();

  const scheduled = await harness.scheduled({
    cron: "*/15 * * * *",
    scheduledTime: new Date("2026-08-15T12:00:00.000Z"),
  });
  assert.equal(scheduled.status, 200);
  const scheduledResult = await scheduled.json();
  assert.equal(scheduledResult.outcome, "ok");

  for (const table of ["cases", "document_objects", "reports", "audit_events"]) {
    const row = await harness.DB.prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE ${table === "cases" ? "id" : "case_id"} = ?`,
    )
      .bind(hero.id)
      .first();
    assert.equal(Number(row.count), 0, table);
  }
  for (const item of inventory.results) {
    assert.equal(await harness.BUCKET.get(item.object_key), null, item.object_key);
  }

  const expectedHash = await sha256Hex(new TextEncoder().encode(hero.id));
  const tombstone = await harness.DB.prepare(
    "SELECT case_id_hash, policy_version FROM deletion_tombstones WHERE case_id_hash = ?",
  )
    .bind(expectedHash)
    .first();
  assert.equal(tombstone.case_id_hash, expectedHash);
  assert.equal(tombstone.policy_version, "deletion.v1");
  assert.notEqual(tombstone.case_id_hash, hero.id);

  const unexpired = await getCase(alice, retained.id);
  assert.equal(unexpired.response.status, 200);

  const secondSweep = await harness.scheduled();
  assert.equal(secondSweep.status, 200);
  assert.equal((await secondSweep.json()).outcome, "ok");
});

test("individual document deletion removes private bytes, inventory, and dependent evidence", async () => {
  const hero = await createCase(alice, "hero", { title: "Document deletion" });
  const targetDocumentId = hero.deductions[0]?.evidence.documentId;
  assert.ok(targetDocumentId);
  const targetDocument = hero.documents.find((item) => item.id === targetDocumentId);
  assert.ok(targetDocument);

  const dependentFacts = hero.facts.filter(
    (item) => item.evidence.documentId === targetDocumentId,
  );
  const dependentPeriods = hero.payPeriods.filter(
    (item) =>
      item.sourceDocumentId === targetDocumentId ||
      item.evidence.documentId === targetDocumentId,
  );
  const dependentDeductions = hero.deductions.filter(
    (item) =>
      item.sourceDocumentId === targetDocumentId ||
      item.evidence.documentId === targetDocumentId,
  );
  const dependentEvents = hero.events.filter((item) =>
    item.evidence.some((evidence) => evidence.documentId === targetDocumentId),
  );
  assert.ok(dependentFacts.length > 0);
  assert.ok(dependentPeriods.length > 0);
  assert.ok(dependentDeductions.length > 0);
  assert.ok(dependentEvents.length > 0);
  assert.ok(hero.findings.length > 0);

  const inventory = await harness.DB.prepare(
    "SELECT object_key FROM document_objects WHERE id = ? AND case_id = ?",
  )
    .bind(targetDocumentId, hero.id)
    .first();
  assert.ok(inventory?.object_key);
  assert.ok(await harness.BUCKET.get(inventory.object_key));

  const denied = await bob.request(
    `/api/v1/cases/${hero.id}/documents/${targetDocumentId}`,
    { method: "DELETE" },
  );
  await expectJsonError(denied, 404, "CASE_ACCESS_DENIED");
  assert.ok(await harness.BUCKET.get(inventory.object_key));

  const deleted = await alice.json(
    `/api/v1/cases/${hero.id}/documents/${targetDocumentId}`,
    { method: "DELETE" },
  );
  assert.equal(deleted.response.status, 200, JSON.stringify(deleted.payload));
  assert.deepEqual(deleted.payload.deletion, {
    status: "DELETED",
    document_id: targetDocumentId,
  });
  assert.ok(!deleted.payload.case.documents.some((item) => item.id === targetDocumentId));
  assert.ok(
    deleted.payload.case.facts.every(
      (item) => item.evidence.documentId !== targetDocumentId,
    ),
  );
  assert.ok(
    deleted.payload.case.payPeriods.every(
      (item) =>
        item.sourceDocumentId !== targetDocumentId &&
        item.evidence.documentId !== targetDocumentId,
    ),
  );
  assert.ok(
    deleted.payload.case.deductions.every(
      (item) =>
        item.sourceDocumentId !== targetDocumentId &&
        item.evidence.documentId !== targetDocumentId,
    ),
  );
  assert.ok(
    deleted.payload.case.events.every((item) =>
      item.evidence.every((evidence) => evidence.documentId !== targetDocumentId),
    ),
  );
  assert.equal(deleted.payload.case.findings.length, 0);
  assert.equal(deleted.payload.case.lastReport, undefined);

  const row = await harness.DB.prepare(
    "SELECT COUNT(*) AS count FROM document_objects WHERE id = ? AND case_id = ?",
  )
    .bind(targetDocumentId, hero.id)
    .first();
  assert.equal(Number(row.count), 0);
  assert.equal(await harness.BUCKET.get(inventory.object_key), null);
  await expectJsonError(
    await alice.request(`/api/v1/cases/${hero.id}/documents/${targetDocumentId}`),
    404,
    "CASE_ACCESS_DENIED",
  );

  const remaining = await getCase(alice, hero.id);
  assert.equal(remaining.response.status, 200);
  assert.equal(remaining.payload.case.documents.length, hero.documents.length - 1);
});

test("analysis requests reject cases whose material facts have not reached READY_FOR_ANALYSIS", async () => {
  const created = await createCase(alice, "custom", {
    title: "Incomplete analysis readiness",
  });
  const response = await alice.request(`/api/v1/cases/${created.id}/analyses`, {
    method: "POST",
    headers: { "idempotency-key": nextIdempotencyKey("analysis-not-ready") },
  });
  const error = await expectJsonError(response, 409, "FACT_REVIEW_REQUIRED");
  assert.match(error.details?.missing_documents ?? "", /LCA|offer|paystub/i);

  const persisted = await getCase(alice, created.id);
  assert.equal(persisted.response.status, 200);
  assert.equal(persisted.payload.case.state, "INTAKE_COMPLETE");
  assert.equal(persisted.payload.case.findings.length, 0);
});
