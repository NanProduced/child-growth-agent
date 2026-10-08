"use client";

/**
 * 芽芽特殊消息卡：来源 / 澄清 / 查询 / 停止 / 未知 / 回执 / 历史状态。
 *
 * 回执与成功文案只信服务端证明：receiptProvesSuccess 不成立时不显示"已保存"；
 * 未安装成功图标；头像勾只表示平台操作回执，不代表幼儿发展结论。
 */
import { useState } from "react";
import type { DataMessagePartProps } from "@assistant-ui/react";
import { AlertTriangle, BookOpen, Check, ChevronDown, Clock, Info, RefreshCw, Search, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { YayaOperationQueryOutcome, YayaSourceRef } from "@/lib/yaya/types";

import { lookupOriginalRun, queryOriginalOperation, reconcileOriginalOperationQuery } from "./client/actions";
import type {
  YayaClarifyPartData,
  YayaHistoryNotePartData,
  YayaHistoryStatePartData,
  YayaReceiptPartData,
  YayaRunErrorPartData,
  YayaSearchRefusedPartData,
  YayaSourcesPartData,
  YayaStoppedPartData,
  YayaToolResultPartData,
} from "./client/parts";
import { receiptShowsSuccess } from "./client/adapters";
import { YayaMarkdown } from "./yaya-markdown";

function CardShell({
  tone,
  icon,
  title,
  children,
  className,
  dataAttr,
}: {
  tone: "neutral" | "amber" | "rose" | "emerald" | "sky";
  icon: React.ReactNode;
  title: string;
  children?: React.ReactNode;
  className?: string;
  dataAttr?: string;
}) {
  const toneClass = {
    neutral: "border-border",
    amber: "border-amber-200/70",
    rose: "border-rose-200/70",
    emerald: "border-emerald-200/70",
    sky: "border-border",
  }[tone];
  const iconClass = {
    neutral: "text-muted-foreground",
    amber: "text-amber-700",
    rose: "text-rose-700",
    emerald: "text-emerald-700",
    sky: "text-sky-700",
  }[tone];
  return (
    <div
      className={cn("py-2 text-base leading-[1.65] text-foreground sm:text-sm", (dataAttr === "receipt" || dataAttr === "run-error") && "rounded-xl border bg-card p-4", toneClass, className)}
      data-yaya-card={dataAttr}
    >
      <div className="flex items-start gap-2">
        <span className={cn("mt-0.5 shrink-0", iconClass)} aria-hidden>
          {icon}
        </span>
        <div className="min-w-0 flex-1 space-y-2 [overflow-wrap:anywhere]">
          <p className="font-semibold text-foreground">{title}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

const SOURCE_KIND_LABEL: Record<string, string> = {
  raw_input: "教师输入",
  child_fact: "已保存观察",
  teacher_supplement: "教师补充",
  image_interpretation: "图片解读",
  guide_catalog: "指南参考",
  public_web: "公开资料",
  tool_result: "平台查询",
  model_text: "模型生成",
};

export function YayaSourcesPart({ data }: DataMessagePartProps<YayaSourcesPartData>) {
  const sources: readonly YayaSourceRef[] = data.sources;
  if (sources.length === 0) return null;
  return (
    <details className="group text-sm leading-6 text-muted-foreground" data-yaya-sources>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary [&::-webkit-details-marker]:hidden">
        <BookOpen className="size-4" aria-hidden />参考来源 · {sources.length} 项
        <ChevronDown className="ml-auto size-4 transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden />
      </summary>
      <ul className="space-y-2 px-2 pb-2 [overflow-wrap:anywhere]">
        {sources.map((source, index) => (
          <li key={`${source.kind}-${index}`}>
            {SOURCE_KIND_LABEL[source.kind] ?? source.kind}
            {source.label !== null && source.label !== "" ? ` · ${source.label}` : ""}
            {source.ref_id !== null ? <span className="block text-xs">来源标识：{source.ref_id}</span> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function YayaClarifyPart({ data }: DataMessagePartProps<YayaClarifyPartData>) {
  return (
    <CardShell
      tone="sky"
      icon={<Info className="size-4" />}
      title="需要你补充信息"
      dataAttr="clarify"
    >
      <p className="whitespace-pre-wrap text-foreground">{data.question}</p>
      <p className="text-xs text-muted-foreground">直接在下面回复补充内容即可继续整理。</p>
    </CardShell>
  );
}

const TOOL_LABELS = new Map([
  ["list_children", "幼儿名册"], ["list_classes", "班级列表"], ["get_class", "班级资料"],
  ["resolve_child_class", "幼儿班级归属"], ["list_observations", "观察记录"], ["get_observation", "观察详情"],
  ["get_child_growth_profile", "成长小结"], ["get_child_evidence_book", "个人证据册"],
  ["get_class_evidence_overview", "班级证据概览"], ["list_guide_items", "指南目录"],
  ["get_guide_item", "指南条目"], ["list_education_suggestions", "教育建议"], ["list_teacher_accounts", "教师账号"],
]);

export function YayaToolResultPart({ data }: DataMessagePartProps<YayaToolResultPartData>) {
  return (
    <p className="flex items-center gap-2 py-1 text-sm text-muted-foreground" data-yaya-tool-result data-tool-name={data.tool}>
      <Search className="size-3.5" aria-hidden />
      {data.outcome === "ok" ? "已查询" : "查询未完成"} · {TOOL_LABELS.get(data.tool) ?? "平台资料"}
    </p>
  );
}

export function YayaSearchRefusedPart({ data }: DataMessagePartProps<YayaSearchRefusedPartData>) {
  const reason =
    data.reason === "provider_disabled"
      ? "公开检索未开通"
      : data.reason === "identifiers_present"
        ? "输入包含幼儿信息，未发送到公开网络"
        : "无法确认是否包含幼儿信息，已按保守策略跳过";
  return (
    <p className="text-xs text-muted-foreground" data-yaya-search-refused>
      公开检索未执行：{reason}。
    </p>
  );
}

export function YayaStoppedPart({ data }: DataMessagePartProps<YayaStoppedPartData>) {
  const cancelled = data.reason === "cancelled";
  return (
    <CardShell
      tone={cancelled ? "neutral" : "amber"}
      icon={<Square className="size-3.5" />}
      title={cancelled ? "已停止回答" : "这次整理已停止"}
      dataAttr="stopped"
    >
      <p className="text-foreground/90">{data.detail ?? "这次整理没有继续完成。"}</p>
      <p className="text-xs text-muted-foreground">
        {cancelled ? "输入还在，可以修改后重新发送。" : "没有明确回执前不会显示“已保存”。"}
      </p>
    </CardShell>
  );
}

function outcomeHeadline(outcome: YayaOperationQueryOutcome): { tone: "amber" | "rose" | "emerald" | "neutral"; title: string } {
  switch (outcome.kind) {
    case "in_progress":
      return { tone: "neutral", title: "此操作仍在进行中" };
    case "failed":
      return outcome.effect === "none"
        ? { tone: "rose", title: "没有完成，且已确认无提交效果" }
        : { tone: "amber", title: "执行失败，但可能已有提交效果" };
    case "conflict":
      return { tone: "amber", title: "前提已变化，需要重新核对" };
    case "saved":
      return receiptShowsSuccess(outcome)
        ? { tone: "emerald", title: "操作已保存" }
        : { tone: "amber", title: "回执缺少完整成功证明" };
    case "saved_detail_unavailable":
      return receiptShowsSuccess(outcome)
        ? { tone: "emerald", title: "已保存，详情暂不可读" }
        : { tone: "amber", title: "回执缺少完整成功证明" };
    default:
      return { tone: "amber", title: "保存结果未知，按原操作核对" };
  }
}

export function YayaReceiptPart({ data }: DataMessagePartProps<YayaReceiptPartData>) {
  const expectedPlan = data.expected_plan ?? null;
  const [outcome, setOutcome] = useState<YayaOperationQueryOutcome>(
    reconcileOriginalOperationQuery(
      data.operation_id,
      { operation_id: data.operation_id, outcome: data.outcome },
      expectedPlan
    ).outcome
  );
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const headline = outcomeHeadline(outcome);
  const isSuccess = receiptShowsSuccess(outcome);
  const receipt =
    outcome.kind === "saved" || outcome.kind === "saved_detail_unavailable" ? outcome.receipt : null;

  const recheck = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const result = await queryOriginalOperation(data.operation_id, expectedPlan);
      setOutcome(result.outcome);
    } catch {
      setCheckError("读取暂未完成，这不代表没有数据；未显示成功。");
    } finally {
      setChecking(false);
    }
  };

  return (
    <CardShell
      tone={headline.tone}
      icon={isSuccess ? <Check className="size-4" /> : outcome.kind === "in_progress" ? <Clock className="size-4" /> : <AlertTriangle className="size-4" />}
      title={headline.title}
      dataAttr="receipt"
    >
      {receipt !== null ? (
        <p className="text-xs tabular-nums text-muted-foreground">
          记录时间：{receipt.recorded_at}
        </p>
      ) : null}
      <details className="text-xs leading-5 text-muted-foreground">
        <summary className="min-h-11 cursor-pointer content-center rounded-lg px-1 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">查看原操作审计标识</summary>
        <div className="space-y-1 pb-2 [overflow-wrap:anywhere]">
          <p>原操作：{data.operation_id}</p>
          {receipt !== null ? <p>业务对象：{receipt.business_object_id ?? "—"}</p> : null}
        </div>
      </details>
      {outcome.kind === "unknown" ? (
        <p className="text-sm text-muted-foreground">
          {outcome.reason === "verification_required"
            ? "当前消息没有完整原计划，不能证明成功；请从待核对提案入口读取。"
            : "不会自动重复提交，也不会重新发起新提案。"}
        </p>
      ) : null}
      {outcome.kind !== "saved" && outcome.kind !== "saved_detail_unavailable" ? (
        <Button type="button" variant="outline" size="sm" className="h-11 rounded-xl shadow-none" onClick={() => void recheck()} disabled={checking}>
          <RefreshCw className={cn("size-3.5", checking && "animate-spin motion-reduce:animate-none")} aria-hidden />
          {checking ? "正在读取…" : "重新读取核对"}
        </Button>
      ) : null}
      {checkError !== null ? <p role="alert" className="text-sm text-rose-700">{checkError}</p> : null}
      {isSuccess ? (
        <p className="text-xs text-muted-foreground">
          保存状态来自平台操作回执，不表示幼儿发展达标。
        </p>
      ) : null}
    </CardShell>
  );
}

export function YayaRunErrorPart({ data }: DataMessagePartProps<YayaRunErrorPartData>) {
  const [status, setStatus] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const canLookup =
    typeof data.client_request_id === "string" &&
    data.client_request_id !== "" &&
    typeof data.conversation_id === "string" &&
    data.conversation_id !== "";
  const notWired = data.stage === "not_wired";
  const restricted = data.status === 403;

  const lookup = async () => {
    if (!canLookup || typeof data.client_request_id !== "string" || typeof data.conversation_id !== "string") return;
    setChecking(true);
    try {
      const result = await lookupOriginalRun(data.conversation_id, data.client_request_id);
      if (result === null) {
        setStatus("原运行查询未接通或返回无效；仍按未知处理。");
      } else if (result.status === "missing") {
        setStatus("没有找到原运行；可以修改后重新发送（不会自动重发）。");
      } else if (result.status === "in_progress") {
        setStatus("原运行仍在进行中，请稍后再读取核对。");
      } else if (result.status === "finished") {
        setStatus(
          result.outcome.kind === "answered"
            ? "原运行已完成，回答可从原会话历史读取。"
            : "原运行已结束；请在会话中重新核对结果。"
        );
      } else if (result.status === "unverifiable") {
        setStatus("原运行身份无法核验，不显示成功，也不重发。");
      } else {
        setStatus("服务暂时不可用；这不代表没有数据。");
      }
    } catch {
      setStatus("读取暂未完成，这不代表没有数据。");
    } finally {
      setChecking(false);
    }
  };

  return (
    <CardShell
      tone={restricted ? "neutral" : "rose"}
      icon={<AlertTriangle className="size-4" />}
      title={notWired ? "AI 整理服务尚未接通" : restricted ? "这段内容当前不可用" : "这次请求没有完成"}
      dataAttr="run-error"
    >
      <p className="text-foreground/90">{data.message}</p>
      {data.detail !== null && data.detail !== "" ? (
        <details className="text-xs text-muted-foreground">
          <summary className="min-h-11 cursor-pointer content-center rounded-lg px-1 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">查看校验详情</summary>
          <p className="pb-2 [overflow-wrap:anywhere]">协议校验：{data.detail}</p>
        </details>
      ) : null}
      <p className="text-xs text-muted-foreground">没有明确回执前不会显示“已保存”。</p>
      {canLookup ? (
        <Button type="button" variant="outline" size="sm" className="h-11 rounded-xl shadow-none" onClick={() => void lookup()} disabled={checking}>
          <RefreshCw className={cn("size-3.5", checking && "animate-spin motion-reduce:animate-none")} aria-hidden />
          {checking ? "正在读取…" : "重新读取核对"}
        </Button>
      ) : null}
      {status !== null ? <p role="status" className="text-sm text-muted-foreground">{status}</p> : null}
    </CardShell>
  );
}

export function YayaHistoryStatePart({ data }: DataMessagePartProps<YayaHistoryStatePartData>) {
  return (
    <CardShell
      tone={data.execution_state === "pending_approval" ? "amber" : "neutral"}
      icon={<Clock className="size-4" />}
      title="历史操作标记"
      dataAttr="history-state"
    >
      <p className="text-foreground/90">{data.text}</p>
    </CardShell>
  );
}

export function YayaHistoryNotePart({ data }: DataMessagePartProps<YayaHistoryNotePartData>) {
  return (
    <p className="text-xs text-muted-foreground" data-yaya-history-note>
      {data.text}
    </p>
  );
}

export { YayaMarkdown };
