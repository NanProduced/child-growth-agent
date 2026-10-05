import type { Metadata } from "next";
import { withBusinessRead, AccountsError } from "@/lib/auth";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import type { Principal } from "@/lib/accounts/types";
import { Button } from "@/components/ui/button";
import { EvidenceRouteClient } from "@/components/guide/evidence-route-client";
import { EvidenceReadError } from "@/components/guide/evidence-read-error";
import { loadChildEvidenceBook } from "@/lib/guide/read-model";
import { evidencePageHref, evidencePageQuery, type EvidencePageSearch } from "@/lib/guide/navigation";
import { guideAccessForChild } from "@/lib/guide/write-access-rules";
import { listSemesters } from "@/lib/semester";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "个人指南证据册" };

export default async function ChildEvidencePage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<EvidencePageSearch>;
}) {
  const [{ id }, search] = await Promise.all([params, searchParams]);
  const backHref = `/children/${encodeURIComponent(id)}`;
  const retryHref = evidencePageHref(`${backHref}/evidence`, search);
  let loaded: { principal: Principal; result: Awaited<ReturnType<typeof loadChildEvidenceBook>> };
  try {
    loaded = await withBusinessRead(undefined, "child.read", { kind: "child", child_id: id }, async (principal) => ({
      principal,
      result: await loadChildEvidenceBook(id, evidencePageQuery(search)),
    }));
  } catch (error) {
    if (error instanceof AccountsError) {
      if (error.code === "not_found") notFound();
      throw error;
    }
    return <EvidenceReadError backHref={backHref} retryHref={retryHref} message="暂时无法读取观察证据。请重新读取；读取失败不代表没有相关记录。" />;
  }
  const { principal, result } = loaded;
  if (!result.ok) {
    if (result.failure.status === 404) notFound();
    return <EvidenceReadError backHref={backHref} retryHref={retryHref} resetHref={`${backHref}/evidence?scope=all_history`} message={result.failure.message} />;
  }
  const itemValue = search.item_id;
  const itemId = Array.isArray(itemValue) ? itemValue[0] : itemValue;
  // 写入口按同一份服务端授权解析出的 Principal 与幼儿归属判定；隐藏 UI 不替代服务端授权
  const writeAccess = guideAccessForChild(
    { kind: "principal", principal },
    { id: result.value.child.id, current_class_id: result.value.child.class_id },
  );
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
