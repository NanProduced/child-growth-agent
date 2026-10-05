import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EvidenceRouteClient } from "@/components/guide/evidence-route-client";
import { EvidenceReadError } from "@/components/guide/evidence-read-error";
import { loadChildEvidenceBook } from "@/lib/guide/read-model";
import { evidencePageHref, evidencePageQuery, type EvidencePageSearch } from "@/lib/guide/navigation";
import { resolveChildWriteAccess } from "@/lib/guide/write-access";
import { listSemesters } from "@/lib/semester";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "个人指南证据册" };

export default async function ChildEvidencePage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<EvidencePageSearch>;
}) {
  const [{ id }, search] = await Promise.all([params, searchParams]);
  const backHref = `/children/${encodeURIComponent(id)}`;
  const retryHref = evidencePageHref(`${backHref}/evidence`, search);
  let result: Awaited<ReturnType<typeof loadChildEvidenceBook>>;
  try {
    result = await loadChildEvidenceBook(id, evidencePageQuery(search));
  } catch {
    return <EvidenceReadError backHref={backHref} retryHref={retryHref} message="暂时无法读取观察证据。请重新读取；读取失败不代表没有相关记录。" />;
  }
  if (!result.ok) {
    if (result.failure.status === 404) notFound();
    return <EvidenceReadError backHref={backHref} retryHref={retryHref} resetHref={`${backHref}/evidence?scope=all_history`} message={result.failure.message} />;
  }
  const itemValue = search.item_id;
  const itemId = Array.isArray(itemValue) ? itemValue[0] : itemValue;
  // 写入口按当前会话与服务端读取的幼儿归属解析；隐藏 UI 不替代服务端授权
  const writeAccess = await resolveChildWriteAccess(result.value.child);
  return (
    <div className="space-y-5">
      <Button asChild variant="ghost" className="-ml-2 min-h-11"><Link href={backHref}><ArrowLeft className="size-4" />返回成长档案</Link></Button>
      <EvidenceRouteClient
        audience="child"
        data={result.value}
        semesters={listSemesters()}
        focusedItemId={itemId}
        canRecordObservation={writeAccess.can_record}
      />
    </div>
  );
}
