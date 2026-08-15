import Link from "next/link";
import { ShieldCheck } from "lucide-react";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="brand" aria-label="WageShield H-1B home">
      <span className="brand-mark" aria-hidden="true">
        <ShieldCheck size={compact ? 18 : 21} strokeWidth={1.8} />
      </span>
      <span className="brand-copy">
        <strong>WageShield</strong>
        {!compact && <small>H-1B evidence review</small>}
      </span>
    </Link>
  );
}
