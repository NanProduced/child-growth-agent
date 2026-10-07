import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginPanel } from "@/components/home-v2/login-panel";
import { safeLoginReturn } from "@/lib/accounts/login-return";
import { resolveServerAuth } from "@/lib/accounts/access";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "园所账号登录" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ returnTo?: string }> }) {
  const [auth, search] = await Promise.all([resolveServerAuth(), searchParams]);
  const returnTo = safeLoginReturn(search.returnTo);
  if (auth.state.kind === "authenticated") redirect(returnTo);
  return <div className="mx-auto my-8 max-w-xl"><LoginPanel returnTo={returnTo} /></div>;
}
