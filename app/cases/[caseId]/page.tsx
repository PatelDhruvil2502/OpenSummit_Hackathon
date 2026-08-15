import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireChatGPTUser } from "@/app/chatgpt-auth";
import { CaseWorkspace } from "@/components/case-workspace";
import { getCase } from "@/lib/storage";

export const metadata: Metadata = {
  title: "Evidence workspace",
  description: "Review documents, facts, calculations, sources, and a user-controlled evidence report.",
};

export const dynamic = "force-dynamic";

async function ProtectedCaseWorkspace({ caseId }: { caseId: string }) {
  const user = await requireChatGPTUser(`/cases/${encodeURIComponent(caseId)}`);
  const caseData = await getCase(caseId, user.userId);
  if (!caseData) notFound();
  return <CaseWorkspace caseId={caseId} />;
}

export default async function CasePage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  return <ProtectedCaseWorkspace caseId={caseId} />;
}
