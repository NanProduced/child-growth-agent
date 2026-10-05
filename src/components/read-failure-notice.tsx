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
    ? { title: "请先登录园所账号", text: `当前登录已失效或账号已停用，${what}尚未加载；这不代表没有记录。` }
    : kind === "denied"
      ? { title: "当前账号没有访问权限", text: `不能查看${what}；无权限或任教范围为空不等于没有数据。如有疑问请联系管理员。` }
      : kind === "unavailable"
        ? { title: "资料服务暂时不可用", text: `身份或${what}读取暂未完成，不能据此判断为空。请稍后重新读取。` }
        : { title: "资料暂时不可读", text: `${what}读取失败，不代表没有数据。请稍后重新读取。` };
  return (
    <section role="alert" className="mx-auto max-w-2xl space-y-5 py-8">
      <Alert variant="destructive">
        <AlertTitle>{copy.title}</AlertTitle>
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
