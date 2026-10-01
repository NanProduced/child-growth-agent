import { Badge } from "@/components/ui/badge";
import { Sparkles } from "lucide-react";
import type { ObservationStatus } from "@/lib/types";

export function StatusBadge({ status, compact = false }: { status: ObservationStatus; compact?: boolean }) {
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
        {compact ? '待确认' : 'AI 已整理 · 待确认'}
      </Badge>
    );
  }
  if (status === "needs_input") {
    return (
      <Badge variant="secondary" className="bg-rose-100 text-rose-700">
        待补充信息
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="bg-sky-100 text-sky-700">
      已保存 · 待判断
    </Badge>
  );
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
