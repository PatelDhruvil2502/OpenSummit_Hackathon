import type { Metadata } from "next";
import { CasesList } from "@/components/cases-list";
import { SiteHeader } from "@/components/site-header";
import { requireChatGPTUser } from "@/app/chatgpt-auth";

export const metadata: Metadata = {
  title: "My reviews",
  description: "Private WageShield evidence reviews owned by your signed-in account.",
};

export const dynamic = "force-dynamic";

export default async function CasesPage({
  searchParams,
}: {
  searchParams: Promise<{ deleted?: string }>;
}) {
  const query = await searchParams;
  const user = await requireChatGPTUser("/cases");
  return (
    <main className="subpage">
      <SiteHeader />
      <section className="cases-hero page-shell">
        <span className="eyebrow">Private workspace</span>
        <h1>My evidence reviews</h1>
        <p>Signed in as {user.email}. Your reviews follow your account across browser sessions and expire automatically.</p>
      </section>
      <section className="page-shell cases-content">
        {query.deleted === "1" && (
          <p className="form-success" role="status">
            The review and its private document/report objects were permanently deleted.
          </p>
        )}
        <CasesList />
      </section>
    </main>
  );
}
