"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import { Download, LoaderCircle, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";

interface ErrorPayload {
  error?: { message?: string };
}

export function AccountDataControls({ canDelete }: { canDelete: boolean }) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  async function deleteAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !window.confirm(
        "Permanently delete this account and every retained review, document, and report? This cannot be undone.",
      )
    ) {
      return;
    }
    setDeleting(true);
    setError("");
    try {
      const response = await fetch("/api/auth/account", {
        method: "POST",
        body: new FormData(event.currentTarget),
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const payload = (await response.json().catch(() => ({}))) as ErrorPayload;
      if (!response.ok) {
        setError(payload.error?.message ?? "Account deletion could not be completed.");
        return;
      }
      router.replace("/?account_deleted=1");
      router.refresh();
    } catch {
      setError("Account deletion could not be completed. Check your connection and retry.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="account-data-controls" aria-labelledby="account-data-title">
      <div>
        <span className="eyebrow">Your data</span>
        <h2 id="account-data-title">Export or erase</h2>
        <p>
          Download a structured JSON copy of the account and every unexpired review currently
          retained by WageShield.
        </p>
        <a className="button button-secondary button-full" href="/api/auth/export" download>
          <Download size={16} /> Download my data
        </a>
      </div>

      {canDelete ? (
        <form className="account-delete-form" onSubmit={deleteAccount}>
          <h3>Delete account permanently</h3>
          <p id="account-delete-help">
            This verifies removal of retained review objects from the live service, removes the
            local account, and signs out every session. An opaque deletion lock remains to prevent
            stale requests from recreating data. Processor recovery copies age out under the
            backup window disclosed in the Privacy policy.
          </p>
          <label htmlFor="delete-current-password">Current password</label>
          <input
            id="delete-current-password"
            name="current_password"
            type="password"
            autoComplete="current-password"
            maxLength={128}
            required
          />
          <label htmlFor="delete-confirmation">Type DELETE to confirm</label>
          <input
            id="delete-confirmation"
            name="confirmation"
            type="text"
            autoComplete="off"
            pattern="DELETE"
            aria-describedby="account-delete-help"
            required
          />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="button button-danger button-full" type="submit" disabled={deleting}>
            {deleting ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
            {deleting ? "Verifying deletion…" : "Delete account and all data"}
          </button>
        </form>
      ) : (
        <p className="account-managed-note">
          This sign-in is managed by the trusted host. Delete each WageShield review from its
          Privacy tab, and use the host provider’s controls for the identity itself.
        </p>
      )}
    </section>
  );
}
