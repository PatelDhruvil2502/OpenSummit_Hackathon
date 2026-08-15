"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  BriefcaseBusiness,
  CalendarRange,
  CircleAlert,
  FileLock2,
  LoaderCircle,
  ShieldCheck,
  UserRound,
} from "lucide-react";

type FormValues = {
  title: string;
  workerName: string;
  employerName: string;
  position: string;
  reviewStart: string;
  reviewEnd: string;
  retentionHours: string;
  authorizedUseConfirmed: boolean;
};

type CaseCreationResponse = {
  case?: { id?: string };
  error?: {
    message?: string;
    sign_in_url?: string;
    details?: Record<string, string>;
    retryable?: boolean;
    request_id?: string;
  };
};

const INITIAL_VALUES: FormValues = {
  title: "",
  workerName: "",
  employerName: "",
  position: "",
  reviewStart: "",
  reviewEnd: "",
  retentionHours: "24",
  authorizedUseConfirmed: false,
};

const FIELD_KEY_MAP: Record<string, keyof FormValues> = {
  title: "title",
  worker_name: "workerName",
  employer_name: "employerName",
  position: "position",
  review_start: "reviewStart",
  review_end: "reviewEnd",
  retention_hours: "retentionHours",
  authorized_use_confirmed: "authorizedUseConfirmed",
};

function validate(values: FormValues): Partial<Record<keyof FormValues, string>> {
  const errors: Partial<Record<keyof FormValues, string>> = {};
  const title = values.title.trim();
  const workerName = values.workerName.trim();
  const employerName = values.employerName.trim();
  const position = values.position.trim();

  if (!title) errors.title = "Enter a short name for this review.";
  else if (title.length > 80) errors.title = "Use 80 characters or fewer.";
  if (!workerName) errors.workerName = "Enter the worker name shown in the records.";
  else if (workerName.length > 100) errors.workerName = "Use 100 characters or fewer.";
  if (!employerName) errors.employerName = "Enter the employer named in the records.";
  else if (employerName.length > 140) errors.employerName = "Use 140 characters or fewer.";
  if (!position) errors.position = "Enter the position or job title.";
  else if (position.length > 120) errors.position = "Use 120 characters or fewer.";
  if (!values.reviewStart) errors.reviewStart = "Choose the first date to review.";
  if (!values.reviewEnd) errors.reviewEnd = "Choose the last date to review.";
  if (values.reviewStart && values.reviewEnd && values.reviewStart > values.reviewEnd) {
    errors.reviewEnd = "The end date must be on or after the start date.";
  }
  if (!values.authorizedUseConfirmed) {
    errors.authorizedUseConfirmed = "Confirm that you are authorized to use these records.";
  }
  return errors;
}

function inputErrorId(name: keyof FormValues) {
  return `${name}-error`;
}

