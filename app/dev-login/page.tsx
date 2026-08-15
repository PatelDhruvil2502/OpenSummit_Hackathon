import { redirect } from "next/navigation";
import { accountSignInPath, safeRelativeReturnPath } from "@/lib/identity";

export const dynamic = "force-dynamic";

export default async function DevelopmentLoginRedirect({
  searchParams,
}: {
  searchParams: Promise<{ return_to?: string }>;
}) {
  const query = await searchParams;
  redirect(accountSignInPath(safeRelativeReturnPath(query.return_to)));
}
