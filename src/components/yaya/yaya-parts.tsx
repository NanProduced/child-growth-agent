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
  model_text: "AI 生成",
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
      title="还需要一点信息"
      dataAttr="clarify"
    >
      <p className="whitespace-pre-wrap text-foreground">{data.question}</p>
      <p className="text-xs text-muted-foreground">在输入框里回复即可。</p>
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
      ? "暂时不能联网查询。"
      : data.reason === "identifiers_present"
        ? "为保护幼儿信息，这次没有联网查询。"
        : "暂时无法确认内容能否公开，这次没有联网查询。";
  return (
    <p className="text-xs text-muted-foreground" data-yaya-search-refused>
      {reason}
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
        {cancelled ? "停止回答不会撤销已经保存的内容。" : "如涉及保存，请先核对这次操作的结果。"}
      </p>
    </CardShell>
  );
}

function outcomeHeadline(outcome: YayaOperationQueryOutcome): { tone: "amber" | "rose" | "emerald" | "neutral"; title: string } {
  switch (outcome.kind) {
    case "in_progress":
      return { tone: "neutral", title: "仍在处理中" };
    case "failed":
      return outcome.effect === "none"
        ? { tone: "rose", title: "这次操作未保存" }
        : { tone: "amber", title: "操作未完成，保存结果待核对" };
    case "conflict":
      return { tone: "amber", title: "相关信息有变化，请重新核对" };
    case "saved":
      return receiptShowsSuccess(outcome)
        ? { tone: "emerald", title: "已保存" }
        : { tone: "amber", title: "保存结果还无法确认" };
    case "saved_detail_unavailable":
      return receiptShowsSuccess(outcome)
        ? { tone: "emerald", title: "已保存，暂时读不到详情" }
        : { tone: "amber", title: "保存结果还无法确认" };
    default:
      return { tone: "amber", title: "保存结果待核对" };
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
      setCheckError("暂时读不到保存结果，请稍后再核对。");
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
        <summary className="min-h-11 cursor-pointer content-center rounded-lg px-1 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">查看操作信息</summary>
        <div className="space-y-1 pb-2 [overflow-wrap:anywhere]">
          <p>原操作：{data.operation_id}</p>
          {receipt !== null ? <p>业务对象：{receipt.business_object_id ?? "—"}</p> : null}
        </div>
      </details>
      {outcome.kind === "unknown" ? (
        <p className="text-sm text-muted-foreground">
          {outcome.reason === "verification_required"
            ? "这条结果信息不完整，请回到操作卡核对。"
            : "只检查上次保存，不会自动重复提交。"}
        </p>
      ) : null}
      {outcome.kind !== "saved" && outcome.kind !== "saved_detail_unavailable" ? (
        <Button type="button" variant="outline" size="sm" className="h-11 rounded-xl shadow-none" onClick={() => void recheck()} disabled={checking}>
          <RefreshCw className={cn("size-3.5", checking && "animate-spin motion-reduce:animate-none")} aria-hidden />
          {checking ? "正在核对…" : "核对保存结果"}
        </Button>
      ) : null}
      {checkError !== null ? <p role="alert" className="text-sm text-rose-700">{checkError}</p> : null}
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
        setStatus("暂时无法确认上次请求的结果，请稍后再检查。");
      } else if (result.status === "missing") {
        setStatus("没有找到上次请求；不会自动重发，请先核对已有记录。");
      } else if (result.status === "in_progress") {
        setStatus("上次请求仍在处理中，请稍后再检查。");
      } else if (result.status === "finished") {
        setStatus(
          result.outcome.kind === "answered"
            ? "上次回答已完成，可在会话历史中查看。"
            : "上次请求已结束，请回到会话核对结果。"
        );
      } else if (result.status === "unverifiable") {
        setStatus("上次请求暂时无法核对，不会自动重发。");
      } else {
        setStatus("暂时无法读取上次结果，请稍后再试。");
      }
    } catch {
      setStatus("暂时无法读取上次结果，请稍后再试。");
    } finally {
      setChecking(false);
    }
  };

  return (
    <CardShell
      tone={restricted ? "neutral" : "rose"}
      icon={<AlertTriangle className="size-4" />}
      title={notWired ? "芽芽暂时不可用" : restricted ? "当前账号不能查看这段内容" : "这次回复暂时无法确认"}
      dataAttr="run-error"
    >
      <p className="text-foreground/90">{data.message}</p>
      {data.detail !== null && data.detail !== "" ? (
        <details className="text-xs text-muted-foreground">
          <summary className="min-h-11 cursor-pointer content-center rounded-lg px-1 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">查看校验详情</summary>
          <p className="pb-2 [overflow-wrap:anywhere]">协议校验：{data.detail}</p>
        </details>
      ) : null}
      <p className="text-xs text-muted-foreground">只检查上次请求，不会自动重复提交。</p>
      {canLookup ? (
        <Button type="button" variant="outline" size="sm" className="h-11 rounded-xl shadow-none" onClick={() => void lookup()} disabled={checking}>
          <RefreshCw className={cn("size-3.5", checking && "animate-spin motion-reduce:animate-none")} aria-hidden />
          {checking ? "正在检查…" : "检查上次请求"}
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
      title="上次操作的进度"
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
