import Link from "next/link";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AccountsError } from "@/lib/accounts/errors";

export type ReadFailureKind = "login" | "denied" | "unavailable" | "error";

/** Authorization failures must never be rendered as an ordinary empty list. */
export function readFailureKind(error: unknown): ReadFailureKind {
  if (error instanceof AccountsError) {
    if (error.code === "unauthenticated" || error.code === "account_disabled") return "login";
    if (error.code === "forbidden_role" || error.code === "out_of_scope" || error.code === "empty_scope") return "denied";
    return "unavailable";
  }
  return "error";
}

export function ReadFailureNotice({ kind, what, loginHref = "/login", retryHref, backHref = "/" }: {
  kind: ReadFailureKind;
  what: string;
  loginHref?: string;
  retryHref: string;
  backHref?: string;
}) {
  const copy = kind === "login"
    ? { title: "请先登录园所账号", text: `请用园所账号查看${what}。账号已停用时，请联系管理员。` }
    : kind === "denied"
      ? { title: "当前账号没有访问权限", text: `当前账号不能查看${what}，请联系园所管理员。` }
      : kind === "unavailable"
        ? { title: "暂时无法核对账号", text: `现在不能确认账号权限，${what}暂时无法显示。请稍后重试。` }
        : { title: "资料暂时无法查看", text: `${what}加载失败，请稍后重试。` };
  return (
    <section data-platform-surface="read-failure" role="alert" className="mx-auto max-w-2xl space-y-5 py-8">
      <Alert variant="destructive">
        <AlertTitle><h1>{copy.title}</h1></AlertTitle>
        <AlertDescription>{copy.text}</AlertDescription>
      </Alert>
      <div className="flex flex-wrap gap-3">
        {kind === "login" ? (
          <Button asChild className="min-h-11"><Link href={loginHref}>园所账号登录</Link></Button>
        ) : (
          <Button asChild className="min-h-11"><Link href={retryHref}>重新读取</Link></Button>
        )}
        <Button asChild variant="outline" className="min-h-11"><Link href={backHref}>返回首页</Link></Button>
      </div>
    </section>
  );
}
