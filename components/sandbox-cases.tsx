"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Check,
  CircleAlert,
  FlaskConical,
  LoaderCircle,
  SearchCheck,
  ShieldAlert,
} from "lucide-react";
import type { Scenario } from "@/lib/types";

type SandboxScenario = Exclude<Scenario, "custom">;

type SandboxResponse = {
  case?: { id?: string };
  error?: {
    message?: string;
    sign_in_url?: string;
    details?: Record<string, string>;
    request_id?: string;
    retryable?: boolean;
  };
};

const SCENARIOS: Array<{
  id: SandboxScenario;
  label: string;
  eyebrow: string;
  description: string;
  outcome: string;
  icon: typeof SearchCheck;
}> = [
  {
    id: "hero",
    label: "Evidence differences",
    eyebrow: "Complete fictional record",
    description: "Follow a wage benchmark, nonproductive-time interval, fee reference, and worksite conflict from source to finding.",
    outcome: "3 possible differences · 1 human review",
    icon: SearchCheck,
  },
  {
    id: "clean",
    label: "Consistent record",
    eyebrow: "Negative control",
    description: "See how the same checks behave when the fictional documents align and no mismatch is detected.",
    outcome: "4 no-mismatch results",
    icon: Check,
  },
  {
    id: "ambiguous",
    label: "Incomplete record",
    eyebrow: "Responsible abstention",
    description: "Inspect how partial dates and unclear labels produce requests for more evidence instead of overconfident conclusions.",
    outcome: "More evidence · human review",
    icon: ShieldAlert,
  },
];

export function SandboxCases({
  signedIn,
  signInPath,
  initialScenario = "hero",
}: {
  signedIn: boolean;
  signInPath: string;
  initialScenario?: SandboxScenario;
}) {
  const router = useRouter();
  const idempotencyKey = useRef("");
  const [scenario, setScenario] = useState<SandboxScenario>(initialScenario);
  const [retentionHours, setRetentionHours] = useState(24);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [requestId, setRequestId] = useState("");

  async function openSandbox() {
    if (!signedIn) {
      const destination = new URL(signInPath || "/signin", window.location.origin);
      destination.searchParams.set("return_to", `/sandbox?scenario=${scenario}`);
      window.location.assign(`${destination.pathname}${destination.search}${destination.hash}`);
      return;
    }
    if (!acknowledged) {
      setError("Confirm that you understand the sandbox uses fictional records.");
      return;
    }

    setBusy(true);
    setError("");
    setRequestId("");
    try {
      idempotencyKey.current ||= crypto.randomUUID();
      const response = await fetch("/api/v1/cases", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey.current,
        },
        body: JSON.stringify({
          mode: "sandbox",
          scenario,
          retention_hours: retentionHours,
          authorized_use_confirmed: true,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as SandboxResponse;
      if (response.status === 401 && payload.error?.sign_in_url) {
        window.location.assign(payload.error.sign_in_url);
        return;
      }
      if (!response.ok || !payload.case?.id) {
        if (response.status < 500 && !payload.error?.retryable) idempotencyKey.current = "";
        setRequestId(payload.error?.request_id ?? "");
        throw new Error(payload.error?.message ?? "The fictional case could not be prepared. Please try again.");
      }
      idempotencyKey.current = "";
      router.push(`/cases/${payload.case.id}?tab=findings`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The fictional case could not be prepared. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="sandbox-builder">
      <div className="sandbox-grid" role="radiogroup" aria-label="Choose a fictional case">
        {SCENARIOS.map((item) => {
          const Icon = item.icon;
          const selected = scenario === item.id;
          return (
            <label className={`sandbox-card ${selected ? "selected" : ""}`} key={item.id}>
              <input
                className="sr-only"
                type="radio"
                name="sandbox-scenario"
                value={item.id}
                checked={selected}
                onChange={() => {
                  setScenario(item.id);
                  setError("");
                }}
              />
              <span className="sandbox-card-icon"><Icon size={20} aria-hidden="true" /></span>
              <span className="sandbox-card-choice" aria-hidden="true">{selected && <Check size={14} />}</span>
              <small>{item.eyebrow}</small>
              <strong>{item.label}</strong>
              <p>{item.description}</p>
              <span className="sandbox-outcome">{item.outcome}</span>
            </label>
          );
        })}
      </div>

      <section className="sandbox-settings" aria-labelledby="sandbox-settings-heading">
        <div>
          <span className="eyebrow"><FlaskConical size={14} /> Sandbox settings</span>
          <h2 id="sandbox-settings-heading">Save a private copy to your account</h2>
          <p>Each sandbox run creates an isolated case that you can inspect, change, report on, and delete.</p>
        </div>
        <label className="sandbox-retention" htmlFor="sandbox-retention">
          <span>Automatic deletion</span>
          <select id="sandbox-retention" value={retentionHours} onChange={(event) => setRetentionHours(Number(event.target.value))}>
            <option value={1}>After 1 hour</option>
            <option value={24}>After 24 hours</option>
            <option value={72}>After 3 days</option>
            <option value={168}>After 7 days</option>
          </select>
        </label>
        <label
          className={`authorization-check sandbox-check ${error && !acknowledged ? "has-error" : ""}`}
          aria-label="Confirm that sandbox records are fictional"
        >
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => {
              setAcknowledged(event.target.checked);
              setError("");
            }}
          />
          <span>
            <strong>I understand this sandbox contains fictional records only.</strong>
            <small>I will not treat its people, employers, numbers, or findings as real-world facts.</small>
          </span>
        </label>
        {error && (
          <div className="intake-submit-error" role="alert">
            <CircleAlert size={17} aria-hidden="true" />
            <div><strong>Sandbox not opened</strong><p>{error}</p>{requestId && <small>Support reference: {requestId}</small>}</div>
          </div>
        )}
        <button className="button button-primary sandbox-submit" type="button" onClick={openSandbox} disabled={busy}>
          {busy ? (
            <><LoaderCircle className="spin" size={17} aria-hidden="true" /> Preparing fictional case…</>
          ) : signedIn ? (
            <>Open selected sandbox <ArrowRight size={17} aria-hidden="true" /></>
          ) : (
            <>Sign in to open sandbox <ArrowRight size={17} aria-hidden="true" /></>
          )}
        </button>
      </section>
    </div>
  );
}
