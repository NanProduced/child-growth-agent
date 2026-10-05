import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EvidenceRouteClient } from "@/components/guide/evidence-route-client";
import { EvidenceReadError } from "@/components/guide/evidence-read-error";
import { loadClassEvidenceOverview } from "@/lib/guide/read-model";
import { evidencePageHref, evidencePageQuery, type EvidencePageSearch } from "@/lib/guide/navigation";
import { resolveClassWriteAccess } from "@/lib/guide/write-access";
import { listSemesters } from "@/lib/semester";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "班级指南证据概览" };

export default async function ClassEvidencePage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<EvidencePageSearch>;
}) {
  const [{ id }, search] = await Promise.all([params, searchParams]);
  const backHref = `/classes/${encodeURIComponent(id)}`;
  const retryHref = evidencePageHref(`${backHref}/evidence`, search);
  let result: Awaited<ReturnType<typeof loadClassEvidenceOverview>>;
  try {
    result = await loadClassEvidenceOverview(id, evidencePageQuery(search));
  } catch {
    return <EvidenceReadError backHref={backHref} retryHref={retryHref} message="暂时无法读取班级证据。请重新读取；读取失败不代表统计为零。" />;
  }
  if (!result.ok) {
    if (result.failure.status === 404) notFound();
    return <EvidenceReadError backHref={backHref} retryHref={retryHref} resetHref={`${backHref}/evidence?scope=all_history`} message={result.failure.message} />;
  }
  // 写入口按当前名单逐人判定（原班历史只读、无权限与管理员不出现记录控件）
  const writeAccess = await resolveClassWriteAccess(result.value.roster.children);
  return (
    <div className="space-y-5">
      <Button asChild variant="ghost" className="-ml-2 min-h-11"><Link href={backHref}><ArrowLeft className="size-4" />返回班级详情</Link></Button>
      <EvidenceRouteClient
        audience="class"
        data={result.value}
        semesters={listSemesters()}
        canRecordByChild={writeAccess.record_by_child}
      />
    </div>
  );
}
