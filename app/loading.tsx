import { LoaderCircle } from "lucide-react";
import { Brand } from "@/components/brand";

export default function Loading() {
  return (
    <main className="auth-page" aria-busy="true">
      <section className="auth-card" aria-live="polite" aria-label="Loading WageShield">
        <Brand />
        <div className="auth-icon" aria-hidden="true">
          <LoaderCircle size={24} />
        </div>
        <span className="eyebrow">Loading</span>
        <h1>Opening your private workspace</h1>
        <p>WageShield is retrieving the latest review state.</p>
      </section>
    </main>
  );
}
