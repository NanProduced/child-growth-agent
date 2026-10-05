import type { Metadata } from "next";
import Link from "next/link";
import { TeacherManagement, type TeacherClass } from "@/components/accounts/teacher-management";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { withBusinessRead } from "@/lib/accounts/access";
import { AccountsError } from "@/lib/accounts/errors";
import { listTeachers } from "@/lib/accounts/repository";
import { listClasses } from "@/lib/queries";
import type { TeacherAccountSummary } from "@/lib/accounts/types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "教师管理" };

export default async function TeachersPage() {
  let data: { adminAccountId: string; teachers: TeacherAccountSummary[]; classes: TeacherClass[] };
  try {
    // The fresh administrator guard runs before either directory is read.
    data = await withBusinessRead(undefined, "teacher.manage", { kind: "school" }, async (principal) => {
      // Already inside the fresh administrator read: these queries reuse its single client.
      // Opening another scoped transaction here can starve the five-client pool during prefetch.
      const [teachers, classes] = await Promise.all([listTeachers(), listClasses()]);
      return { adminAccountId: principal.account_id, teachers, classes };
    });
  } catch (error: unknown) {
    const code = error instanceof AccountsError ? error.code : null;
    const needsLogin = code === "unauthenticated" || code === "account_disabled";
    const denied = code === "forbidden_role" || code === "empty_scope" || code === "out_of_scope";
    return (
      <section className="mx-auto max-w-3xl space-y-5 py-6">
        <h1 className="text-2xl font-semibold">教师管理</h1>
        <Alert variant="destructive">
          <AlertTitle>{needsLogin ? "请先登录管理员账号" : denied ? "仅管理员可管理教师" : "教师资料暂不可读"}</AlertTitle>
          <AlertDescription>
            {needsLogin ? "当前登录已失效或账号已停用。请使用有效的管理员账号登录。" : denied
              ? "教师账号不能查看或调整其他教师的账号与任教关系。"
              : "身份或资料读取暂未完成，不能据此判断教师名单为空。请稍后重新读取。"}
          </AlertDescription>
        </Alert>
        <div className="flex flex-wrap gap-3">
          {needsLogin ? <Button asChild className="min-h-11"><Link href="/login?returnTo=%2Fadmin%2Fteachers">管理员登录</Link></Button>
            : !denied ? <Button asChild className="min-h-11"><Link href="/admin/teachers">重新读取</Link></Button> : null}
          <Button asChild variant="outline" className="min-h-11"><Link href="/">返回首页</Link></Button>
        </div>
      </section>
    );
  }
  return <TeacherManagement adminAccountId={data.adminAccountId} initialTeachers={data.teachers}
    initialClasses={data.classes.map(({ id, name, stage, school_year, is_active }) => ({ id, name, stage, school_year, is_active }))} />;
}
