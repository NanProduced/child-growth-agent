import type { Metadata } from "next";
import { withBusinessRead, AccountsError } from "@/lib/auth";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EvidenceRouteClient } from "@/components/guide/evidence-route-client";
import { EvidenceReadError } from "@/components/guide/evidence-read-error";
import { loadClassEvidenceOverview } from "@/lib/guide/read-model";
import { evidencePageHref, evidencePageQuery, type EvidencePageSearch } from "@/lib/guide/navigation";
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
    result = await withBusinessRead(undefined, "class.read", { kind: "class", class_id: id }, () => loadClassEvidenceOverview(id, evidencePageQuery(search)));
  } catch (error) {
    if (error instanceof AccountsError) {
      if (error.code === "not_found") notFound();
      throw error;
    }
    return <EvidenceReadError backHref={backHref} retryHref={retryHref} message="暂时无法读取班级证据。请重新读取；读取失败不代表统计为零。" />;
  }
  if (!result.ok) {
    if (result.failure.status === 404) notFound();
    return <EvidenceReadError backHref={backHref} retryHref={retryHref} resetHref={`${backHref}/evidence?scope=all_history`} message={result.failure.message} />;
  }
  return (
    <div className="space-y-5">
      <Button asChild variant="ghost" className="-ml-2 min-h-11"><Link href={backHref}><ArrowLeft className="size-4" />返回班级详情</Link></Button>
      <EvidenceRouteClient audience="class" data={result.value} semesters={listSemesters()} />
    </div>
  );
}
