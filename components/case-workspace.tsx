"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  BadgeCheck,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  Download,
  ExternalLink,
  Eye,
  FileCheck2,
  FileClock,
  FileDown,
  FilePlus2,
  FileSearch,
  Files,
  FolderLock,
  History,
  Info,
  LayoutDashboard,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  MapPin,
  Pencil,
  ReceiptText,
  RefreshCw,
  Save,
  SearchCheck,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import { Brand } from "@/components/brand";
import { formatCents, formatPercent } from "@/lib/money";
import type {
  CasePayload,
  DeductionObservation,
  DocumentType,
  FactRecord,
  Finding,
  FindingModule,
  FindingStatus,
  PayPeriod,
} from "@/lib/types";

type TabId = "overview" | "documents" | "facts" | "timeline" | "findings" | "report" | "privacy";

const TABS: Array<{ id: TabId; label: string; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "documents", label: "Documents", icon: Files },
  { id: "facts", label: "Fact review", icon: ListChecks },
  { id: "timeline", label: "Timeline", icon: Clock3 },
  { id: "findings", label: "Findings", icon: SearchCheck },
  { id: "report", label: "Report", icon: FileDown },
  { id: "privacy", label: "Privacy", icon: LockKeyhole },
];

const MODULE_META: Record<
  FindingModule,
  { label: string; icon: typeof CircleDollarSign; number: string }
> = {
  WAGE_BENCHMARK: { label: "Documented wage benchmark", icon: CircleDollarSign, number: "01" },
  NONPRODUCTIVE_TIME: { label: "Nonproductive time", icon: FileClock, number: "02" },
  DEDUCTIONS_FEES: { label: "Deductions and fees", icon: ReceiptText, number: "03" },
  EMPLOYMENT_FACTS: { label: "Employment facts", icon: MapPin, number: "04" },
};

const STATUS_META: Record<FindingStatus, { label: string; short: string; className: string }> = {
  POSSIBLE_DISCREPANCY: {
    label: "Possible discrepancy",
    short: "Possible difference",
    className: "status-possible",
  },
  NO_MISMATCH_DETECTED: {
    label: "No mismatch detected",
    short: "No mismatch",
    className: "status-clear",
  },
  INSUFFICIENT_EVIDENCE: {
    label: "More evidence needed",
    short: "More evidence",
    className: "status-evidence",
  },
  CONFLICTING_EVIDENCE: {
    label: "Documents conflict",
    short: "Documents conflict",
    className: "status-conflict",
  },
  HUMAN_REVIEW_REQUIRED: {
    label: "Human review recommended",
    short: "Human review",
    className: "status-review",
  },
};

const DOCUMENT_LABELS: Record<DocumentType, string> = {
  LCA_CERTIFIED: "Certified LCA",
  OFFER_OR_EMPLOYMENT_LETTER: "Offer or employment letter",
  PAYSTUB: "Paystub",
  TIMESHEET: "Timesheet or calendar",
  WORK_MESSAGE: "Work message",
  LEAVE_NOTICE: "Leave notice",
  TERMINATION_NOTICE: "Termination notice",
  PETITION_SUPPORT_LETTER: "Petition support letter",
  OTHER: "Other supporting record",
};

const REQUIRED_DOCUMENTS: Array<{ type: DocumentType; note: string; minimum: number }> = [
  { type: "LCA_CERTIFIED", note: "Wage, occupation, worksite, and validity", minimum: 1 },
  { type: "OFFER_OR_EMPLOYMENT_LETTER", note: "Base wage, start date, role, and worksite", minimum: 1 },
  { type: "PAYSTUB", note: "Ordinary earnings, pay periods, and deductions", minimum: 2 },
];

const OPTIONAL_DOCUMENTS: Array<{ type: DocumentType; note: string }> = [
  { type: "TIMESHEET", note: "Hours, availability, and no-work intervals" },
  { type: "WORK_MESSAGE", note: "Project-delay or worksite instructions" },
  { type: "PETITION_SUPPORT_LETTER", note: "Detailed occupation or duty context" },
  { type: "LEAVE_NOTICE", note: "Voluntary leave or availability context" },
];

interface ApiErrorPayload {
  error?: {
    code?: string;
    message?: string;
    sign_in_url?: string;
    request_id?: string;
    retryable?: boolean;
    details?: Record<string, string>;
  };
}

function stateLabel(value: string): string {
  const labels: Record<string, string> = {
    DRAFT: "Setup needed",
    INTAKE_COMPLETE: "Ready for documents",
    UPLOADING: "Uploading documents",
    PROCESSING: "Processing documents",
    FACT_REVIEW_REQUIRED: "Fact review needed",
    READY_FOR_ANALYSIS: "Ready to analyze",
    ANALYZING: "Comparing evidence",
    RESULTS_READY: "Results ready",
    REPORTING: "Preparing report",
    REPORT_FAILED: "Report retry available",
    PROCESSING_FAILED: "Processing retry needed",
    ANALYSIS_FAILED: "Analysis retry needed",
    UPLOAD_FAILED: "Upload retry needed",
    DELETION_PENDING: "Deleting review",
    DELETION_FAILED: "Deletion retry needed",
    DELETED: "Deleted",
  };
  return labels[value] ?? value.replaceAll("_", " ").toLowerCase();
}

function friendlyDate(value: string): string {
  const date = new Date(`${value.length === 10 ? `${value}T12:00:00Z` : value}`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date);
}

function moduleLabel(module: FindingModule): string {
  return MODULE_META[module].label;
}

function apiFetch(input: string, init: RequestInit = {}) {
  return fetch(input, { credentials: "same-origin", ...init });
}

async function parseApi<T>(response: Response): Promise<T> {
  let payload = {} as T & ApiErrorPayload;
  try {
    payload = (await response.json()) as T & ApiErrorPayload;
  } catch {
    // A safe generic message is shown below when the response is not JSON.
  }
  if (response.status === 401) {
    const signInUrl = payload.error?.sign_in_url;
    if (signInUrl && typeof window !== "undefined") {
      window.location.assign(signInUrl);
    }
    throw new Error("Your sign-in expired. Redirecting you to sign in again…");
  }
  if (!response.ok) {
    const details = Object.entries(payload.error?.details ?? {})
      .filter(([, value]) => value && value !== "none" && value !== "0")
      .map(([key, value]) => `${key.replaceAll("_", " ")}: ${value}`)
      .join(" · ");
    const reference = payload.error?.request_id ? ` Reference: ${payload.error.request_id}.` : "";
    throw new Error(`${payload.error?.message ?? "The request could not be completed."}${details ? ` ${details}.` : ""}${reference}`);
  }
  return payload;
}

function writesLocked(caseData: CasePayload): boolean {
  return ["ANALYZING", "REPORTING", "DELETION_PENDING", "DELETED"].includes(caseData.state);
}

function localAnalysisReadiness(caseData: CasePayload): { ready: boolean; message: string } {
  if (caseData.mode === "SANDBOX") return { ready: true, message: "" };
  const missingDocuments = REQUIRED_DOCUMENTS.filter(({ type, minimum }) =>
    caseData.documents.filter(
      (document) => document.type === type && ["READY", "NEEDS_REVIEW"].includes(document.status),
    ).length < minimum,
  );
  const unreviewed =
    caseData.facts.filter((fact) => fact.reviewStatus === "NEEDS_REVIEW").length +
    caseData.payPeriods.filter((period) => period.reviewStatus === "NEEDS_REVIEW").length +
    caseData.deductions.filter((deduction) => deduction.reviewStatus === "NEEDS_REVIEW").length;
  const reviewedFactTypes = new Set(
    caseData.facts.filter((fact) => fact.reviewStatus !== "NEEDS_REVIEW").map((fact) => fact.type),
  );
  const missingWage =
    !reviewedFactTypes.has("LCA_WAGE_ANNUAL_CENTS") && !reviewedFactTypes.has("LCA_WAGE_ANNUAL");
  const missingFrequency = !reviewedFactTypes.has("PAY_FREQUENCY");
  const missingPeriod = !caseData.payPeriods.some((period) => period.reviewStatus !== "NEEDS_REVIEW");
  const blockers: string[] = [];
  if (missingDocuments.length) blockers.push(`${missingDocuments.length} required document group${missingDocuments.length === 1 ? "" : "s"}`);
  if (unreviewed) blockers.push(`${unreviewed} unreviewed proposal${unreviewed === 1 ? "" : "s"}`);
  if (missingWage) blockers.push("reviewed LCA wage");
  if (missingFrequency) blockers.push("reviewed pay frequency");
  if (missingPeriod) blockers.push("reviewed pay period");
  return {
    ready: !blockers.length,
    message: blockers.length ? `Complete: ${blockers.join(", ")}.` : "",
  };
}

