import { Badge } from "@/components/ui/badge";
import { Sparkles } from "lucide-react";
import type { ObservationStatus } from "@/lib/types";

export function StatusBadge({ status }: { status: ObservationStatus }) {
  if (status === "confirmed") {
    return (
      <Badge variant="secondary" className="bg-emerald-100 text-emerald-700">
        已确认归档
      </Badge>
    );
  }
  if (status === "ai_organized") {
    return (
      <Badge variant="secondary" className="bg-amber-100 text-amber-700">
        AI 已整理 · 待确认
      </Badge>
    );
  }
  return <Badge variant="secondary">待 AI 整理</Badge>;
}

/** 按参赛要求：所有 AI 生成的可见内容需明确标记 */
export function AiBadge() {
  return (
    <Badge
      variant="outline"
      className="border-violet-300 bg-violet-50 text-violet-700"
      title="此内容由 AI 生成，教师确认前仅作为草稿"
    >
      <Sparkles className="size-3" />
      AI 生成
    </Badge>
  );
}

export function DemoBadge() {
  return (
    <Badge
      variant="outline"
      className="border-slate-300 bg-slate-50 text-slate-500"
      title="演示用合成数据，非真实幼儿信息"
    >
      合成数据
    </Badge>
  );
}