export function NewCaseForm() {
  const router = useRouter();
  const idempotencyKey = useRef("");
  const [values, setValues] = useState<FormValues>(INITIAL_VALUES);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof FormValues, string>>>({});
  const [submitError, setSubmitError] = useState("");
  const [requestId, setRequestId] = useState("");
  const [busy, setBusy] = useState(false);

  function update<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    setSubmitError("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const clientErrors = validate(values);
    if (Object.keys(clientErrors).length) {
      setFieldErrors(clientErrors);
      setSubmitError("Check the highlighted fields before creating the review.");
      const firstInvalid = Object.keys(clientErrors)[0] as keyof FormValues | undefined;
      if (firstInvalid) document.getElementById(firstInvalid)?.focus();
      return;
    }

    setBusy(true);
    setSubmitError("");
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
          mode: "standard",
          title: values.title.trim(),
          worker_name: values.workerName.trim(),
          employer_name: values.employerName.trim(),
          position: values.position.trim(),
          review_start: values.reviewStart,
          review_end: values.reviewEnd,
          retention_hours: Number(values.retentionHours),
          authorized_use_confirmed: true,
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as CaseCreationResponse;
      if (response.status === 401 && payload.error?.sign_in_url) {
        window.location.assign(payload.error.sign_in_url);
        return;
      }
      if (!response.ok || !payload.case?.id) {
        if (response.status < 500 && !payload.error?.retryable) idempotencyKey.current = "";
        const mappedErrors: Partial<Record<keyof FormValues, string>> = {};
        for (const [serverKey, message] of Object.entries(payload.error?.details ?? {})) {
          const field = FIELD_KEY_MAP[serverKey];
          if (field) mappedErrors[field] = message;
        }
        setFieldErrors(mappedErrors);
        setRequestId(payload.error?.request_id ?? "");
        throw new Error(payload.error?.message ?? "The review could not be created. Please try again.");
      }

      idempotencyKey.current = "";
      router.push(`/cases/${payload.case.id}?tab=documents`);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "The review could not be created. Please try again.");
      setBusy(false);
    }
  }

  return (
    <form className="intake-form" onSubmit={submit} noValidate aria-busy={busy}>
      <section className="intake-form-section" aria-labelledby="review-details-heading">
        <div className="intake-section-heading">
          <span><FileLock2 size={18} aria-hidden="true" /></span>
          <div>
            <h2 id="review-details-heading">Review details</h2>
            <p>Use a neutral title that will help you recognize this private workspace.</p>
          </div>
        </div>

        <label className="intake-field intake-field-wide" htmlFor="title">
          <span>Review title <small>Required</small></span>
          <input
            id="title"
            name="title"
            value={values.title}
            onChange={(event) => update("title", event.target.value)}
            placeholder="Example: 2026 wage and payroll review"
            maxLength={80}
            autoComplete="off"
            aria-invalid={Boolean(fieldErrors.title)}
            aria-describedby={fieldErrors.title ? inputErrorId("title") : "title-hint"}
          />
          <small id="title-hint" className="field-hint">Avoid Social Security numbers, receipt numbers, or other identifiers in the title.</small>
          {fieldErrors.title && <small className="field-error" id={inputErrorId("title")}>{fieldErrors.title}</small>}
        </label>
      </section>

      <section className="intake-form-section" aria-labelledby="employment-details-heading">
        <div className="intake-section-heading">
          <span><BriefcaseBusiness size={18} aria-hidden="true" /></span>
          <div>
            <h2 id="employment-details-heading">Employment record</h2>
            <p>Enter these exactly enough to match the documents you plan to add.</p>
          </div>
        </div>

        <div className="intake-fields">
          <label className="intake-field" htmlFor="workerName">
            <span>Worker name <small>Required</small></span>
            <input
              id="workerName"
              name="worker_name"
              value={values.workerName}
              onChange={(event) => update("workerName", event.target.value)}
              maxLength={100}
              autoComplete="name"
              aria-invalid={Boolean(fieldErrors.workerName)}
              aria-describedby={fieldErrors.workerName ? inputErrorId("workerName") : undefined}
            />
            {fieldErrors.workerName && <small className="field-error" id={inputErrorId("workerName")}>{fieldErrors.workerName}</small>}
          </label>

          <label className="intake-field" htmlFor="employerName">
            <span>Employer name <small>Required</small></span>
            <input
              id="employerName"
              name="employer_name"
              value={values.employerName}
              onChange={(event) => update("employerName", event.target.value)}
              maxLength={140}
              autoComplete="organization"
              aria-invalid={Boolean(fieldErrors.employerName)}
              aria-describedby={fieldErrors.employerName ? inputErrorId("employerName") : undefined}
            />
            {fieldErrors.employerName && <small className="field-error" id={inputErrorId("employerName")}>{fieldErrors.employerName}</small>}
          </label>

          <label className="intake-field intake-field-wide" htmlFor="position">
            <span>Position or job title <small>Required</small></span>
            <input
              id="position"
              name="position"
              value={values.position}
              onChange={(event) => update("position", event.target.value)}
              maxLength={120}
              autoComplete="organization-title"
              aria-invalid={Boolean(fieldErrors.position)}
              aria-describedby={fieldErrors.position ? inputErrorId("position") : undefined}
            />
            {fieldErrors.position && <small className="field-error" id={inputErrorId("position")}>{fieldErrors.position}</small>}
          </label>
        </div>
      </section>

      <section className="intake-form-section" aria-labelledby="review-window-heading">
        <div className="intake-section-heading">
          <span><CalendarRange size={18} aria-hidden="true" /></span>
          <div>
            <h2 id="review-window-heading">Review window and retention</h2>
            <p>The date range guides period comparisons. Retention controls when this case is scheduled for deletion.</p>
          </div>
        </div>

        <div className="intake-fields intake-fields-three">
          <label className="intake-field" htmlFor="reviewStart">
            <span>Start date <small>Required</small></span>
            <input
              id="reviewStart"
              name="review_start"
              type="date"
              value={values.reviewStart}
              onChange={(event) => update("reviewStart", event.target.value)}
              aria-invalid={Boolean(fieldErrors.reviewStart)}
              aria-describedby={fieldErrors.reviewStart ? inputErrorId("reviewStart") : undefined}
            />
            {fieldErrors.reviewStart && <small className="field-error" id={inputErrorId("reviewStart")}>{fieldErrors.reviewStart}</small>}
          </label>

          <label className="intake-field" htmlFor="reviewEnd">
            <span>End date <small>Required</small></span>
            <input
              id="reviewEnd"
              name="review_end"
              type="date"
              min={values.reviewStart || undefined}
              value={values.reviewEnd}
              onChange={(event) => update("reviewEnd", event.target.value)}
              aria-invalid={Boolean(fieldErrors.reviewEnd)}
              aria-describedby={fieldErrors.reviewEnd ? inputErrorId("reviewEnd") : undefined}
            />
            {fieldErrors.reviewEnd && <small className="field-error" id={inputErrorId("reviewEnd")}>{fieldErrors.reviewEnd}</small>}
          </label>

          <label className="intake-field" htmlFor="retentionHours">
            <span>Automatic deletion</span>
            <select
              id="retentionHours"
              name="retention_hours"
              value={values.retentionHours}
              onChange={(event) => update("retentionHours", event.target.value)}
              aria-invalid={Boolean(fieldErrors.retentionHours)}
              aria-describedby={fieldErrors.retentionHours ? inputErrorId("retentionHours") : "retention-hint"}
            >
              <option value="1">After 1 hour</option>
              <option value="24">After 24 hours</option>
              <option value="72">After 3 days</option>
              <option value="168">After 7 days</option>
            </select>
            <small id="retention-hint" className="field-hint">You can delete the case sooner from its Privacy tab.</small>
            {fieldErrors.retentionHours && <small className="field-error" id={inputErrorId("retentionHours")}>{fieldErrors.retentionHours}</small>}
          </label>
        </div>
      </section>

      <section className="intake-form-section intake-consent-section" aria-labelledby="authorization-heading">
        <div className="intake-section-heading">
          <span><ShieldCheck size={18} aria-hidden="true" /></span>
          <div>
            <h2 id="authorization-heading">Authorization and sensitive records</h2>
            <p>WageShield is an evidence organizer, not a law firm, government agency, or filing service.</p>
          </div>
        </div>

        <div className="sensitive-notice">
          <CircleAlert size={18} aria-hidden="true" />
          <div>
            <strong>Employment records can contain highly sensitive information.</strong>
            <p>Before uploading, remove Social Security numbers, bank details, account credentials, and unrelated personal records whenever possible. WageShield never contacts an employer or agency for you.</p>
          </div>
        </div>

        <label
          className={`authorization-check ${fieldErrors.authorizedUseConfirmed ? "has-error" : ""}`}
          htmlFor="authorizedUseConfirmed"
          aria-label="Confirm authorized use of employment records"
        >
          <input
            id="authorizedUseConfirmed"
            name="authorized_use_confirmed"
            type="checkbox"
            checked={values.authorizedUseConfirmed}
            onChange={(event) => update("authorizedUseConfirmed", event.target.checked)}
            aria-invalid={Boolean(fieldErrors.authorizedUseConfirmed)}
            aria-describedby={fieldErrors.authorizedUseConfirmed ? inputErrorId("authorizedUseConfirmed") : "authorization-copy"}
          />
          <span id="authorization-copy">
            <strong>I am authorized to use the records I place in this review.</strong>
            <small>I understand that results are comparison signals requiring human review and are not legal determinations or amounts owed.</small>
          </span>
        </label>
        {fieldErrors.authorizedUseConfirmed && (
          <small className="field-error consent-error" id={inputErrorId("authorizedUseConfirmed")}>{fieldErrors.authorizedUseConfirmed}</small>
        )}
      </section>

      {submitError && (
        <div className="intake-submit-error" role="alert" tabIndex={-1}>
          <CircleAlert size={18} aria-hidden="true" />
          <div>
            <strong>Review not created</strong>
            <p>{submitError}</p>
            {requestId && <small>Support reference: {requestId}</small>}
          </div>
        </div>
      )}

      <div className="intake-submit-row">
        <div>
          <UserRound size={16} aria-hidden="true" />
          <span>This review is private to your signed-in account.</span>
        </div>
        <button className="button button-primary intake-submit" type="submit" disabled={busy}>
          {busy ? (
            <><LoaderCircle className="spin" size={17} aria-hidden="true" /> Creating secure workspace…</>
          ) : (
            <>Create review and add documents <ArrowRight size={17} aria-hidden="true" /></>
          )}
        </button>
      </div>
    </form>
  );
}
