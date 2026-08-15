import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAccountFromCookie } from "@/lib/accounts";
import {
  getUserFromHeaders,
  signInPath,
  signOutPath,
  type AuthenticatedUser,
} from "@/lib/identity";

export type ChatGPTUser = AuthenticatedUser;

export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const requestHeaders = await headers();
  return (
    getUserFromHeaders(requestHeaders) ??
    (await getAccountFromCookie(requestHeaders.get("cookie")))
  );
}

export async function requireChatGPTUser(returnTo: string): Promise<ChatGPTUser> {
  const requestHeaders = await headers();
  const user =
    getUserFromHeaders(requestHeaders) ??
    (await getAccountFromCookie(requestHeaders.get("cookie")));
  if (user) return user;
  redirect(signInPath(requestHeaders, returnTo));
}

export async function getSignInPath(returnTo: string): Promise<string> {
  return signInPath(await headers(), returnTo);
}

export function getSignOutPath(user: ChatGPTUser, returnTo = "/"): string {
  return signOutPath(user, returnTo);
}
