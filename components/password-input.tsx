"use client";

import type { ComponentPropsWithoutRef } from "react";
import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

type PasswordInputProps = Omit<ComponentPropsWithoutRef<"input">, "type"> & {
  visibilityLabel?: string;
};

export function PasswordInput({
  visibilityLabel = "password",
  ...inputProps
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const action = visible ? "Hide" : "Show";
  const accessibleLabel = `${action} ${visibilityLabel}`;

  return (
    <div className="password-input">
      <input {...inputProps} type={visible ? "text" : "password"} />
      <button
        className="password-visibility-button"
        type="button"
        aria-controls={inputProps.id}
        aria-label={accessibleLabel}
        aria-pressed={visible}
        title={accessibleLabel}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
      </button>
    </div>
  );
}