export function CaseWorkspace({ caseId }: { caseId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const analysisKey = useRef("");
  const [caseData, setCaseData] = useState<CasePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState("");
  const [tab, setTabState] = useState<TabId>(() => {
    const queryTab = searchParams.get("tab") as TabId | null;
    return queryTab && TABS.some((candidate) => candidate.id === queryTab) ? queryTab : "overview";
  });
  const [renderedAt] = useState(() => Date.now());
  const [selectedFactId, setSelectedFactId] = useState("");
  const [findingFilter, setFindingFilter] = useState<"ALL" | FindingStatus>("ALL");

  useEffect(() => {
    let active = true;
    apiFetch(`/api/v1/cases/${caseId}`, { cache: "no-store" })
      .then((response) => parseApi<{ case: CasePayload }>(response))
      .then((payload) => {
        if (!active) return;
        setCaseData(payload.case);
        setSelectedFactId(payload.case.facts[0]?.id ?? "");
      })
      .catch((caught) => active && setError(caught instanceof Error ? caught.message : "Unable to open case"))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [caseId]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function setTab(nextTab: TabId) {
    setTabState(nextTab);
    window.history.replaceState(null, "", `${window.location.pathname}?tab=${nextTab}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function handleTabKey(event: KeyboardEvent<HTMLButtonElement>, current: TabId) {
    const currentIndex = TABS.findIndex((item) => item.id === current);
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = (currentIndex + 1) % TABS.length;
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + TABS.length) % TABS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = TABS[nextIndex].id;
    setTab(nextTab);
    window.requestAnimationFrame(() => document.getElementById(`case-tab-${nextTab}`)?.focus());
  }

  async function analyze() {
    if (!caseData) return;
    const readiness = localAnalysisReadiness(caseData);
    if (!readiness.ready) {
      setError(`This review is not ready for comparison. ${readiness.message}`);
      setTab("facts");
      return;
    }
    if (writesLocked(caseData)) {
      setError("Wait for the current case operation to finish before starting another comparison.");
      return;
    }
    setBusy("analysis");
    setError("");
    try {
      analysisKey.current ||= crypto.randomUUID();
      const response = await apiFetch(`/api/v1/cases/${caseData.id}/analyses`, {
        method: "POST",
        headers: { "Idempotency-Key": analysisKey.current },
      });
      const payload = await parseApi<{ case: CasePayload }>(response);
      analysisKey.current = "";
      setCaseData(payload.case);
      setToast("Evidence comparison completed from the current reviewed facts.");
      setTab("findings");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Analysis could not complete");
    } finally {
      setBusy("");
    }
  }

  async function patchFinding(
    findingId: string,
    patch: { include_in_report?: boolean; disposition?: Finding["disposition"] },
  ) {
    if (!caseData) return;
    setBusy(`finding-${findingId}`);
    try {
      const response = await apiFetch(`/api/v1/cases/${caseData.id}/findings/${encodeURIComponent(findingId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const payload = await parseApi<{ case: CasePayload }>(response);
      setCaseData(payload.case);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Finding could not be updated");
    } finally {
      setBusy("");
    }
  }

  if (loading) {
    return (
      <div className="workspace-loading" role="status">
        <div className="workspace-loading-mark"><ShieldCheck size={25} /></div>
        <LoaderCircle className="spin" size={20} />
        <strong>Opening private evidence workspace</strong>
        <span>Loading the case snapshot and reviewed sources…</span>
      </div>
    );
  }

  if (!caseData || error && !caseData) {
    return (
      <main className="workspace-error">
        <AlertCircle size={27} />
        <h1>This review is unavailable</h1>
        <p>{error || "It may have expired, been deleted, or belong to another signed-in account."}</p>
        <Link href="/cases" className="button button-primary"><ArrowLeft size={16} /> Return to my reviews</Link>
      </main>
    );
  }

  const expiryHours = Math.max(
    0,
    Math.ceil((new Date(caseData.retentionExpiresAt).getTime() - renderedAt) / 3_600_000),
  );
  const requiredReady = REQUIRED_DOCUMENTS.filter(
    (requirement) =>
      caseData.documents.filter((document) => document.type === requirement.type && document.status === "READY").length >=
      requirement.minimum,
  ).length;
  const possibleCount = caseData.findings.filter((finding) => finding.status === "POSSIBLE_DISCREPANCY").length;
  const reviewCount = caseData.findings.filter((finding) => finding.status === "HUMAN_REVIEW_REQUIRED").length;
  const currentTab = TABS.find((item) => item.id === tab) ?? TABS[0];
  const CurrentTabIcon = currentTab.icon;
  const analysisReadiness = localAnalysisReadiness(caseData);
  const locked = writesLocked(caseData);

  return (
    <main className="workspace-shell" id="main-content" tabIndex={-1}>
      <header className="workspace-topbar">
        <div className="workspace-topbar-left">
          <Brand compact />
          <span className="topbar-divider" />
          <Link href="/cases" className="topbar-back"><ArrowLeft size={14} /> My reviews</Link>
        </div>
        <div className="workspace-topbar-right">
          <span className={`workspace-mode-badge ${caseData.mode === "SANDBOX" ? "sandbox" : "standard"}`}>
            {caseData.mode === "SANDBOX" ? <BadgeCheck size={13} /> : <FolderLock size={13} />}
            {caseData.mode === "SANDBOX" ? "Fictional sandbox" : "Private account review"}
          </span>
          <Link href="/methodology">Methodology</Link>
        </div>
      </header>

      <section className="workspace-casebar">
        <div>
          <div className="workspace-case-kicker">
            <span className={`case-state state-${caseData.state.toLowerCase()}`}>{stateLabel(caseData.state)}</span>
            <span>Snapshot v{caseData.stateVersion}</span>
          </div>
          <h1>{caseData.title}</h1>
          <p>{caseData.employerName || "Employer not entered"} · {caseData.position || "Position not entered"} · {friendlyDate(caseData.reviewStart)} – {friendlyDate(caseData.reviewEnd)}</p>
        </div>
        <div className="retention-pill"><Clock3 size={14} /><span><small>Auto-delete</small>{expiryHours}h remaining</span></div>
      </section>

      <div className="workspace-layout">
        <aside className="workspace-sidebar">
          <div className="workspace-tabs" role="tablist" aria-label="Case sections" aria-orientation="vertical">
            {TABS.map((item) => {
              const Icon = item.icon;
              const count =
                item.id === "documents"
                  ? caseData.documents.length
                  : item.id === "facts"
                    ? caseData.facts.filter((fact) => fact.reviewStatus === "NEEDS_REVIEW").length +
                      caseData.payPeriods.filter((period) => period.reviewStatus === "NEEDS_REVIEW").length +
                      caseData.deductions.filter((deduction) => deduction.reviewStatus === "NEEDS_REVIEW").length
                    : item.id === "findings"
                      ? caseData.findings.length
                      : item.id === "report"
                        ? caseData.findings.filter((finding) => finding.includeInReport).length
                        : undefined;
              return (
                <button
                  key={item.id}
                  type="button"
                  id={`case-tab-${item.id}`}
                  role="tab"
                  className={tab === item.id ? "active" : ""}
                  onClick={() => setTab(item.id)}
                  onKeyDown={(event) => handleTabKey(event, item.id)}
                  aria-selected={tab === item.id}
                  aria-controls={`case-panel-${item.id}`}
                  tabIndex={tab === item.id ? 0 : -1}
                >
                  <Icon size={16} /><span>{item.label}</span>{count !== undefined && <small>{count}</small>}
                </button>
              );
            })}
          </div>
          <div className="sidebar-safety">
            <FolderLock size={16} />
            <strong>Private by default</strong>
            <p>This review is scoped to your signed-in account. No employer or agency is contacted by WageShield.</p>
          </div>
        </aside>

        <section className="workspace-main">
          <div className="workspace-mobile-title">
            <CurrentTabIcon size={17} /> {currentTab.label}
          </div>
          {error && (
            <div className="inline-error" role="alert"><AlertCircle size={16} /><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss"><X size={14} /></button></div>
          )}

          <div
            id={`case-panel-${tab}`}
            role="tabpanel"
            aria-labelledby={`case-tab-${tab}`}
            tabIndex={0}
            className="workspace-tab-panel"
          >
          {tab === "overview" && (
            <OverviewTab
              caseData={caseData}
              requiredReady={requiredReady}
              possibleCount={possibleCount}
              reviewCount={reviewCount}
              analyze={analyze}
              busy={busy === "analysis"}
              setTab={setTab}
              analysisReady={analysisReadiness.ready}
              analysisMessage={analysisReadiness.message}
              writesAreLocked={locked}
            />
          )}
          {tab === "documents" && (
            <DocumentsTab caseData={caseData} setCaseData={setCaseData} setError={setError} setToast={setToast} writesAreLocked={locked} />
          )}
          {tab === "facts" && (
            <FactsTab
              caseData={caseData}
              setCaseData={setCaseData}
              selectedFactId={selectedFactId}
              setSelectedFactId={setSelectedFactId}
              setError={setError}
              setToast={setToast}
              writesAreLocked={locked}
            />
          )}
          {tab === "timeline" && <TimelineTab caseData={caseData} />}
          {tab === "findings" && (
            <FindingsTab
              caseData={caseData}
              filter={findingFilter}
              setFilter={setFindingFilter}
              patchFinding={patchFinding}
              analyze={analyze}
              busy={busy}
              analysisReady={analysisReadiness.ready}
              analysisMessage={analysisReadiness.message}
              writesAreLocked={locked}
            />
          )}
          {tab === "report" && (
            <ReportTab caseData={caseData} setCaseData={setCaseData} patchFinding={patchFinding} setError={setError} setToast={setToast} busy={busy} writesAreLocked={locked} />
          )}
          {tab === "privacy" && (
            <PrivacyTab caseData={caseData} setCaseData={setCaseData} router={router} setError={setError} setToast={setToast} writesAreLocked={locked} />
          )}
          </div>
        </section>
      </div>

      {toast && <div className="toast" role="status"><CheckCircle2 size={16} /> {toast}</div>}
    </main>
  );
}

function SectionTitle({ eyebrow, title, text, action }: { eyebrow: string; title: string; text: string; action?: React.ReactNode }) {
  return (
    <div className="workspace-section-title">
      <div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2><p>{text}</p></div>
      {action}
    </div>
  );
}

function OverviewTab({
  caseData,
  requiredReady,
  possibleCount,
  reviewCount,
  analyze,
  busy,
  setTab,
  analysisReady,
  analysisMessage,
  writesAreLocked,
}: {
  caseData: CasePayload;
  requiredReady: number;
  possibleCount: number;
  reviewCount: number;
  analyze: () => void;
  busy: boolean;
  setTab: (tab: TabId) => void;
  analysisReady: boolean;
  analysisMessage: string;
  writesAreLocked: boolean;
}) {
  const reviewedFacts = caseData.facts.filter((fact) => fact.reviewStatus !== "NEEDS_REVIEW").length;
  const analyzeDisabled = busy || writesAreLocked || !analysisReady;
  return (
    <>
      <SectionTitle
        eyebrow="Case snapshot"
        title="A traceable view of the current record"
        text="Nothing here is a legal conclusion. Each number and status can be opened back to the reviewed evidence."
        action={
          <button
            type="button"
            className="button button-primary"
            onClick={analyze}
            disabled={analyzeDisabled}
            title={!analysisReady && !writesAreLocked ? analysisMessage : undefined}
          >
            {busy ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
            {caseData.findings.length ? "Rerun comparisons" : "Run comparisons"}
          </button>
        }
      />
      {!analysisReady && analysisMessage && (
        <div className="readiness-note" role="status">
          <Info size={15} aria-hidden="true" />
          <span>{analysisMessage} <button type="button" className="text-link" onClick={() => setTab("facts")}>Go to fact review</button></span>
        </div>
      )}
      <div className="overview-metrics">
        <article><span><Files size={18} /></span><strong>{requiredReady}/3</strong><small>required document groups ready</small></article>
        <article><span><ListChecks size={18} /></span><strong>{reviewedFacts}/{caseData.facts.length || 0}</strong><small>material facts reviewed</small></article>
        <article><span><SearchCheck size={18} /></span><strong>{possibleCount}</strong><small>possible documentary differences</small></article>
        <article><span><Eye size={18} /></span><strong>{reviewCount}</strong><small>items for human review</small></article>
      </div>

      <div className="overview-grid">
        <section className="panel-card">
          <div className="panel-card-head"><h3>Review path</h3><span>Current snapshot</span></div>
          <div className="progress-steps">
            <button type="button" onClick={() => setTab("documents")} className={caseData.documents.length ? "complete" : "current"}><span>{caseData.documents.length ? <Check size={14} /> : "1"}</span><div><strong>Documents</strong><small>{caseData.documents.length} validated records</small></div></button>
            <button type="button" onClick={() => setTab("facts")} className={caseData.facts.length && reviewedFacts === caseData.facts.length ? "complete" : "current"}><span>{caseData.facts.length && reviewedFacts === caseData.facts.length ? <Check size={14} /> : "2"}</span><div><strong>Fact review</strong><small>{reviewedFacts} reviewed values</small></div></button>
            <button type="button" onClick={() => setTab("findings")} className={caseData.findings.length ? "complete" : "current"}><span>{caseData.findings.length ? <Check size={14} /> : "3"}</span><div><strong>Evidence comparison</strong><small>{caseData.findings.length ? "Four modules complete" : "Ready when facts are reviewed"}</small></div></button>
            <button type="button" onClick={() => setTab("report")} className={caseData.lastReport ? "complete" : "current"}><span>{caseData.lastReport ? <Check size={14} /> : "4"}</span><div><strong>Report</strong><small>{caseData.lastReport ? "Download available" : "Nothing leaves until selected"}</small></div></button>
          </div>
        </section>

        <section className="panel-card">
          <div className="panel-card-head"><h3>Case details</h3><span>Version {caseData.stateVersion}</span></div>
          <dl className="detail-list">
            <div><dt>Worker</dt><dd>{caseData.workerName || "Not entered"}</dd></div>
            <div><dt>Employer</dt><dd>{caseData.employerName || "Not entered"}</dd></div>
            <div><dt>Position</dt><dd>{caseData.position || "Not entered"}</dd></div>
            <div><dt>Review period</dt><dd>{caseData.reviewStart} – {caseData.reviewEnd}</dd></div>
            <div><dt>Rule set</dt><dd>{caseData.ruleSetVersion}</dd></div>
            <div><dt>Source corpus</dt><dd>{caseData.sourceCorpusVersion}</dd></div>
          </dl>
        </section>
      </div>

      <div className="safety-note"><Info size={17} /><div><strong>What WageShield cannot see</strong><p>Employer-side actual-wage records, later corrections, leave approvals, additional LCAs, and other context may not be in this case. Those limits remain visible in every result.</p></div></div>
    </>
  );
}

function DocumentsTab({
  caseData,
  setCaseData,
  setError,
  setToast,
  writesAreLocked,
}: {
  caseData: CasePayload;
  setCaseData: (value: CasePayload) => void;
  setError: (value: string) => void;
  setToast: (value: string) => void;
  writesAreLocked: boolean;
}) {
  const [type, setType] = useState<DocumentType>("LCA_CERTIFIED");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (writesAreLocked) {
      setError("Wait for the current case operation to finish before uploading.");
      return;
    }
    if (!file) {
      setError("Choose a synthetic PDF, PNG, or JPEG to upload.");
      return;
    }
    setUploading(true);
    setError("");
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("document_type", type);
      form.set("is_synthetic", "true");
      const response = await apiFetch(`/api/v1/cases/${caseData.id}/uploads`, { method: "POST", body: form });
      const payload = await parseApi<{ case: CasePayload }>(response);
      setCaseData(payload.case);
      setFile(null);
      setToast("Document validated and stored in this private case.");
      const input = document.getElementById("document-file") as HTMLInputElement | null;
      if (input) input.value = "";
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Document could not be uploaded");
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      <SectionTitle eyebrow="Document checklist" title="Build the evidence set deliberately" text="Required records enable the full workflow. Optional records add context that can prevent an unnecessary flag." />
      <div className="document-checklist">
        <section>
          <div className="subsection-label">Required for all four checks</div>
          {REQUIRED_DOCUMENTS.map((requirement) => {
            const count = caseData.documents.filter((document) => document.type === requirement.type && document.status === "READY").length;
            const complete = count >= requirement.minimum;
            return (
              <div className="document-requirement" key={requirement.type}>
                <span className={complete ? "ready" : "missing"}>{complete ? <Check size={14} /> : <FilePlus2 size={14} />}</span>
                <div><strong>{DOCUMENT_LABELS[requirement.type]}</strong><small>{requirement.note}</small></div>
                <em>{count}/{requirement.minimum}</em>
              </div>
            );
          })}
        </section>
        <section>
          <div className="subsection-label">Optional context</div>
          {OPTIONAL_DOCUMENTS.map((requirement) => {
            const count = caseData.documents.filter((document) => document.type === requirement.type).length;
            return (
              <div className="document-requirement" key={requirement.type}>
                <span className={count ? "ready" : "optional"}>{count ? <Check size={14} /> : <FilePlus2 size={14} />}</span>
                <div><strong>{DOCUMENT_LABELS[requirement.type]}</strong><small>{requirement.note}</small></div>
                <em>{count || "Optional"}</em>
              </div>
            );
          })}
        </section>
      </div>

      <form className="upload-panel" onSubmit={upload}>
        <div className="upload-icon"><UploadCloud size={23} /></div>
        <div className="upload-copy"><strong>Add a fictional test document</strong><p>PDF, PNG, or JPEG · 12 MB maximum · encrypted or active PDFs are rejected</p></div>
        <label className="upload-type"><span className="sr-only">Document type</span><select value={type} onChange={(event) => setType(event.target.value as DocumentType)}>{Object.entries(DOCUMENT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="file-picker"><input id="document-file" type="file" accept="application/pdf,image/png,image/jpeg" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><span>{file ? file.name : "Choose file"}</span></label>
        <button className="button button-primary" type="submit" disabled={uploading || writesAreLocked}>{uploading ? <LoaderCircle className="spin" size={15} /> : <UploadCloud size={15} />}{uploading ? "Validating…" : "Upload"}</button>
        <small className="upload-notice"><ShieldCheck size={12} /> Hosted demo accepts synthetic records only. File contents never enter standard application logs.</small>
      </form>

      <section className="document-inventory">
        <div className="panel-card-head"><h3>Case inventory</h3><span>{caseData.documents.length} documents</span></div>
        {caseData.documents.length ? (
          <div className="document-table">
            {caseData.documents.map((document) => (
              <div className="document-row" key={document.id}>
                <span className="document-file-icon"><FileCheck2 size={18} /></span>
                <div className="document-name"><strong>{document.name}</strong><small>{DOCUMENT_LABELS[document.type]} · {document.pages} page{document.pages === 1 ? "" : "s"}</small></div>
                <span className="document-hash">SHA-256 {document.hash.slice(0, 10)}…</span>
                <span className="document-ready"><CheckCircle2 size={13} /> Ready</span>
                <a className="icon-button" href={`/api/v1/cases/${caseData.id}/documents/${document.id}`} target="_blank" rel="noreferrer" aria-label={`Open ${document.name}`}><Eye size={15} /></a>
              </div>
            ))}
          </div>
        ) : <div className="compact-empty"><Files size={20} /><p>No documents yet. Add the LCA first.</p></div>}
      </section>
    </>
  );
}

const DEDUCTION_CATEGORY_OPTIONS: Array<[DeductionObservation["category"], string]> = [
  ["PETITION_OR_LEGAL_FEE_REFERENCE", "Petition or legal fee"],
  ["EMPLOYER_BUSINESS_EXPENSE_REFERENCE", "Employer business expense"],
  ["EARLY_DEPARTURE_REFERENCE", "Early-departure charge"],
  ["TRAINING_OR_RELOCATION_REFERENCE", "Training or relocation"],
  ["ORDINARY_TAX_OR_BENEFIT_DEDUCTION", "Ordinary tax or benefit"],
  ["UNKNOWN", "Unknown or unclear"],
];

const TRANSACTION_STATUS_OPTIONS: Array<[DeductionObservation["transactionStatus"], string]> = [
  ["PAYROLL_OBSERVED", "Observed in payroll"],
  ["DIRECT_REQUEST", "Direct payment request"],
  ["CLAUSE_ONLY", "Contract clause only"],
];

function dollarsToCentsInput(value: string): number | null {
  const normalized = value.trim().replace(/[$,\s]/g, "");
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

function FactProposalCard({
  fact,
  disabled,
  onConfirm,
  onCorrect,
  onReject,
}: {
  fact: FactRecord;
  disabled: boolean;
  onConfirm: () => void;
  onCorrect: (rawValue: string, normalizedValue: string) => void;
  onReject: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState(fact.rawValue);
  const [normalized, setNormalized] = useState(fact.normalizedValue);
  return (
    <article className="proposal-card">
      <div className="proposal-card-head">
        <div><span className="proposal-kind">Fact</span><strong>{fact.label}</strong></div>
        <em>{Math.round(fact.confidence * 100)}%</em>
      </div>
      <p className="proposal-value">{fact.rawValue || "No value extracted"}</p>
      <blockquote className="proposal-evidence">“{fact.evidence.text}”<cite>{fact.evidence.documentName} · page {fact.evidence.page}</cite></blockquote>
      {editing ? (
        <div className="proposal-edit">
          <label className="field-label">Displayed value<input value={raw} onChange={(event) => setRaw(event.target.value)} /></label>
          <label className="field-label">Normalized rule input<input value={normalized} onChange={(event) => setNormalized(event.target.value)} /></label>
          <div className="proposal-actions">
            <button type="button" className="button button-primary button-small" disabled={disabled} onClick={() => onCorrect(raw, normalized)}><Save size={13} /> Save</button>
            <button type="button" className="button button-ghost button-small" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="proposal-actions">
          <button type="button" className="button button-primary button-small" disabled={disabled} onClick={onConfirm}><Check size={13} /> Confirm</button>
          <button type="button" className="button button-secondary button-small" disabled={disabled} onClick={() => { setRaw(fact.rawValue); setNormalized(fact.normalizedValue); setEditing(true); }}><Pencil size={13} /> Correct</button>
          <button type="button" className="button button-ghost button-small" disabled={disabled} onClick={onReject}><X size={13} /> Reject</button>
        </div>
      )}
    </article>
  );
}

function PayPeriodProposalCard({
  period,
  disabled,
  onConfirm,
  onCorrect,
  onReject,
}: {
  period: PayPeriod;
  disabled: boolean;
  onConfirm: () => void;
  onCorrect: (patch: {
    start: string;
    end: string;
    pay_date: string;
    ordinary_base_cents: number;
    gross_cents: number;
    complete: boolean;
    comparable: boolean;
  }) => void;
  onReject: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState(period.start);
  const [end, setEnd] = useState(period.end);
  const [payDate, setPayDate] = useState(period.payDate);
  const [base, setBase] = useState(centsToInput(period.ordinaryBaseCents));
  const [gross, setGross] = useState(centsToInput(period.grossCents));
  const [complete, setComplete] = useState(period.complete);
  const [comparable, setComparable] = useState(period.comparable);
  const [localError, setLocalError] = useState("");

  function submit() {
    const baseCents = dollarsToCentsInput(base);
    const grossCents = dollarsToCentsInput(gross);
    if (baseCents === null || grossCents === null) {
      setLocalError("Enter ordinary base and gross as dollar amounts.");
      return;
    }
    if (!start || !end || !payDate) {
      setLocalError("Enter the period start, end, and pay date.");
      return;
    }
    if (start > end) {
      setLocalError("The start date must be on or before the end date.");
      return;
    }
    setLocalError("");
    onCorrect({ start, end, pay_date: payDate, ordinary_base_cents: baseCents, gross_cents: grossCents, complete, comparable });
  }

  return (
    <article className="proposal-card">
      <div className="proposal-card-head">
        <div><span className="proposal-kind">Pay period</span><strong>{friendlyDate(period.start)} – {friendlyDate(period.end)}</strong></div>
        <em>{formatCents(period.ordinaryBaseCents)}</em>
      </div>
      <p className="proposal-value">Ordinary base {formatCents(period.ordinaryBaseCents)} · paid {friendlyDate(period.payDate)}</p>
      <blockquote className="proposal-evidence">“{period.evidence.text}”<cite>{period.evidence.documentName} · page {period.evidence.page}</cite></blockquote>
      {editing ? (
        <div className="proposal-edit">
          <div className="proposal-edit-grid">
            <label className="field-label">Start<input type="date" value={start} onChange={(event) => setStart(event.target.value)} /></label>
            <label className="field-label">End<input type="date" value={end} onChange={(event) => setEnd(event.target.value)} /></label>
            <label className="field-label">Pay date<input type="date" value={payDate} onChange={(event) => setPayDate(event.target.value)} /></label>
            <label className="field-label">Ordinary base ($)<input inputMode="decimal" value={base} onChange={(event) => setBase(event.target.value)} /></label>
            <label className="field-label">Gross ($)<input inputMode="decimal" value={gross} onChange={(event) => setGross(event.target.value)} /></label>
          </div>
          <div className="proposal-checks">
            <label className="check-row"><input type="checkbox" checked={complete} onChange={(event) => setComplete(event.target.checked)} /><span>Complete ordinary period</span></label>
            <label className="check-row"><input type="checkbox" checked={comparable} onChange={(event) => setComparable(event.target.checked)} /><span>Comparable for the wage benchmark</span></label>
          </div>
          {localError && <small className="field-error">{localError}</small>}
          <div className="proposal-actions">
            <button type="button" className="button button-primary button-small" disabled={disabled} onClick={submit}><Save size={13} /> Save</button>
            <button type="button" className="button button-ghost button-small" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="proposal-actions">
          <button type="button" className="button button-primary button-small" disabled={disabled} onClick={onConfirm}><Check size={13} /> Confirm</button>
          <button type="button" className="button button-secondary button-small" disabled={disabled} onClick={() => setEditing(true)}><Pencil size={13} /> Correct</button>
          <button type="button" className="button button-ghost button-small" disabled={disabled} onClick={onReject}><X size={13} /> Reject</button>
        </div>
      )}
    </article>
  );
}

function DeductionProposalCard({
  deduction,
  disabled,
  onConfirm,
  onCorrect,
  onReject,
}: {
  deduction: DeductionObservation;
  disabled: boolean;
  onConfirm: () => void;
  onCorrect: (patch: {
    description: string;
    amount_cents: number;
    date: string;
    category: DeductionObservation["category"];
    transaction_status: DeductionObservation["transactionStatus"];
  }) => void;
  onReject: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(deduction.description);
  const [amount, setAmount] = useState(centsToInput(deduction.amountCents));
  const [date, setDate] = useState(deduction.date);
  const [category, setCategory] = useState<DeductionObservation["category"]>(deduction.category);
  const [transactionStatus, setTransactionStatus] = useState<DeductionObservation["transactionStatus"]>(deduction.transactionStatus);
  const [localError, setLocalError] = useState("");

  function submit() {
    const amountCents = dollarsToCentsInput(amount);
    if (amountCents === null) {
      setLocalError("Enter the deduction amount as a dollar value.");
      return;
    }
    if (!description.trim() || !date) {
      setLocalError("Enter a description and a date.");
      return;
    }
    setLocalError("");
    onCorrect({ description: description.trim(), amount_cents: amountCents, date, category, transaction_status: transactionStatus });
  }

  return (
    <article className="proposal-card">
      <div className="proposal-card-head">
        <div><span className="proposal-kind">Deduction</span><strong>{deduction.description || "Deduction line"}</strong></div>
        <em>{formatCents(deduction.amountCents)}</em>
      </div>
      <p className="proposal-value">{formatCents(deduction.amountCents)} · {deduction.date || "no date"}</p>
      <blockquote className="proposal-evidence">“{deduction.evidence.text}”<cite>{deduction.evidence.documentName} · page {deduction.evidence.page}</cite></blockquote>
      {editing ? (
        <div className="proposal-edit">
          <div className="proposal-edit-grid">
            <label className="field-label proposal-edit-wide">Description<input value={description} onChange={(event) => setDescription(event.target.value)} /></label>
            <label className="field-label">Amount ($)<input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
            <label className="field-label">Date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
            <label className="field-label">Category<select value={category} onChange={(event) => setCategory(event.target.value as DeductionObservation["category"])}>{DEDUCTION_CATEGORY_OPTIONS.map(([value, labelText]) => <option key={value} value={value}>{labelText}</option>)}</select></label>
            <label className="field-label">Transaction<select value={transactionStatus} onChange={(event) => setTransactionStatus(event.target.value as DeductionObservation["transactionStatus"])}>{TRANSACTION_STATUS_OPTIONS.map(([value, labelText]) => <option key={value} value={value}>{labelText}</option>)}</select></label>
          </div>
          {localError && <small className="field-error">{localError}</small>}
          <div className="proposal-actions">
            <button type="button" className="button button-primary button-small" disabled={disabled} onClick={submit}><Save size={13} /> Save</button>
            <button type="button" className="button button-ghost button-small" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="proposal-actions">
          <button type="button" className="button button-primary button-small" disabled={disabled} onClick={onConfirm}><Check size={13} /> Confirm</button>
          <button type="button" className="button button-secondary button-small" disabled={disabled} onClick={() => setEditing(true)}><Pencil size={13} /> Correct</button>
          <button type="button" className="button button-ghost button-small" disabled={disabled} onClick={onReject}><X size={13} /> Reject</button>
        </div>
      )}
    </article>
  );
}

function FactsTab({
  caseData,
  setCaseData,
  selectedFactId,
  setSelectedFactId,
  setError,
  setToast,
  writesAreLocked,
}: {
  caseData: CasePayload;
  setCaseData: (value: CasePayload) => void;
  selectedFactId: string;
  setSelectedFactId: (value: string) => void;
  setError: (value: string) => void;
  setToast: (value: string) => void;
  writesAreLocked: boolean;
}) {
  const [editing, setEditing] = useState("");
  const [rawValue, setRawValue] = useState("");
  const [normalizedValue, setNormalizedValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [pendingBusy, setPendingBusy] = useState("");
  const selected = caseData.facts.find((fact) => fact.id === selectedFactId) ?? caseData.facts[0];

  const pendingFacts = caseData.facts.filter((fact) => fact.reviewStatus === "NEEDS_REVIEW");
  const pendingPeriods = caseData.payPeriods.filter((period) => period.reviewStatus === "NEEDS_REVIEW");
  const pendingDeductions = caseData.deductions.filter((deduction) => deduction.reviewStatus === "NEEDS_REVIEW");
  const pendingCount = pendingFacts.length + pendingPeriods.length + pendingDeductions.length;

  async function review(url: string, body: Record<string, unknown>, id: string) {
    if (writesAreLocked) {
      setError("Wait for the current case operation to finish before reviewing proposals.");
      return;
    }
    setPendingBusy(id);
    setError("");
    try {
      const response = await apiFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await parseApi<{ case: CasePayload }>(response);
      setCaseData(payload.case);
      setToast("Proposal reviewed. Rerun comparisons once every item is resolved.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The proposal could not be reviewed.");
    } finally {
      setPendingBusy("");
    }
  }

  const factUrl = (id: string) => `/api/v1/cases/${caseData.id}/facts/${id}/corrections`;
  const periodUrl = (id: string) => `/api/v1/cases/${caseData.id}/pay-periods/${id}/corrections`;
  const deductionUrl = (id: string) => `/api/v1/cases/${caseData.id}/deductions/${id}/corrections`;

  function edit(fact: FactRecord) {
    setEditing(fact.id);
    setRawValue(fact.rawValue);
    setNormalizedValue(fact.normalizedValue);
  }

  async function saveCorrection(fact: FactRecord) {
    if (writesAreLocked) {
      setError("Wait for the current case operation to finish before saving corrections.");
      return;
    }
    setSaving(true);
    try {
      const response = await apiFetch(`/api/v1/cases/${caseData.id}/facts/${fact.id}/corrections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "correct", raw_value: rawValue, normalized_value: normalizedValue }),
      });
      const payload = await parseApi<{ case: CasePayload }>(response);
      setCaseData(payload.case);
      setEditing("");
      setToast("Correction saved. Existing results were marked stale; rerun comparisons when ready.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Correction could not be saved");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <SectionTitle eyebrow="Fact review" title="Confirm the values that drive each comparison" text="Corrections preserve the extracted value, create a new reviewed version, and invalidate dependent findings until analysis reruns." />
      {caseData.scenario === "custom" && (
        <ManualFactsForm caseData={caseData} setCaseData={setCaseData} setError={setError} setToast={setToast} writesAreLocked={writesAreLocked} />
      )}
      {pendingCount > 0 && (
        <section className="proposals-panel" aria-label="Proposals awaiting review">
          <div className="proposals-head">
            <span className="eyebrow"><AlertCircle size={14} aria-hidden="true" /> Proposals awaiting review</span>
            <h3>{pendingCount} item{pendingCount === 1 ? "" : "s"} need your confirmation</h3>
            <p>Comparisons stay locked until every extracted proposal is confirmed, corrected, or rejected.</p>
          </div>
          <div className="proposals-grid">
            {pendingFacts.map((fact) => (
              <FactProposalCard
                key={fact.id}
                fact={fact}
                disabled={writesAreLocked || pendingBusy === fact.id}
                onConfirm={() => review(factUrl(fact.id), { action: "confirm" }, fact.id)}
                onCorrect={(raw, normalized) => review(factUrl(fact.id), { action: "correct", raw_value: raw, normalized_value: normalized }, fact.id)}
                onReject={() => review(factUrl(fact.id), { action: "reject" }, fact.id)}
              />
            ))}
            {pendingPeriods.map((period) => (
              <PayPeriodProposalCard
                key={period.id}
                period={period}
                disabled={writesAreLocked || pendingBusy === period.id}
                onConfirm={() => review(periodUrl(period.id), { action: "confirm" }, period.id)}
                onCorrect={(patch) => review(periodUrl(period.id), { action: "correct", ...patch }, period.id)}
                onReject={() => review(periodUrl(period.id), { action: "reject" }, period.id)}
              />
            ))}
            {pendingDeductions.map((deduction) => (
              <DeductionProposalCard
                key={deduction.id}
                deduction={deduction}
                disabled={writesAreLocked || pendingBusy === deduction.id}
                onConfirm={() => review(deductionUrl(deduction.id), { action: "confirm" }, deduction.id)}
                onCorrect={(patch) => review(deductionUrl(deduction.id), { action: "correct", ...patch }, deduction.id)}
                onReject={() => review(deductionUrl(deduction.id), { action: "reject" }, deduction.id)}
              />
            ))}
          </div>
        </section>
      )}
      {caseData.facts.length ? (
        <div className="fact-review-layout">
          <div className="fact-list" role="list">
            {caseData.facts.map((fact) => (
              <button key={fact.id} type="button" className={selected?.id === fact.id ? "active" : ""} onClick={() => setSelectedFactId(fact.id)}>
                <span className={`fact-state ${fact.reviewStatus === "NEEDS_REVIEW" ? "needs" : "accepted"}`}>{fact.reviewStatus === "NEEDS_REVIEW" ? <AlertCircle size={13} /> : <Check size={13} />}</span>
                <span><strong>{fact.label}</strong><small>{fact.rawValue || "Value not entered"}</small></span>
                <em>{Math.round(fact.confidence * 100)}%</em>
              </button>
            ))}
          </div>
          {selected && (
            <div className="evidence-viewer">
              <div className="evidence-document-bar"><FileSearch size={15} /><span>{selected.evidence.documentName}</span><small>Page {selected.evidence.page}</small></div>
              <div className="document-page-mock">
                <div className="document-watermark">FICTIONAL SYNTHETIC DATA</div>
                <span className="doc-line short" /><span className="doc-line" /><span className="doc-line medium" />
                <div className="evidence-highlight"><small>{selected.evidence.label}</small><strong>{selected.evidence.text}</strong></div>
                <span className="doc-line" /><span className="doc-line medium" /><span className="doc-line short" />
              </div>
              <div className="fact-detail-panel">
                <div className="fact-detail-head"><div><span className="eyebrow">Normalized fact</span><h3>{selected.label}</h3></div><button type="button" className="button button-secondary button-small" onClick={() => edit(selected)} disabled={writesAreLocked}><Pencil size={13} /> Correct</button></div>
                {editing === selected.id ? (
                  <div className="fact-edit-form">
                    <label className="field-label">Displayed value<input value={rawValue} onChange={(event) => setRawValue(event.target.value)} /></label>
                    <label className="field-label">Normalized rule input<input value={normalizedValue} onChange={(event) => setNormalizedValue(event.target.value)} /></label>
                    <div><button type="button" className="button button-primary button-small" onClick={() => saveCorrection(selected)} disabled={saving || writesAreLocked}>{saving ? <LoaderCircle className="spin" size={13} /> : <Save size={13} />} Save correction</button><button type="button" className="button button-ghost button-small" onClick={() => setEditing("")}>Cancel</button></div>
                  </div>
                ) : (
                  <dl className="detail-list compact"><div><dt>Reviewed value</dt><dd>{selected.rawValue}</dd></div><div><dt>Normalized input</dt><dd>{selected.normalizedValue}</dd></div><div><dt>Review status</dt><dd>{selected.reviewStatus.replaceAll("_", " ")}</dd></div><div><dt>Affects</dt><dd>{selected.affects.map(moduleLabel).join(", ")}</dd></div></dl>
                )}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="empty-panel compact"><FileSearch size={23} /><strong>No reviewed facts yet</strong><p>Add synthetic documents, then use the structured review form to enter only the values needed for the selected checks.</p></div>
      )}
    </>
  );
}

function ManualFactsForm({ caseData, setCaseData, setError, setToast, writesAreLocked }: { caseData: CasePayload; setCaseData: (value: CasePayload) => void; setError: (value: string) => void; setToast: (value: string) => void; writesAreLocked: boolean }) {
  const [open, setOpen] = useState(!caseData.facts.length);
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (writesAreLocked) {
      setError("Wait for the current case operation to finish before saving reviewed facts.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const form = new FormData(event.currentTarget);
      const checkbox = (name: string) => form.get(name) === "on";
      const body = Object.fromEntries(form.entries());
      Object.assign(body, {
        employer_related_reason: checkbox("employer_related_reason"),
        worker_available: checkbox("worker_available"),
        employment_active: checkbox("employment_active"),
      });
      const response = await apiFetch(`/api/v1/cases/${caseData.id}/facts/manual`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await parseApi<{ case: CasePayload }>(response);
      setCaseData(payload.case);
      setToast("Reviewed structured facts saved. The case is ready for deterministic analysis.");
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Reviewed facts could not be saved");
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="manual-facts-card">
      <button type="button" className="manual-facts-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}><span><SlidersHorizontal size={17} /><span><strong>Manual review fallback</strong><small>Enter only facts you have verified against the synthetic records.</small></span></span><ChevronDown size={17} /></button>
      {open && (
        <form className="manual-facts-form" onSubmit={submit}>
          <fieldset><legend>Employment and wage</legend><div className="form-grid three"><label className="field-label">Worker name<input name="worker_name" defaultValue={caseData.workerName} /></label><label className="field-label">Employer name<input name="employer_name" defaultValue={caseData.employerName} /></label><label className="field-label">Position<input name="position" defaultValue={caseData.position} /></label></div><div className="form-grid three"><label className="field-label">LCA annual wage ($)<input name="lca_annual_dollars" inputMode="decimal" placeholder="120000.00" /></label><label className="field-label">Offer annual wage ($)<input name="offer_annual_dollars" inputMode="decimal" placeholder="120000.00" /></label><label className="field-label">Observed biweekly base ($)<input name="observed_biweekly_dollars" inputMode="decimal" placeholder="3769.23" /></label></div><div className="form-grid three"><label className="field-label">Period start<input type="date" name="pay_period_start" /></label><label className="field-label">Period end<input type="date" name="pay_period_end" /></label><label className="field-label">Pay date<input type="date" name="pay_date" /></label></div></fieldset>
          <fieldset><legend>Location and deduction</legend><div className="form-grid three"><label className="field-label">LCA worksite<input name="lca_worksite" placeholder="Indianapolis, Indiana" /></label><label className="field-label">Offer worksite<input name="offer_worksite" placeholder="Indianapolis, Indiana" /></label><label className="field-label">Current instruction<input name="current_worksite" placeholder="Columbus, Ohio" /></label></div><div className="form-grid three"><label className="field-label">Worksite qualifier<select name="worksite_qualifier" defaultValue="UNKNOWN"><option value="UNKNOWN">Duration unknown</option><option value="ONGOING">Ongoing</option><option value="TEMPORARY">Temporary travel</option><option value="REMOTE">Remote</option></select></label><label className="field-label">Deduction description<input name="deduction_description" placeholder="H-1B filing/legal fee recovery" /></label><label className="field-label">Deduction amount ($)<input name="deduction_dollars" inputMode="decimal" placeholder="1500.00" /></label></div><div className="form-grid three"><label className="field-label">Deduction date<input type="date" name="deduction_date" /></label></div></fieldset>
          <fieldset><legend>Possible nonproductive interval</legend><div className="form-grid three"><label className="field-label">Start<input type="date" name="nonproductive_start" /></label><label className="field-label">End (exclusive)<input type="date" name="nonproductive_end" /></label><label className="field-label">Observed base pay ($)<input name="nonproductive_observed_dollars" inputMode="decimal" placeholder="0.00" /></label></div><div className="inline-checks"><label className="check-row"><input type="checkbox" name="employer_related_reason" /><span>Employer/client-related reason is supported</span></label><label className="check-row"><input type="checkbox" name="worker_available" /><span>Worker availability is supported</span></label><label className="check-row"><input type="checkbox" name="employment_active" /><span>Employment was active</span></label></div></fieldset>
          <div className="form-actions"><button type="submit" className="button button-primary" disabled={saving || writesAreLocked}>{saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />} Save reviewed facts</button><small>This fallback does not guess values from unreadable records.</small></div>
        </form>
      )}
    </section>
  );
}

function TimelineTab({ caseData }: { caseData: CasePayload }) {
  const items = useMemo(() => {
    const rows = [
      { id: "employment-start", date: caseData.reviewStart, end: undefined, title: "Review period begins", kind: "Employment", certainty: "CONFIRMED", detail: `${caseData.position || "Employment"} at ${caseData.employerName || "reviewed employer"}` },
      ...caseData.payPeriods.map((period) => ({ id: period.id, date: period.start, end: period.end, title: `Pay period · ${formatCents(period.ordinaryBaseCents)} ordinary base`, kind: "Pay record", certainty: period.complete ? "CONFIRMED" : "APPROXIMATE", detail: period.comparable ? `Complete period paid ${friendlyDate(period.payDate)}` : "Excluded from clean wage aggregation" })),
      ...caseData.events.map((event) => ({ id: event.id, date: event.start, end: event.end, title: event.title, kind: event.kind === "NONPRODUCTIVE_TIME" ? "No-work event" : event.kind === "WORKSITE_CHANGE" ? "Worksite" : "Employment", certainty: event.certainty, detail: event.worksite ? `${event.worksite} · ${(event.qualifier ?? "unknown").toLowerCase()} context` : event.attribution ? `${event.attribution.toLowerCase()} attribution · ${event.workerAvailable === true ? "availability supported" : "availability unresolved"}` : "Reviewed event" })),
    ];
    return rows.sort((a, b) => a.date.localeCompare(b.date));
  }, [caseData]);
  return (
    <>
      <SectionTitle eyebrow="Normalized timeline" title="Pay periods and employment events in one sequence" text="Date intervals are compared as half-open ranges. Dashed markers keep uncertain timing visible rather than filling gaps by guesswork." />
      <div className="timeline-summary"><CalendarDays size={17} /><span><strong>{friendlyDate(caseData.reviewStart)} – {friendlyDate(caseData.reviewEnd)}</strong><small>{caseData.payPeriods.length} pay periods · {caseData.events.length} employment events</small></span></div>
      <ol className="case-timeline">
        {items.map((item) => (
          <li key={item.id} className={item.certainty === "CONFIRMED" ? "confirmed" : "uncertain"}>
            <div className="timeline-date"><strong>{friendlyDate(item.date)}</strong>{item.end && <small>to {friendlyDate(item.end)}</small>}</div>
            <span className="timeline-dot" />
            <article><span>{item.kind}</span><h3>{item.title}</h3><p>{item.detail}</p>{item.certainty !== "CONFIRMED" && <em><AlertCircle size={12} /> Timing or context needs review</em>}</article>
          </li>
        ))}
      </ol>
    </>
  );
}

function FindingsTab({ caseData, filter, setFilter, patchFinding, analyze, busy, analysisReady, analysisMessage, writesAreLocked }: { caseData: CasePayload; filter: "ALL" | FindingStatus; setFilter: (value: "ALL" | FindingStatus) => void; patchFinding: (id: string, patch: { include_in_report?: boolean; disposition?: Finding["disposition"] }) => void; analyze: () => void; busy: string; analysisReady: boolean; analysisMessage: string; writesAreLocked: boolean }) {
  const visible = filter === "ALL" ? caseData.findings : caseData.findings.filter((finding) => finding.status === filter);
  const analyzing = busy === "analysis";
  const analyzeDisabled = analyzing || writesAreLocked || !analysisReady;
  const analyzeTitle = !analysisReady && !writesAreLocked ? analysisMessage : undefined;
  if (!caseData.findings.length) {
    return (
      <><SectionTitle eyebrow="Evidence comparison" title="No current findings" text="Run the four deterministic modules from the reviewed facts. Partial results are never published." />
      {!analysisReady && analysisMessage && (
        <div className="readiness-note" role="status"><Info size={15} aria-hidden="true" /><span>{analysisMessage}</span></div>
      )}
      <div className="empty-panel"><SearchCheck size={25} /><strong>Ready when you are</strong><p>WageShield will compare wages, nonproductive time, deductions, and employment facts as one frozen snapshot.</p><button type="button" className="button button-primary" onClick={analyze} disabled={analyzeDisabled} title={analyzeTitle}>{analyzing ? <LoaderCircle className="spin" size={15} /> : <SearchCheck size={15} />} Run four checks</button></div></>
    );
  }
  return (
    <>
      <SectionTitle eyebrow="Findings" title="Four checks, without an opaque risk score" text="Cards are grouped by module. Open any result to inspect evidence, calculations, official context, limits, and verification questions." action={<button type="button" className="button button-secondary" onClick={analyze} disabled={analyzeDisabled} title={analyzeTitle}>{analyzing ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />} Rerun</button>} />
      {!analysisReady && analysisMessage && (
        <div className="readiness-note" role="status"><Info size={15} aria-hidden="true" /><span>{analysisMessage} These results may be stale until you rerun.</span></div>
      )}
      <div className="finding-filter" role="group" aria-label="Filter findings"><button type="button" className={filter === "ALL" ? "active" : ""} onClick={() => setFilter("ALL")}>All <span>{caseData.findings.length}</span></button>{(["POSSIBLE_DISCREPANCY", "HUMAN_REVIEW_REQUIRED", "INSUFFICIENT_EVIDENCE", "NO_MISMATCH_DETECTED"] as FindingStatus[]).map((status) => { const count = caseData.findings.filter((finding) => finding.status === status).length; return count ? <button key={status} type="button" className={filter === status ? "active" : ""} onClick={() => setFilter(status)}>{STATUS_META[status].short} <span>{count}</span></button> : null; })}</div>
      <div className="finding-list">{visible.map((finding) => <FindingCard key={finding.id} finding={finding} caseData={caseData} updating={busy === `finding-${finding.id}` || writesAreLocked} patchFinding={patchFinding} />)}</div>
      <div className="safety-note"><Info size={17} /><div><strong>These are documentary signals</strong><p>A possible discrepancy is not a finding that a rule was violated. A no-mismatch result covers only the evidence and checks in this snapshot.</p></div></div>
    </>
  );
}

function FindingCard({ finding, caseData, updating, patchFinding }: { finding: Finding; caseData: CasePayload; updating: boolean; patchFinding: (id: string, patch: { include_in_report?: boolean; disposition?: Finding["disposition"] }) => void }) {
  const meta = MODULE_META[finding.module];
  const status = STATUS_META[finding.status];
  const Icon = meta.icon;
  return (
    <details className={`finding-card ${status.className}`} open={finding.module === "WAGE_BENCHMARK"}>
      <summary>
        <div className="finding-number"><Icon size={18} /><small>{meta.number}</small></div>
        <div className="finding-summary-main"><span className={`status-chip ${status.className}`}>{finding.status === "NO_MISMATCH_DETECTED" ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}{status.label}</span><h3>{finding.headline}</h3><p>{finding.summary}</p></div>
        <div className="finding-summary-side">{finding.amountCents !== undefined && <div><small>{finding.amountLabel}</small><strong>{formatCents(finding.amountCents)}</strong></div>}<span className="details-chevron"><ChevronDown size={17} /></span></div>
      </summary>
      <div className="finding-detail">
        <div className="finding-toolbar"><span><History size={13} /> {finding.ruleVersion}</span><label><input type="checkbox" checked={finding.includeInReport} disabled={updating} onChange={(event) => patchFinding(finding.id, { include_in_report: event.target.checked })} /> Include in report</label></div>
        <div className="finding-detail-grid">
          <section>
            <h4>Why this appeared</h4>
            {finding.calculation ? <div className="calculation-card"><code>{finding.calculation.formula}</code>{finding.calculation.rows.map((row) => <div key={row.label} className={row.emphasis ? "emphasis" : ""}><span>{row.label}</span><strong>{row.value}</strong></div>)}<p>{finding.calculation.method}</p></div> : <div className="calculation-card empty"><Info size={15} /> No monetary calculation was used for this status.</div>}
          </section>
          <section>
            <h4>Confidence, not legal probability</h4>
            <div className="confidence-list">{Object.entries(finding.confidence).map(([label, value]) => <div key={label}><span>{label}</span><div><i style={{ width: `${value * 100}%` }} /></div><strong>{formatPercent(value)}</strong></div>)}</div>
          </section>
        </div>
        <section className="finding-evidence"><h4>Case evidence</h4><div>{finding.evidence.length ? finding.evidence.map((item) => <article key={item.id}><span><FileCheck2 size={14} /> {item.role}</span><blockquote>“{item.text}”</blockquote><small>{item.documentName} · page {item.page}</small>{caseData.documents.some((document) => document.id === item.documentId) && <a href={`/api/v1/cases/${caseData.id}/documents/${item.documentId}`} target="_blank" rel="noreferrer">Open record <ExternalLink size={11} /></a>}</article>) : <article><span><Info size={14} /> Missing evidence</span><blockquote>No source span is available for the required fact.</blockquote></article>}</div></section>
        <section className="source-card"><div className="source-card-icon"><BadgeCheck size={17} /></div><div><span>Official context · separate from case evidence</span><h4>{finding.source.title}</h4><p>{finding.source.paraphrase}</p><small>{finding.source.caveat}</small><a href={finding.source.url} target="_blank" rel="noreferrer">Open official source <ExternalLink size={12} /></a></div></section>
        <div className="finding-bottom-grid"><section><h4>Assumptions & limits</h4><ul>{[...finding.assumptions, ...finding.limitations].map((item) => <li key={item}>{item}</li>)}</ul></section><section><h4>Questions for a human reviewer</h4><ul>{finding.questions.map((item) => <li key={item}>{item}</li>)}</ul></section></div>
        <div className="finding-disposition"><span>How should this appear in your review?</span><div>{(["UNREVIEWED", "EXPLAINED", "IRRELEVANT", "NEEDS_REVIEW"] as Finding["disposition"][]).map((value) => <button key={value} type="button" className={finding.disposition === value ? "active" : ""} disabled={updating} onClick={() => patchFinding(finding.id, { disposition: value })}>{value.replaceAll("_", " ").toLowerCase()}</button>)}</div></div>
      </div>
    </details>
  );
}

function ReportTab({ caseData, setCaseData, patchFinding, setError, setToast, busy, writesAreLocked }: { caseData: CasePayload; setCaseData: (value: CasePayload) => void; patchFinding: (id: string, patch: { include_in_report?: boolean }) => void; setError: (value: string) => void; setToast: (value: string) => void; busy: string; writesAreLocked: boolean }) {
  const [redactWorker, setRedactWorker] = useState(true);
  const [redactEmployer, setRedactEmployer] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [report, setReport] = useState<{ id: string; sha256: string; download_url: string; manifest_url: string } | null>(null);
  const included = caseData.findings.filter((finding) => finding.includeInReport);
  const canGenerate = caseData.state === "RESULTS_READY" && Boolean(caseData.findings.length);
  async function generate() {
    if (writesAreLocked) { setError("Wait for the current case operation to finish before generating a report."); return; }
    if (!canGenerate) { setError("Run the comparisons on the current reviewed facts before generating a report."); return; }
    if (!included.length) { setError("Select at least one finding for the report."); return; }
    setGenerating(true);
    setError("");
    try {
      const response = await apiFetch(`/api/v1/cases/${caseData.id}/reports`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ included_finding_ids: included.map((finding) => finding.id), redact_worker_name: redactWorker, redact_employer_name: redactEmployer }) });
      const payload = await parseApi<{ case: CasePayload; report: { id: string; sha256: string; download_url: string; manifest_url: string } }>(response);
      setCaseData(payload.case);
      setReport(payload.report);
      setToast("Report reconstructed from the selected fields and stored privately.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Report could not be generated");
    } finally { setGenerating(false); }
  }
  const downloadUrl = report?.download_url ?? (caseData.lastReport ? `/api/v1/cases/${caseData.id}/reports/${caseData.lastReport.id}` : "");
  const manifestUrl = report?.manifest_url ?? (caseData.lastReport ? `/api/v1/cases/${caseData.id}/reports/${caseData.lastReport.id}/manifest` : "");
  const hash = report?.sha256 ?? caseData.lastReport?.sha256;
  return (
    <>
      <SectionTitle eyebrow="Report builder" title="Choose exactly what leaves the case" text="The export starts empty and is reconstructed from selected structured fields. Original document layers are never copied into the PDF." />
      <div className="report-layout">
        <section className="report-builder panel-card">
          <div className="panel-card-head"><h3>1. Select findings</h3><span>{included.length} included</span></div>
          <div className="report-finding-list">{caseData.findings.length ? caseData.findings.map((finding) => <label key={finding.id}><input type="checkbox" checked={finding.includeInReport} disabled={writesAreLocked || busy === `finding-${finding.id}`} onChange={(event) => patchFinding(finding.id, { include_in_report: event.target.checked })} /><span><strong>{MODULE_META[finding.module].label}</strong><small>{finding.headline}</small></span><em className={STATUS_META[finding.status].className}>{STATUS_META[finding.status].short}</em></label>) : <p className="compact-empty-text">Run the comparisons first, then choose which findings to include.</p>}</div>
          <div className="panel-card-head report-step"><h3>2. Redact identifiers</h3><span>Exclusion-first</span></div>
          <label className="switch-row"><span><strong>Mask worker name</strong><small>Replace with [REDACTED BY USER]</small></span><input aria-label="Mask worker name" type="checkbox" checked={redactWorker} onChange={(event) => setRedactWorker(event.target.checked)} /></label>
          <label className="switch-row"><span><strong>Mask employer name</strong><small>Useful when sharing a methodology sample</small></span><input aria-label="Mask employer name" type="checkbox" checked={redactEmployer} onChange={(event) => setRedactEmployer(event.target.checked)} /></label>
          <button type="button" className="button button-primary button-full report-generate" onClick={generate} disabled={generating || !included.length || writesAreLocked || !canGenerate} title={!canGenerate ? "Run the comparisons on the current reviewed facts first." : undefined}>{generating ? <LoaderCircle className="spin" size={16} /> : <FileDown size={16} />}{generating ? "Reconstructing report…" : "Generate evidence report"}</button>
        </section>
        <section className="report-preview">
          <div className="report-paper"><div className="report-paper-mark"><ShieldCheck size={18} /></div><span>WAGESHIELD H-1B</span><h3>Evidence review packet</h3><p>Not legal advice or a legal determination.</p><dl><div><dt>Worker</dt><dd>{redactWorker ? "[REDACTED BY USER]" : caseData.workerName}</dd></div><div><dt>Employer</dt><dd>{redactEmployer ? "[REDACTED BY USER]" : caseData.employerName}</dd></div><div><dt>Review period</dt><dd>{caseData.reviewStart} – {caseData.reviewEnd}</dd></div><div><dt>Selected findings</dt><dd>{included.length}</dd></div></dl><div className="report-paper-lines"><i /><i /><i /><i /></div><small>ALLOWLISTED STRUCTURED RECONSTRUCTION</small></div>
          {downloadUrl ? <div className="report-ready"><CheckCircle2 size={18} /><div><strong>Latest report is ready</strong><small>SHA-256 {hash?.slice(0, 20)}…</small></div><a href={downloadUrl} className="button button-primary"><Download size={15} /> Download PDF</a><a href={manifestUrl} target="_blank" rel="noreferrer" className="button button-secondary"><FileSearch size={15} /> Manifest</a></div> : <div className="report-preview-note"><FolderLock size={15} /> The preview uses case data only inside this browser session.</div>}
        </section>
      </div>
    </>
  );
}

function PrivacyTab({ caseData, setCaseData, router, setError, setToast, writesAreLocked }: { caseData: CasePayload; setCaseData: (value: CasePayload) => void; router: ReturnType<typeof useRouter>; setError: (value: string) => void; setToast: (value: string) => void; writesAreLocked: boolean }) {
  const [retention, setRetention] = useState(caseData.retentionHours);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  async function saveRetention() {
    if (writesAreLocked) { setError("Wait for the current case operation to finish before changing retention."); return; }
    setSaving(true);
    try { const response = await apiFetch(`/api/v1/cases/${caseData.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ retention_hours: retention }) }); const payload = await parseApi<{ case: CasePayload }>(response); setCaseData(payload.case); setToast("Retention window updated from the current time."); } catch (caught) { setError(caught instanceof Error ? caught.message : "Retention could not be updated"); } finally { setSaving(false); }
  }
  async function deleteCaseNow() {
    setDeleting(true);
    try { const response = await apiFetch(`/api/v1/cases/${caseData.id}`, { method: "DELETE", headers: { "Idempotency-Key": crypto.randomUUID() } }); await parseApi(response); router.push("/cases?deleted=1"); } catch (caught) { setError(caught instanceof Error ? caught.message : "Deletion could not complete"); setDeleting(false); setConfirmDelete(false); }
  }
  return (
    <>
      <SectionTitle eyebrow="Privacy controls" title="Keep only what you need, for only as long as you need it" text="The demo is synthetic-only, but it still exercises case-scoped storage, no-content logging, retention, and verified deletion." />
      <div className="privacy-settings-grid">
        <section className="panel-card"><div className="privacy-setting-icon"><Clock3 size={20} /></div><h3>Automatic deletion</h3><p>Choose a short retention window. Updating the setting restarts the window from now.</p><label className="field-label">Retention window<select value={retention} onChange={(event) => setRetention(Number(event.target.value))}><option value={1}>1 hour</option><option value={24}>24 hours</option><option value={72}>3 days</option><option value={168}>7 days</option></select></label><button type="button" className="button button-secondary" onClick={saveRetention} disabled={saving || writesAreLocked}>{saving ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />} Save retention</button></section>
        <section className="panel-card"><div className="privacy-setting-icon"><FolderLock size={20} /></div><h3>Artifact inventory</h3><p>Deletion covers the structured case snapshot and every case-owned stored object.</p><dl className="inventory-list"><div><dt>Documents</dt><dd>{caseData.documents.length}</dd></div><div><dt>Reviewed facts</dt><dd>{caseData.facts.length}</dd></div><div><dt>Findings</dt><dd>{caseData.findings.length}</dd></div><div><dt>Reports</dt><dd>{caseData.lastReport ? 1 : 0}</dd></div></dl></section>
        <section className="panel-card"><div className="privacy-setting-icon"><ShieldCheck size={20} /></div><h3>Data boundaries</h3><ul className="privacy-boundaries"><li><Check size={13} /> No private records in the official-source corpus</li><li><Check size={13} /> No raw document text in standard logs</li><li><Check size={13} /> Case-scoped object keys and session authorization</li><li><Check size={13} /> No automatic sharing or external action</li></ul></section>
      </div>
      <section className="danger-zone"><div><span><Trash2 size={18} /></span><div><h3>Delete this review now</h3><p>Documents, structured facts, findings, and generated reports are removed. Only a non-substantive deletion-verification hash remains.</p></div></div><button type="button" className="button button-danger" onClick={() => setConfirmDelete(true)} disabled={writesAreLocked}><Trash2 size={15} /> Delete case</button></section>
      {confirmDelete && <div className="modal-backdrop" role="button" tabIndex={-1} aria-label="Close deletion dialog" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleting) setConfirmDelete(false); }} onKeyDown={(event) => { if (event.key === "Escape" && !deleting) setConfirmDelete(false); }}><section className="delete-modal" role="dialog" aria-modal="true" aria-labelledby="delete-title"><span className="delete-modal-icon"><Trash2 size={23} /></span><h2 id="delete-title">Permanently delete this review?</h2><p>This removes all case-owned documents, facts, findings, and report files. The action cannot be undone.</p><div><button type="button" className="button button-secondary" onClick={() => setConfirmDelete(false)} disabled={deleting}>Keep review</button><button type="button" className="button button-danger" onClick={deleteCaseNow} disabled={deleting}>{deleting ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}{deleting ? "Verifying deletion…" : "Delete permanently"}</button></div></section></div>}
    </>
  );
}
