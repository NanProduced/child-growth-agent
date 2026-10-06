"use client";

/**
 * 待核对提案卡（多人独立子卡 + 批量提交）。
 *
 * - 事件只带 proposal_id 时，先 GET 服务端投影，客户端不自行分配 operation 身份；
 * - 每项独立子卡、独立状态；只有"可读且完整且待核对"的项可选；
 * - 提交只带选中项；批准与执行是两个服务端入口，执行回执必须通过语义核验；
 * - 未确认前不画成功；结果未知保留原操作标记，只按原 operation_id 重新读取。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DataMessagePartProps } from "@assistant-ui/react";
import { AlertTriangle, Check, Clock, Flag, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { YayaDomainPayload, YayaOperationQueryOutcome } from "@/lib/yaya/types";

import {
  approveProposalItems,
  cancelProposal,
  executeApprovedOperations,
  fetchProposalProjection,
  planFromProjection,
  queryOriginalOperation,
  rejectProposalItems,
} from "./client/actions";
import { YayaApiError } from "./client/api";
import { receiptShowsSuccess } from "./client/adapters";
import type { YayaProposalPartData } from "./client/parts";
import type { ProjectedProposal, ProjectedProposalItem } from "./client/schemas";
import { useTeacher } from "@/components/teacher-provider";
import { YayaAttachmentGallery, type YayaGalleryImage } from "./yaya-attachment";
import { YayaImageViewer } from "./yaya-attachment";

const ACTION_LABEL: Record<string, string> = {
  "observation.write": "保存观察原文",
  "observation.organize": "整理观察",
  "observation.confirm": "确认归档",
  "guide.decide": "指南决定",
  "growth_profile.write": "更新成长档案",
  "activity_support.write": "更新活动支持",
  "child.create_profile": "建立幼儿档案",
  "child.transfer": "幼儿转班",
  "class.manage": "班级管理",
  "teacher.manage": "教师管理",
  "teacher.assign": "任教分配",
};

const RESOURCE_LABEL: Record<string, string> = {
  school: "全园",
  class: "班级",
  child: "幼儿",
  transfer: "转班",
  observation: "观察",
};

function payloadSummary(payload: YayaDomainPayload | null): { title: string; lines: string[] } {
  if (payload === null) return { title: "内容当前不可读", lines: [] };
  switch (payload.kind) {
    case "create_observation":
      return {
        title: "新观察原文",
        lines: [
          `日期：${payload.observed_at}`,
          payload.context !== null && payload.context !== "" ? `情境：${payload.context}` : "",
          `原文：${payload.raw_text}`,
        ].filter((line) => line !== ""),
      };
    case "organize_observation":
      return { title: "整理观察", lines: [`观察：${payload.observation_id}`] };
    case "follow_up_observation":
      return {
        title: "补充观察",
        lines: [`观察：${payload.observation_id}`, `补充：${payload.content}`],
      };
    case "confirm_observation":
      return { title: "确认归档观察", lines: [`观察：${payload.observation_id}`] };
    case "guide_decision":
      return { title: "指南决定", lines: [`观察：${payload.observation_id}`, `动作：${payload.mutation.action}`] };
    case "create_child":
      return {
        title: "建立幼儿档案",
        lines: [`姓名：${payload.name}`, `出生日期：${payload.birth_date}`],
      };
    case "transfer_child":
      return { title: "幼儿转班", lines: [`幼儿：${payload.child_id}`] };
    case "manage_class":
      return { title: "班级管理", lines: [`班级：${payload.name}`] };
    case "manage_teacher":
      return { title: "教师管理", lines: [`动作：${payload.operation}`] };
    case "refresh_growth_profile":
      return { title: "更新成长档案", lines: [`幼儿：${payload.child_id}`] };
    case "refresh_activity_support":
      return { title: "更新活动支持", lines: [`幼儿：${payload.child_id}`] };
    case "attach_observation_images":
      return { title: "追加观察图片", lines: [`观察：${payload.observation_id}`, `图片：${payload.image_ids.length} 张`] };
    default:
      return { title: "操作", lines: [] };
  }
}

function ItemOutcomeLine({ outcome, onRecheck, checking }: {
  outcome: YayaOperationQueryOutcome;
  onRecheck: () => void;
  checking: boolean;
}) {
  const success = receiptShowsSuccess(outcome);
  const tone = success
    ? "text-emerald-700"
    : "text-amber-700";
  const text =
    outcome.kind === "saved"
      ? "已保存（服务端回执核对一致）"
      : outcome.kind === "saved_detail_unavailable"
        ? "已保存，详情暂不可读"
        : outcome.kind === "in_progress"
          ? "此操作仍在进行中"
          : outcome.kind === "conflict"
            ? "前提已变化，需要重新核对"
            : outcome.kind === "failed"
              ? outcome.effect === "none"
                ? "没有完成，无提交效果"
                : "失败，但可能已有提交效果"
              : "保存结果未知，按原操作核对";
  return (
    <p className={cn("flex flex-wrap items-center gap-2 text-xs", tone)}>
      <span className="inline-flex items-center gap-1">
        {success ? <Check className="size-3.5" aria-hidden /> : <Clock className="size-3.5" aria-hidden />}
        {text}
      </span>
      {!success ? (
        <button
          type="button"
          onClick={onRecheck}
          disabled={checking}
          className="inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs"
        >
          <RefreshCw className={cn("size-3", checking && "animate-spin motion-reduce:animate-none")} aria-hidden />
          重新读取核对
        </button>
      ) : null}
    </p>
  );
}

export function YayaProposalPanel({
  proposalId,
  origin,
  variant = "chat",
}: {
  proposalId: string;
  origin: "teacher_card" | "model_suggestion";
  variant?: "chat" | "panel";
}) {
  const { principal } = useTeacher();
  const [proposal, setProposal] = useState<ProjectedProposal | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [phase, setPhase] = useState<"idle" | "approving" | "executing" | "done">("idle");
  const [results, setResults] = useState<Record<string, YayaOperationQueryOutcome>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [viewer, setViewer] = useState<YayaGalleryImage | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await fetchProposalProjection(proposalId);
      setProposal(next);
    } catch {
      setLoadError("提案投影暂不可读；不会凭事件内容执行，请重新读取核对。");
    } finally {
      setLoading(false);
    }
  }, [proposalId]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = proposal?.items ?? [];
  const eligible = useMemo(
    () => items.filter((item) => item.status === "pending" && item.access === "full" && item.payload !== null),
    [items]
  );
  const selectedIds = useMemo(() => eligible.filter((item) => selected.has(item.operation_id)).map((item) => item.operation_id), [eligible, selected]);
  const busy = phase === "approving" || phase === "executing";

  const toggle = (item: ProjectedProposalItem, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(item.operation_id);
      else next.delete(item.operation_id);
      return next;
    });
  };

  const approvalsHref = (item: ProjectedProposalItem): YayaGalleryImage | null => {
    const association = item.attachment_associations[0];
    if (association === undefined || proposal === null) return null;
    const projection = proposal.attachments.find((entry) => entry.attachment_id === association.attachment_id);
    if (projection === undefined || !projection.readable) return null;
    return {
      attachmentId: projection.attachment_id,
      src: `/api/yaya/uploads/${encodeURIComponent(projection.attachment_id)}/content?variant=thumbnail`,
    };
  };

  const runSelected = async () => {
    if (proposal === null || principal === null || selectedIds.length === 0) return;
    setActionError(null);
    setPhase("approving");
    try {
      const approval = await approveProposalItems(proposal.proposal_id, selectedIds);
      setPhase("executing");
      const plan = planFromProjection(proposal, { accountId: principal.account_id, role: principal.role, displayName: principal.display_name }, selectedIds);
      const outcome = await executeApprovedOperations(plan, approval.approval_id, selectedIds);
      if (outcome.kind === "rejected") {
        setActionError(`${outcome.message}${outcome.detail !== null ? `（${outcome.detail}）` : ""} 已批准项不会自动重发。`);
        setPhase("idle");
        await load();
        return;
      }
      const next: Record<string, YayaOperationQueryOutcome> = {};
      for (const entry of outcome.assessment.outcomes) next[entry.operation_id] = entry.outcome;
      setResults((current) => ({ ...current, ...next }));
      setSelected(new Set());
      setPhase("done");
    } catch (error) {
      setActionError(
        error instanceof YayaApiError
          ? `${error.message}未显示成功，请重新读取核对。`
          : "批准或执行请求未完成；未显示成功，请重新读取核对。"
      );
      setPhase("idle");
    }
  };

  const rejectSelected = async () => {
    if (proposal === null || selectedIds.length === 0) return;
    setActionError(null);
    try {
      await rejectProposalItems(proposal.proposal_id, selectedIds);
      setSelected(new Set());
      await load();
    } catch {
      setActionError("拒绝请求未完成，请重试。");
    }
  };

  const cancel = async () => {
    if (proposal === null) return;
    setActionError(null);
    try {
      await cancelProposal(proposal.proposal_id);
      setPhase("idle");
      await load();
    } catch {
      setActionError("取消提案请求未完成，请重试。");
    }
  };

  const recheckItem = async (operationId: string) => {
    setCheckingId(operationId);
    try {
      const result = await queryOriginalOperation(operationId);
      setResults((current) => ({ ...current, [result.operation_id]: result.outcome }));
    } catch {
      setActionError("读取暂未完成，这不代表没有数据；仍按结果未知处理。");
    } finally {
      setCheckingId(null);
    }
  };

  const savedCount = Object.values(results).filter((entry) => receiptShowsSuccess(entry)).length;
  const pendingCount = eligible.length;

  return (
    <section
      className={cn(
        "rounded-xl border border-border bg-card p-3 text-sm",
        variant === "panel" && "p-4"
      )}
      data-yaya-proposal
      data-proposal-id={proposal?.proposal_id ?? proposalId}
    >
      <header className="flex flex-wrap items-center gap-2">
        <Flag className="size-4 text-amber-700" aria-hidden />
        <h3 className="font-medium text-foreground">待核对操作</h3>
        {proposal !== null ? (
          <>
            <Badge variant="secondary" className="bg-amber-100 text-amber-700">
              {proposal.status === "open" ? "待核对" : proposal.status === "cancelled" ? "已取消" : "已结束"}
            </Badge>
            <span className="text-xs text-muted-foreground">
              本批 {proposal.items.length} 条 · 待核对 {pendingCount} · 已完成回执 {savedCount}
            </span>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">{loading ? "正在读取提案…" : "提案不可读"}</span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {origin === "model_suggestion" ? "芽芽建议" : "教师发起"}
        </span>
      </header>

      {loadError !== null ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-amber-800">{loadError}</p>
          <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => void load()}>
            <RefreshCw className="size-3.5" aria-hidden /> 重新读取
          </Button>
        </div>
      ) : null}

      <div className="mt-3 space-y-3">
        {items.map((item) => {
          const outcome = results[item.operation_id];
          const eligibleItem =
            item.status === "pending" && item.access === "full" && item.payload !== null && outcome === undefined;
          const summary = payloadSummary(item.payload as YayaDomainPayload | null);
          const galleryImage = approvalsHref(item);
          return (
            <article
              key={item.operation_id}
              className="rounded-lg border border-border/80 bg-background p-3"
              data-yaya-proposal-item
            >
              <div className="flex items-start gap-2">
                {eligibleItem ? (
                  <label className="flex size-11 shrink-0 cursor-pointer items-center justify-center">
                    <Checkbox
                      checked={selected.has(item.operation_id)}
                      disabled={busy}
                      onCheckedChange={(checked) => toggle(item, checked === true)}
                      aria-label={`选择第 ${item.item_key} 项`}
                      className="size-5"
                    />
                  </label>
                ) : (
                  <span className="mt-0.5 inline-flex size-5 items-center justify-center text-muted-foreground" aria-hidden>
                    {outcome !== undefined ? <Check className="size-4" /> : <AlertTriangle className="size-4" />}
                  </span>
                )}
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-foreground">
                      {ACTION_LABEL[item.action] ?? item.action}
                    </p>
                    <Badge variant="outline" className="text-xs">
                      {RESOURCE_LABEL[item.resource] ?? item.resource}
                      {item.target_id !== null ? ` · ${item.target_id.slice(0, 8)}` : ""}
                    </Badge>
                    <Badge
                      variant="secondary"
                      className={cn(
                        "text-xs",
                        item.access === "full"
                          ? "bg-emerald-100 text-emerald-700"
                          : item.access === "historical_read_only"
                            ? "bg-sky-100 text-sky-700"
                            : "bg-rose-100 text-rose-700"
                      )}
                    >
                      {item.access === "full"
                        ? "内容可核对"
                        : item.access === "historical_read_only"
                          ? "历史只读"
                          : "内容不可读"}
                    </Badge>
                    {item.status === "superseded" ? (
                      <Badge variant="secondary" className="bg-slate-100 text-slate-600">
                        已被替代
                      </Badge>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">{summary.title}</p>
                  {summary.lines.map((line, index) => (
                    <p key={index} className="whitespace-pre-wrap text-sm text-foreground/90">
                      {line}
                    </p>
                  ))}
                  {galleryImage !== null ? (
                    <YayaAttachmentGallery images={[galleryImage]} onOpen={(image) => setViewer(image)} />
                  ) : item.attachment_associations.length > 0 ? (
                    <p className="text-xs text-muted-foreground">关联图片当前不可读或仅保留元数据。</p>
                  ) : null}
                  {!eligibleItem && outcome === undefined ? (
                    <p className="text-xs text-amber-700">
                      {item.status !== "pending"
                        ? "该项已处理，不能再次提交。"
                        : "该项当前不可读或内容不完整；不会随整批提交。"}
                    </p>
                  ) : null}
                  {outcome !== undefined ? (
                    <ItemOutcomeLine
                      outcome={outcome}
                      checking={checkingId === item.operation_id}
                      onRecheck={() => void recheckItem(item.operation_id)}
                    />
                  ) : null}
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {actionError !== null ? <p className="mt-3 text-xs text-rose-700">{actionError}</p> : null}

      {proposal !== null && proposal.status === "open" ? (
        <footer className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            className="h-11 min-w-32 flex-1"
            disabled={busy || selectedIds.length === 0}
            onClick={() => void runSelected()}
          >
            {phase === "approving"
              ? "正在批准…"
              : phase === "executing"
                ? "正在执行…"
                : `确认已选 ${selectedIds.length} 条`}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={busy || selectedIds.length === 0}
            onClick={() => void rejectSelected()}
          >
            拒绝选中项
          </Button>
          <Button type="button" variant="ghost" className="h-11" disabled={busy} onClick={() => void cancel()}>
            取消提案
          </Button>
          <p className="w-full text-xs text-muted-foreground">
            确认后才成为正式记录；取消提案不会执行任何写入，也不会撤销已提交的业务。
          </p>
        </footer>
      ) : null}

      <YayaImageViewer
        open={viewer !== null}
        src={viewer?.src ?? null}
        filename={viewer?.filename}
        onOpenChange={(open) => {
          if (!open) setViewer(null);
        }}
      />
    </section>
  );
}

/** data-part 包装：消息流内提案卡（宽屏工作区用 YayaProposalPanel 复用同一逻辑）。 */
export function YayaProposalCard({ data }: DataMessagePartProps<YayaProposalPartData>) {
  return <YayaProposalPanel proposalId={data.proposal_id} origin={data.proposal_origin} variant="chat" />;
}
