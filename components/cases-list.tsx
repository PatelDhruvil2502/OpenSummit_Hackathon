"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, CalendarClock, CalendarDays, Files, FolderOpen, LoaderCircle, Plus } from "lucide-react";
import { API_POLICY } from "@/lib/product-config";
import type { CaseSummary } from "@/lib/types";

const STATE_LABELS: Record<string, string> = {
  DRAFT: "Setup needed",
  INTAKE_COMPLETE: "Ready for documents",
  UPLOADING: "Uploading documents",
  PROCESSING: "Processing documents",
  FACT_REVIEW_REQUIRED: "Review facts",
  READY_FOR_ANALYSIS: "Ready to analyze",
  ANALYZING: "Comparing evidence",
  RESULTS_READY: "Results ready",
  REPORTING: "Preparing report",
  REPORT_FAILED: "Report retry needed",
  PROCESSING_FAILED: "Processing retry needed",
  ANALYSIS_FAILED: "Analysis retry needed",
  UPLOAD_FAILED: "Upload retry needed",
  DELETION_PENDING: "Deleting",
  DELETION_FAILED: "Deletion retry needed",
  DELETED: "Deleted",
};

async function fetchCases(cursor: string | null) {
  const url = cursor
    ? `/api/v1/cases?limit=${API_POLICY.defaultCasePageSize}&cursor=${encodeURIComponent(cursor)}`
    : `/api/v1/cases?limit=${API_POLICY.defaultCasePageSize}`;
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  const payload = (await response.json()) as {
    cases?: CaseSummary[];
    nextCursor?: string | null;
    error?: { message?: string; sign_in_url?: string };
  };
  if (response.status === 401 && payload.error?.sign_in_url) {
    window.location.assign(payload.error.sign_in_url);
    return null;
  }
  if (!response.ok) throw new Error(payload.error?.message ?? "Unable to load reviews");
  return {
    cases: Array.isArray(payload.cases) ? payload.cases : [],
    nextCursor: payload.nextCursor ?? null,
  };
}

export function CasesList() {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let active = true;
    fetchCases(null)
      .then((page) => {
        if (!active || !page) return;
        setCases(page.cases);
        setNextCursor(page.nextCursor);
        setError("");
      })
      .catch(
        (caught) =>
          active && setError(caught instanceof Error ? caught.message : "Unable to load reviews"),
      )
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [reloadToken]);

  const loadFirstPage = useCallback(() => {
    setLoading(true);
    setError("");
    setReloadToken((token) => token + 1);
  }, []);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const page = await fetchCases(nextCursor);
      if (!page) return;
      setCases((current) => [...current, ...page.cases]);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load more reviews");
    } finally {
      setLoadingMore(false);
    }
  }

  if (loading) {
    return (
      <div className="cases-loading" role="status" aria-live="polite">
        <LoaderCircle className="spin" size={20} /> Loading private reviews…
      </div>
    );
  }

  if (error && !cases.length) {
    return (
      <div className="empty-panel" role="alert">
        <strong>Reviews could not be loaded</strong>
        <p>{error}</p>
        <button type="button" className="button button-secondary" onClick={loadFirstPage}>
          Try again
        </button>
      </div>
    );
  }

  if (!cases.length) {
    return (
      <div className="empty-panel">
        <span className="empty-icon"><FolderOpen size={25} /></span>
        <strong>No active reviews yet</strong>
        <p>Create a private review for your own authorized records.</p>
        <Link href="/cases/new" className="button button-primary"><Plus size={16} /> Start a review</Link>
      </div>
    );
  }

  return (
    <div>
      {error && <div className="empty-panel" role="alert"><strong>Could not load more reviews</strong><p>{error}</p></div>}
      <div className="case-card-grid">
        {cases.map((caseItem) => (
          <Link
            className="case-card"
            href={`/cases/${caseItem.id}`}
            key={caseItem.id}
            aria-label={`Open ${caseItem.title}, ${STATE_LABELS[caseItem.state] ?? caseItem.state.replaceAll("_", " ")}`}
          >
            <div className="case-card-head">
              <span className={`case-state state-${caseItem.state.toLowerCase()}`}>
                {STATE_LABELS[caseItem.state] ?? caseItem.state.replaceAll("_", " ")}
              </span>
              <ArrowRight size={17} />
            </div>
            <h2>{caseItem.title}</h2>
            <p>{caseItem.employerName || "Employer not entered"}</p>
            <div className="case-card-meta">
              <span><CalendarDays size={13} /> {caseItem.reviewStart} – {caseItem.reviewEnd}</span>
              <span><Files size={13} /> {caseItem.documentCount} document{caseItem.documentCount === 1 ? "" : "s"}</span>
              <span>
                <CalendarClock size={13} /> Expires{" "}
                <time dateTime={caseItem.retentionExpiresAt}>
                  {new Date(caseItem.retentionExpiresAt).toLocaleString()}
                </time>
              </span>
            </div>
            <div className="case-card-foot">
              <span>{caseItem.mode === "SANDBOX" ? "Fictional sandbox" : "Private evidence review"}</span>
              <small>Updated <time dateTime={caseItem.updatedAt}>{new Date(caseItem.updatedAt).toLocaleDateString()}</time></small>
            </div>
          </Link>
        ))}
        {cases.length < API_POLICY.maximumActiveCases && (
          <Link href="/cases/new" className="case-card case-card-new">
            <span className="empty-icon"><Plus size={22} /></span>
            <strong>Start another review</strong>
            <p>Create a private workspace for authorized employment records.</p>
          </Link>
        )}
      </div>
      {nextCursor && (
        <div className="cases-load-more">
          <button type="button" className="button button-secondary" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <><LoaderCircle className="spin" size={16} /> Loading…</> : "Load more reviews"}
          </button>
        </div>
      )}
    </div>
  );
}
