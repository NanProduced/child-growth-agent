"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Link2, Loader2, Sparkles } from "lucide-react";

import { fetchWithAccountAuth } from "@/lib/accounts/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { classLabel, formatDateCn } from "@/lib/format";
import {
  basisQuoteChoices,
  type BasisSourceOption,
  type GuideItemOption,
  type GuideWriteAccessView,
} from "@/lib/guide/association-types";
import {
  basisSourceLabel,
  decisionStatusOf,
  draftToDecisionInput,
  emptyDecisionDraft,
  isPerformanceSupport,
  sustainedConditionError,
  validateDecisionDraft,
  type DecisionBasisDraft,
  type DecisionDraft,
} from "@/lib/guide/decision-draft";
import { GUIDE_AGE_BAND_LABELS, type GuideEvidenceSupportKind } from "@/lib/guide/types";
import {
  GUIDE_EVIDENCE_LINK_STATUS_LABELS,
  type EvidenceLinkView,
  type GuideEvidenceDecisionInput,
} from "@/lib/guide/view-types";
import type { ObservationStatus } from "@/lib/types";

/**
 * 指南条目关联操作区（G6-WRITE1）。
 *
 * - 手动关联与 AI 建议同等正式：不依赖 AI 也能建立关联；
 * - AI 建议只在教师主动点击后请求，打开页面不自动调用模型；
 * - 未归档宿主：选择先保留为待提交决定，随观察归档在同一事务写入（deferred 不显示已生效）；
 * - 已归档宿主：使用当前 revision 直接确认/不采用/撤回；终态通过新关联恢复，不原地复活；
 * - 结果不确定（网络失败/详情补查失败）时先读回，不自动重复提交、不无依据显示成功。
 */

export interface GuideAssociationSectionProps {
  observationId: string;
  childId: string;
  hostStatus: ObservationStatus;
  access: GuideWriteAccessView;
  mode: "pre_archive" | "archived";
  revision: number;
  links: EvidenceLinkView[];
  detailUnavailable: boolean;
  itemOptions: GuideItemOption[];
  goalLabels: Record<string, string>;
  basisSources: BasisSourceOption[];
  focusItemId: string | null;
  focusItemUnknown: boolean;
  /** 宿主观察当前表单内容；宿主依据的确认稿引用以它为准（归档事务中核对） */
  liveConfirmed: { highlight_quote: string; highlights: string[] } | null;
  onRevisionChange: (update: { revision: number; links: EvidenceLinkView[] }) => void;
  onPendingChange: (pending: { expectedRevision: number; decisions: GuideEvidenceDecisionInput[] } | null) => void;
}

interface MutationResponse {
  revision?: number;
  links?: EvidenceLinkView[];
  notice?: { code: string; message: string } | string;
  message?: string;
  error?: string;
}

const SUPPORT_LABELS: Record<GuideEvidenceSupportKind, string> = {
  single_event: "单次表现",
  sustained: "持续表现",
  clue_only: "仅相关线索",
};

const EVIDENCE_TYPE_LABELS = {
  behavior: "行为表现",
  sustained: "持续性表现",
  health_reference: "保健参考",
} as const;

const EXCLUSION_LABELS = {
  workflow_pending: "AI 关联待核对，尚未由教师确认",
  teacher_rejected: "教师已不采用",
  withdrawn: "已撤回",
  basis_invalid: "依据未通过核对",
  basis_out_of_period: "依据不在所选期间",
  catalog_mismatch: "目录版本不一致",
  support_insufficient: "支持条件不足",
  history_unknown: "发生班级历史未知",
  out_of_stage_evidence: "发生阶段不符合班级统计口径",
  unknown_status: "关联状态无法识别",
} as const;

function noticeText(notice: MutationResponse["notice"]): string | null {
  if (!notice) return null;
  if (typeof notice === "string") return notice;
  return notice.message ?? null;
}

function quoteFor(sourceId: string): DecisionBasisDraft {
  return {
    observation_id: sourceId,
    quote: "",
    quote_source: "raw_text",
    quote_field: null,
  };
}

function defaultBasis(sources: BasisSourceOption[]): DecisionBasisDraft[] {
  if (sources.length === 0) return [];
  return [quoteFor(sources[0].id)];
}

export function GuideAssociationSection(props: GuideAssociationSectionProps) {
  const router = useRouter();
  const disclosureId = useId();
  const itemById = useMemo(
    () => new Map(props.itemOptions.map((option) => [option.id, option])),
    [props.itemOptions],
  );
  const [open, setOpen] = useState(() => Boolean(props.focusItemId));
  const [pending, setPending] = useState<DecisionDraft[]>([]);
  const [editing, setEditing] = useState<DecisionDraft | null>(null);
  const [pickerQuery, setPickerQuery] = useState("");
  const [busy, setBusy] = useState<null | "suggest" | "submit" | "terminal">(null);
  const [notice, setNotice] = useState<{ severity: "info" | "warning" | "error"; message: string } | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [withdrawReason, setWithdrawReason] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.access.can_decide) {
      props.onPendingChange(null);
      return;
    }
    props.onPendingChange(
      pending.length > 0
        ? { expectedRevision: props.revision, decisions: pending.map(draftToDecisionInput) }
        : null,
    );
  }, [pending, props.access.can_decide, props.revision, props.onPendingChange]);

  const suggestions = props.links.filter((link) => link.status === "ai_suggested");
  const activeLinks = props.links.filter(
    (link) => link.status === "confirmed_performance" || link.status === "confirmed_clue",
  );
  const terminalLinks = props.links.filter(
    (link) => link.status === "rejected" || link.status === "withdrawn",
  );
  const focusOption = props.focusItemId ? itemById.get(props.focusItemId) ?? null : null;

  const pickerResults = useMemo(() => {
    const query = pickerQuery.trim().toLowerCase();
    if (query.length === 0) return [];
    const matches = props.itemOptions.filter((option) => {
      if (option.text.toLowerCase().includes(query)) return true;
      const label = props.goalLabels[option.goal_id] ?? "";
      return label.toLowerCase().includes(query);
    });
    return matches.slice(0, 20);
  }, [pickerQuery, props.itemOptions, props.goalLabels]);

  function beginManual() {
    setDraftError(null);
    setPickerQuery("");
    // 入口关注条目只作为表单预选，仍需教师逐项核对依据后才成为决定
    setEditing(emptyDecisionDraft(focusOption?.id ?? "", defaultBasis(props.basisSources)));
  }

  function beginFromSuggestion(link: EvidenceLinkView) {
    setDraftError(null);
    const basis: DecisionBasisDraft[] = link.basis.map((entry) => ({
      observation_id: entry.observation_id,
      quote: entry.quote,
      quote_source: entry.quote_source,
      quote_field: entry.quote_field,
    }));
    setEditing({
      link_id: link.link_id,
      item_id: link.item_id,
      support: link.support ?? "clue_only",
      basis: basis.length > 0 ? basis : defaultBasis(props.basisSources),
      sustained_note: link.sustained_note,
      adult_help_used: link.adult_help_used,
      teacher_note: link.teacher_note ?? "",
    });
  }

  function updateEditing(patch: Partial<DecisionDraft>) {
    setEditing((previous) => (previous ? { ...previous, ...patch } : previous));
  }

  function updateBasis(index: number, patch: Partial<DecisionBasisDraft>) {
    setEditing((previous) => {
      if (!previous) return previous;
      const basis = previous.basis.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, ...patch } : entry,
      );
      return { ...previous, basis };
    });
  }

  function saveEditing() {
    if (!editing) return;
    if (!editing.item_id || !itemById.has(editing.item_id)) {
      setDraftError("请先选择要关联的指南条目。");
      return;
    }
    const item = itemById.get(editing.item_id);
    if (!item) return;
    const basisDates = new Map(props.basisSources.map((source) => [source.id, source.observed_at]));
    const error = validateDecisionDraft(editing, item, basisDates);
    if (error) {
      setDraftError(error);
      return;
    }
    setDraftError(null);
    if (props.mode === "pre_archive") {
      setPending((previous) => {
        const next = previous.filter(
          (draft) =>
            !(editing.link_id && draft.link_id === editing.link_id) &&
            !(!editing.link_id && !draft.link_id && draft.item_id === editing.item_id),
        );
        return [...next, editing];
      });
      setEditing(null);
      return;
    }
    void submitArchivedDecision(editing);
  }

  async function submitArchivedDecision(draft: DecisionDraft) {
    setBusy("submit");
    setNotice(null);
    try {
      const res = await fetchWithAccountAuth(`/api/observations/${props.observationId}/guide-evidence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "confirm",
          expected_guide_revision: props.revision,
          decisions: [draftToDecisionInput(draft)],
        }),
      });
      const data = (await res.json().catch(() => ({}))) as MutationResponse;
      if (!res.ok) {
        if (res.status === 409) {
          setNotice({
            severity: "warning",
            message: `${data.message ?? "依据或状态已变化，操作未写入。"} 请重新读取后再核对；旧决定不会自动重放。`,
          });
          router.refresh();
        } else {
          setNotice({ severity: "error", message: data.message ?? "关联确认失败，请稍后重试。" });
        }
        return;
      }
      if (typeof data.revision === "number" && data.links) {
        props.onRevisionChange({ revision: data.revision, links: data.links });
      }
      setEditing(null);
      setNotice({ severity: "info", message: "关联已按当前依据写入。" });
    } catch {
      setNotice({
        severity: "warning",
        message: "网络中断，写入结果不确定。已请求重新读取，请核对后决定是否重试；系统不会自动重复提交。",
      });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function requestSuggestions() {
    setBusy("suggest");
    setNotice(null);
    try {
      const res = await fetchWithAccountAuth(`/api/observations/${props.observationId}/guide-evidence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "suggest" }),
      });
      const data = (await res.json().catch(() => ({}))) as MutationResponse;
      if (!res.ok) {
        setNotice({ severity: "error", message: data.message ?? "AI 关联请求失败，请稍后重试。" });
        return;
      }
      if (typeof data.revision === "number" && data.links) {
        props.onRevisionChange({ revision: data.revision, links: data.links });
      }
      const failure = noticeText(data.notice);
      if (failure) {
        setNotice({ severity: "warning", message: failure });
      } else {
        const added = data.links?.filter((link) => link.status === "ai_suggested").length ?? 0;
        setNotice({
          severity: "info",
          message: added > 0 ? `AI 返回了 ${added} 条待核对建议；请逐条核对，不会自动确认。` : "AI 没有返回新的可核对建议；你仍可以手动关联。",
        });
      }
    } catch {
      setNotice({
        severity: "warning",
        message: "网络中断，AI 建议结果不确定；请刷新后查看，系统不会自动重试。",
      });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function submitTerminal(action: "reject" | "withdraw", linkId: string, reason: string) {
    setBusy("terminal");
    setNotice(null);
    try {
      const res = await fetchWithAccountAuth(`/api/observations/${props.observationId}/guide-evidence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          link_id: linkId,
          expected_guide_revision: props.revision,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as MutationResponse;
      if (!res.ok) {
        setNotice({
          severity: res.status === 409 ? "warning" : "error",
          message: data.message ?? (action === "reject" ? "不采用失败，请稍后重试。" : "撤回失败，请稍后重试。"),
        });
        if (res.status === 409) router.refresh();
        return;
      }
      if (typeof data.revision === "number" && data.links) {
        props.onRevisionChange({ revision: data.revision, links: data.links });
      }
      setRejecting(null);
      setRejectReason("");
      setWithdrawing(null);
      setWithdrawReason("");
      setNotice({
        severity: "info",
        message: action === "reject" ? "已不采用这条 AI 建议；原建议保留在审计记录中。" : "已撤回这条关联；原依据与撤回信息保留在审计记录中。",
      });
    } catch {
      setNotice({
        severity: "warning",
        message: "网络中断，操作结果不确定。已请求重新读取，请核对；系统不会自动重复提交。",
      });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  function linkItemLabel(link: EvidenceLinkView): string {
    const option = itemById.get(link.item_id);
    return option?.text ?? `条目不在当前目录版本（${link.item_id}）`;
  }

  function linkGoalLabel(link: EvidenceLinkView): string | null {
    const option = itemById.get(link.item_id);
    if (!option) return null;
    return props.goalLabels[option.goal_id] ?? null;
  }

  const pendingDecisions = pending;

  return (
    <section className="rounded-xl border bg-white" data-testid="guide-association-section">
      <button
        type="button"
        className="flex min-h-11 w-full items-center gap-2 px-4 py-3 text-left"
        aria-expanded={open}
        aria-controls={disclosureId}
        onClick={() => setOpen((value) => !value)}
        data-testid="guide-association-disclosure"
      >
        <Link2 className="size-4 text-emerald-700" aria-hidden="true" />
        <span className="text-sm font-medium">关联指南条目</span>
        {suggestions.length > 0 ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900">
            AI 待核对 {suggestions.length}
          </span>
        ) : null}
        {activeLinks.length > 0 ? (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-900">
            已确认 {activeLinks.length}
          </span>
        ) : null}
        {pendingDecisions.length > 0 ? (
          <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-900">
            待随归档提交 {pendingDecisions.length}
          </span>
        ) : null}
        <ChevronDown
          className={`ml-auto size-4 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div className="space-y-4 border-t px-4 py-4" id={disclosureId}>
          <p className="text-xs leading-5 text-slate-600">
            {props.mode === "pre_archive"
              ? "这里的选择会保留到最终归档，与观察确认在同一个事务写入；归档前不会显示为已生效。"
              : "已归档观察的关联决定立即生效；撤回保留历史，重新关联会建立新记录。"}
          </p>

          {!props.access.can_decide ? (
            <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600" role="note">
              {props.access.read_only_reason ?? "当前为只读查看，不能建立或修改关联。"}
            </p>
          ) : null}

          {props.focusItemUnknown ? (
            <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900" role="alert" data-testid="focus-item-unknown">
              入口带来的关注条目不在当前指南目录版本，不会自动关联；请在下方手动选择条目。
            </p>
          ) : null}

          {focusOption ? (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2" data-testid="focus-item">
              <p className="text-xs font-medium text-emerald-900">来自证据册的关注条目（只是关注点，不是已建立的关联）</p>
              <p className="mt-1 text-sm leading-6 text-slate-800">{focusOption.text}</p>
              <p className="mt-1 text-xs text-slate-600">
                {props.goalLabels[focusOption.goal_id] ?? "未定位目标"} · 指南参考 {GUIDE_AGE_BAND_LABELS[focusOption.age_band]}
              </p>
            </div>
          ) : null}

          {notice ? (
            <p
              className={`rounded-lg border px-3 py-2 text-xs leading-5 ${
                notice.severity === "error"
                  ? "border-rose-200 bg-rose-50 text-rose-900"
                  : notice.severity === "warning"
                    ? "border-amber-300 bg-amber-50 text-amber-900"
                    : "border-emerald-200 bg-emerald-50 text-emerald-900"
              }`}
              role={notice.severity === "error" ? "alert" : "status"}
              data-testid="guide-association-notice"
            >
              {notice.message}
            </p>
          ) : null}

          {props.detailUnavailable ? (
            <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900" role="status" data-testid="guide-detail-unavailable">
              已保存的关联详情暂时无法读取；这不代表没有关联。请刷新查看，不要重复提交。手动关联仍可使用。
            </p>
          ) : null}

          {props.access.can_decide ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => void requestSuggestions()}
                disabled={busy !== null}
                data-testid="guide-suggest"
              >
                {busy === "suggest" ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                请求 AI 关联建议
              </Button>
              <Button type="button" className="min-h-11" onClick={beginManual} disabled={busy !== null} data-testid="guide-manual-add">
                <Link2 className="size-4" />
                手动关联条目
              </Button>
            </div>
          ) : null}

          {editing ? (
            <DecisionEditor
              draft={editing}
              itemById={itemById}
              goalLabels={props.goalLabels}
              basisSources={props.basisSources}
              liveConfirmed={props.liveConfirmed}
              pickerQuery={pickerQuery}
              pickerResults={pickerResults}
              draftError={draftError}
              busy={busy !== null}
              mode={props.mode}
              onPickerQuery={setPickerQuery}
              onChange={updateEditing}
              onBasisChange={updateBasis}
              onAddBasis={() =>
                updateEditing({
                  basis: [...editing.basis, quoteFor(props.basisSources[0]?.id ?? "")],
                })
              }
              onRemoveBasis={(index) =>
                updateEditing({ basis: editing.basis.filter((_, entryIndex) => entryIndex !== index) })
              }
              onCancel={() => {
                setEditing(null);
                setDraftError(null);
              }}
              onSave={saveEditing}
            />
          ) : null}

          {pendingDecisions.length > 0 ? (
            <div className="space-y-2" data-testid="pending-decisions">
              <h4 className="text-xs font-medium text-slate-700">待随归档提交的选择</h4>
              <ul className="space-y-2">
                {pendingDecisions.map((draft, index) => {
                  const option = itemById.get(draft.item_id);
                  return (
                    <li key={`${draft.link_id ?? draft.item_id}-${index}`} className="rounded-lg border border-sky-200 bg-sky-50/60 px-3 py-2 text-xs leading-5 text-slate-800">
                      <span className="font-medium">
                        {decisionStatusOf(draft.support) === "confirmed_performance" ? "已确认观察到" : "已有相关线索"}
                      </span>
                      <span> · {option?.text ?? draft.item_id}</span>
                      <span> · 依据 {draft.basis.length} 条</span>
                      <span className="mt-1 flex gap-2">
                        <button type="button" className="min-h-11 underline" onClick={() => setEditing(draft)}>
                          编辑
                        </button>
                        <button
                          type="button"
                          className="min-h-11 underline"
                          onClick={() => setPending((previous) => previous.filter((_, entryIndex) => entryIndex !== index))}
                        >
                          移除
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {suggestions.length > 0 ? (
            <div className="space-y-2" data-testid="guide-suggestions">
              <h4 className="text-xs font-medium text-slate-700">AI 关联待核对（不计入正式状态与人数）</h4>
              <ul className="space-y-3">
                {suggestions.map((link) => (
                  <li key={link.link_id} className="rounded-lg border border-amber-200 bg-amber-50/50 px-3 py-3" data-testid="guide-suggestion">
                    <p className="text-sm font-medium leading-6 text-slate-800">{linkItemLabel(link)}</p>
                    {linkGoalLabel(link) ? <p className="text-xs text-slate-500">{linkGoalLabel(link)}</p> : null}
                    {link.ai_reason ? <p className="mt-1 text-xs leading-5 text-slate-700">建议理由：{link.ai_reason}</p> : null}
                    <BasisList link={link} />
                    {props.access.can_decide ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button type="button" size="sm" className="min-h-11" onClick={() => beginFromSuggestion(link)} data-testid="guide-suggestion-review">
                          核对并决定
                        </Button>
                        {props.mode === "archived" ? (
                          rejecting === link.link_id ? (
                            <span className="flex flex-wrap items-center gap-2">
                              <Input
                                value={rejectReason}
                                onChange={(event) => setRejectReason(event.target.value)}
                                placeholder="不采用原因（选填）"
                                maxLength={500}
                                className="min-h-11 w-56"
                              />
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="min-h-11"
                                disabled={busy !== null}
                                onClick={() => void submitTerminal("reject", link.link_id, rejectReason)}
                              >
                                确认不采用
                              </Button>
                              <Button type="button" variant="ghost" size="sm" className="min-h-11" onClick={() => setRejecting(null)}>
                                取消
                              </Button>
                            </span>
                          ) : (
                            <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={() => setRejecting(link.link_id)} data-testid="guide-suggestion-reject">
                              不采用
                            </Button>
                          )
                        ) : (
                          <span className="self-center text-xs text-slate-500">归档后可以在这里不采用或撤回。</span>
                        )}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {activeLinks.length > 0 ? (
            <div className="space-y-2" data-testid="guide-active-links">
              <h4 className="text-xs font-medium text-slate-700">已确认的关联</h4>
              <ul className="space-y-3">
                {activeLinks.map((link) => (
                  <li key={link.link_id} className="rounded-lg border border-emerald-200 bg-emerald-50/40 px-3 py-3" data-testid="guide-active-link">
                    <p className="text-sm font-medium leading-6 text-slate-800">{linkItemLabel(link)}</p>
                    {linkGoalLabel(link) ? <p className="text-xs text-slate-500">{linkGoalLabel(link)}</p> : null}
                    <p className="mt-1 text-xs text-slate-600">
                      {GUIDE_EVIDENCE_LINK_STATUS_LABELS[link.status]}
                      {link.support ? ` · ${SUPPORT_LABELS[link.support]}` : ""}
                      {link.adult_help_used ? " · 有成人帮助" : ""}
                      {link.teacher_note ? ` · 教师说明：${link.teacher_note}` : ""}
                    </p>
                    {link.sustained_note ? (
                      <p className="text-xs text-slate-600">
                        连续观察纪要（{formatDateCn(link.sustained_note.period_start)} 至 {formatDateCn(link.sustained_note.period_end)}）：{link.sustained_note.description}
                      </p>
                    ) : null}
                    <BasisList link={link} />
                    {props.access.can_decide ? (
                      withdrawing === link.link_id ? (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <Input
                            value={withdrawReason}
                            onChange={(event) => setWithdrawReason(event.target.value)}
                            placeholder="撤回原因（选填）"
                            maxLength={500}
                            className="min-h-11 w-56"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="min-h-11"
                            disabled={busy !== null}
                            onClick={() => void submitTerminal("withdraw", link.link_id, withdrawReason)}
                          >
                            确认撤回
                          </Button>
                          <Button type="button" variant="ghost" size="sm" className="min-h-11" onClick={() => setWithdrawing(null)}>
                            取消
                          </Button>
                        </div>
                      ) : (
                        <Button type="button" variant="outline" size="sm" className="mt-2 min-h-11" onClick={() => setWithdrawing(link.link_id)} data-testid="guide-withdraw">
                          撤回
                        </Button>
                      )
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {terminalLinks.length > 0 ? (
            <details className="rounded-lg border bg-slate-50/60 px-3 py-2">
              <summary className="min-h-11 cursor-pointer text-xs font-medium text-slate-600">
                审计记录：已不采用 / 已撤回（不计入状态）
              </summary>
              <ul className="mt-2 space-y-2">
                {terminalLinks.map((link) => (
                  <li key={link.link_id} className="text-xs leading-5 text-slate-600">
                    <span className="font-medium text-slate-700">{linkItemLabel(link)}</span>
                    <span> · {GUIDE_EVIDENCE_LINK_STATUS_LABELS[link.status]}</span>
                    {link.teacher_note ? <span> · 原因：{link.teacher_note}</span> : null}
                    {link.withdrawn_reason ? <span> · 撤回原因：{link.withdrawn_reason}</span> : null}
                    <BasisList link={link} />
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {props.links.length === 0 && !props.detailUnavailable ? (
            <p className="text-xs leading-5 text-slate-500" data-testid="guide-links-empty">
              还没有与该观察相关的指南条目关联。你可以手动选择条目，或主动请求 AI 建议。
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function BasisList({ link }: { link: EvidenceLinkView }) {
  if (link.basis.length === 0) return null;
  return (
    <ul className="mt-1 space-y-1">
      {link.basis.map((entry, index) => (
        <li key={`${link.link_id}-${entry.observation_id}-${index}`} className="text-xs leading-5 text-slate-600">
          <span>
            {formatDateCn(entry.observed_at)} · {entry.class_context ? classLabel(entry.class_context.stage, entry.class_context.class_name) : "发生班级未知"} ·{" "}
            {entry.quote_source === "raw_text" ? "原文" : "确认稿"}
          </span>
          <span className="block text-slate-800">「{entry.quote}」</span>
          {!entry.valid && entry.observation_status !== "confirmed" ? (
            <span className="text-amber-800">该依据来源尚未归档，将在归档时核对。</span>
          ) : !entry.valid ? (
            <span className="text-amber-800">该依据未通过核对，不参与正式状态，仅保留审计展示。</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function DecisionEditor(props: {
  draft: DecisionDraft;
  itemById: Map<string, GuideItemOption>;
  goalLabels: Record<string, string>;
  basisSources: BasisSourceOption[];
  liveConfirmed: { highlight_quote: string; highlights: string[] } | null;
  pickerQuery: string;
  pickerResults: GuideItemOption[];
  draftError: string | null;
  busy: boolean;
  mode: "pre_archive" | "archived";
  onPickerQuery: (value: string) => void;
  onChange: (patch: Partial<DecisionDraft>) => void;
  onBasisChange: (index: number, patch: Partial<DecisionBasisDraft>) => void;
  onAddBasis: () => void;
  onRemoveBasis: (index: number) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { draft } = props;
  const item = draft.item_id ? props.itemById.get(draft.item_id) ?? null : null;
  const sourceById = useMemo(
    () => new Map(props.basisSources.map((source) => [source.id, source])),
    [props.basisSources],
  );
  const performance = isPerformanceSupport(draft.support);
  const sustainedRequired = item?.evidence_type === "sustained";
  const days = new Set(
    draft.basis
      .map((entry) => sourceById.get(entry.observation_id)?.observed_at)
      .filter((value): value is string => Boolean(value)),
  );
  const needsNote = draft.support === "sustained" && days.size < 2;
  const independenceConflict = performance && draft.adult_help_used && item?.adult_help === "requires_independence";
  const sustainedHint =
    draft.support === "sustained" ? sustainedConditionError(
      draft.basis.map((entry) => ({ observed_at: sourceById.get(entry.observation_id)?.observed_at ?? "" })),
      draft.sustained_note,
    ) : null;

  return (
    <div className="space-y-4 rounded-lg border border-slate-300 bg-slate-50/60 px-3 py-3" data-testid="decision-editor">
      {item ? (
        <div>
          <p className="text-sm font-medium leading-6 text-slate-800">{item.text}</p>
          <p className="text-xs text-slate-500">
            {props.goalLabels[item.goal_id] ?? "未定位目标"} · 指南参考 {GUIDE_AGE_BAND_LABELS[item.age_band]} ·{" "}
            {EVIDENCE_TYPE_LABELS[item.evidence_type]} ·{" "}
            {item.adult_help === "allowed" ? "允许成人帮助（说明方式后可确认表现）" : "要求独立完成（有成人帮助只能确认线索）"}
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="guide-item-search">选择指南条目</Label>
          <Input
            id="guide-item-search"
            value={props.pickerQuery}
            onChange={(event) => props.onPickerQuery(event.target.value)}
            placeholder="输入关键词搜索表现条目（如：连续向前跳、轮流）"
            className="min-h-11"
            data-testid="guide-item-search"
          />
          {props.pickerQuery.trim().length === 0 ? (
            <p className="text-xs text-slate-500">按条目原文或目标关键词搜索；不默认铺满全部条目。</p>
          ) : props.pickerResults.length === 0 ? (
            <p className="text-xs text-slate-500">没有匹配的条目，请换一个关键词。</p>
          ) : (
            <ul className="max-h-64 space-y-1 overflow-y-auto" data-testid="guide-item-options">
              {props.pickerResults.map((option) => (
                <li key={option.id}>
                  <button
                    type="button"
                    className="min-h-11 w-full rounded-md border bg-white px-3 py-2 text-left text-xs leading-5 text-slate-800 hover:border-emerald-300"
                    onClick={() => props.onChange({ item_id: option.id, link_id: null })}
                    data-testid="guide-item-option"
                  >
                    <span className="block font-medium">{props.goalLabels[option.goal_id] ?? "未定位目标"}</span>
                    <span className="block">
                      {GUIDE_AGE_BAND_LABELS[option.age_band]} · {option.text}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-slate-700">教师决定</legend>
        <div className="flex flex-wrap gap-2">
          <label className="flex min-h-11 items-center gap-2 rounded-md border bg-white px-3 py-2 text-sm">
            <input
              type="radio"
              name={`decision-${draft.item_id}`}
              checked={draft.support === "clue_only"}
              onChange={() => props.onChange({ support: "clue_only" })}
              disabled={props.busy}
            />
            已有相关线索
          </label>
          <label className="flex min-h-11 items-center gap-2 rounded-md border bg-white px-3 py-2 text-sm">
            <input
              type="radio"
              name={`decision-${draft.item_id}`}
              checked={performance}
              onChange={() => props.onChange({ support: sustainedRequired ? "sustained" : "single_event" })}
              disabled={props.busy}
              data-testid="decision-performance"
            />
            已确认观察到
          </label>
        </div>
        {performance && !sustainedRequired ? (
          <div className="flex flex-wrap gap-2 text-xs text-slate-600">
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="radio"
                name={`support-${draft.item_id}`}
                checked={draft.support === "single_event"}
                onChange={() => props.onChange({ support: "single_event" })}
                disabled={props.busy}
              />
              单次表现（一次充分证据）
            </label>
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="radio"
                name={`support-${draft.item_id}`}
                checked={draft.support === "sustained"}
                onChange={() => props.onChange({ support: "sustained" })}
                disabled={props.busy}
              />
              持续表现（跨日证据或纪要）
            </label>
          </div>
        ) : null}
        {sustainedRequired && performance ? (
          <p className="text-xs leading-5 text-slate-600">该条目属于持续性表现，确认表现必须使用持续表现支持；也可改为确认线索。</p>
        ) : null}
      </fieldset>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-700">真实依据（全部必需依据都会逐条核对）</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-11"
            onClick={props.onAddBasis}
            disabled={props.busy || draft.basis.length >= 10}
          >
            添加依据
          </Button>
        </div>
        {draft.basis.map((entry, index) => (
          <BasisEditorRow
            key={`${entry.observation_id}-${index}`}
            index={index}
            entry={entry}
            sources={props.basisSources}
            liveConfirmed={props.liveConfirmed}
            allowRemove={draft.basis.length > 1}
            busy={props.busy}
            onChange={(patch) => props.onBasisChange(index, patch)}
            onRemove={() => props.onRemoveBasis(index)}
          />
        ))}
      </div>

      {draft.support === "sustained" ? (
        <fieldset className="space-y-2 rounded-md border bg-white px-3 py-2">
          <legend className="text-xs font-medium text-slate-700">连续观察纪要（跨日依据不足时必填）</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="space-y-1 text-xs text-slate-600">
              从
              <Input
                type="date"
                className="min-h-11"
                value={draft.sustained_note?.period_start ?? ""}
                onChange={(event) =>
                  props.onChange({
                    sustained_note: {
                      period_start: event.target.value,
                      period_end: draft.sustained_note?.period_end ?? "",
                      description: draft.sustained_note?.description ?? "",
                    },
                  })
                }
                disabled={props.busy}
              />
            </label>
            <label className="space-y-1 text-xs text-slate-600">
              到
              <Input
                type="date"
                className="min-h-11"
                value={draft.sustained_note?.period_end ?? ""}
                onChange={(event) =>
                  props.onChange({
                    sustained_note: {
                      period_start: draft.sustained_note?.period_start ?? "",
                      period_end: event.target.value,
                      description: draft.sustained_note?.description ?? "",
                    },
                  })
                }
                disabled={props.busy}
              />
            </label>
          </div>
          <Textarea
            rows={2}
            value={draft.sustained_note?.description ?? ""}
            onChange={(event) =>
              props.onChange({
                sustained_note: {
                  period_start: draft.sustained_note?.period_start ?? "",
                  period_end: draft.sustained_note?.period_end ?? "",
                  description: event.target.value,
                },
              })
            }
            placeholder="期间内连续观察到的事实说明（至少 10 个字）"
            maxLength={500}
            disabled={props.busy}
          />
          {needsNote && sustainedHint ? <p className="text-xs text-amber-800">{sustainedHint}</p> : null}
        </fieldset>
      ) : null}

      <div className="space-y-2 rounded-md border bg-white px-3 py-2">
        <label className="flex min-h-11 items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={draft.adult_help_used}
            onChange={(event) => props.onChange({ adult_help_used: event.target.checked })}
            disabled={props.busy || (performance && item?.adult_help === "requires_independence")}
            data-testid="adult-help-toggle"
          />
          本次使用了成人帮助
        </label>
        {independenceConflict ? (
          <p className="text-xs text-amber-800" role="alert">
            该条目要求幼儿独立完成，有成人帮助时只能确认相关线索。
          </p>
        ) : null}
        <div className="space-y-1">
          <Label htmlFor="guide-teacher-note" className="text-xs">
            {performance && draft.adult_help_used ? "帮助方式说明（必填）" : "教师说明（选填）"}
          </Label>
          <Textarea
            id="guide-teacher-note"
            rows={2}
            value={draft.teacher_note}
            onChange={(event) => props.onChange({ teacher_note: event.target.value })}
            maxLength={500}
            disabled={props.busy}
          />
        </div>
      </div>

      {props.draftError ? (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800" role="alert" data-testid="decision-error">
          {props.draftError}
        </p>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" className="min-h-11" onClick={props.onCancel} disabled={props.busy}>
          取消
        </Button>
        <Button type="button" className="min-h-11" onClick={props.onSave} disabled={props.busy} data-testid="decision-save">
          {props.busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {props.mode === "pre_archive" ? "加入待提交选择" : "写入关联决定"}
        </Button>
      </div>
    </div>
  );
}

function BasisEditorRow(props: {
  index: number;
  entry: DecisionBasisDraft;
  sources: BasisSourceOption[];
  liveConfirmed: { highlight_quote: string; highlights: string[] } | null;
  allowRemove: boolean;
  busy: boolean;
  onChange: (patch: Partial<DecisionBasisDraft>) => void;
  onRemove: () => void;
}) {
  const { entry } = props;
  const source = props.sources.find((candidate) => candidate.id === entry.observation_id) ?? null;
  const choices = source
    ? basisQuoteChoices(source, source.is_host ? props.liveConfirmed : null)
    : [];
  const quoteMatches =
    !source || entry.quote.trim().length === 0
      ? true
      : entry.quote_source === "raw_text"
        ? source.raw_text.includes(entry.quote.trim())
        : entry.quote_field === "highlight_quote"
          ? (source.confirmed?.highlight_quote ?? props.liveConfirmed?.highlight_quote ?? "").includes(entry.quote.trim())
          : ((source.confirmed?.highlights ?? props.liveConfirmed?.highlights ?? []).some((item) =>
              item.includes(entry.quote.trim()),
            ));
  return (
    <div className="space-y-2 rounded-md border bg-white px-3 py-2" data-testid="basis-editor">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-56 flex-1 space-y-1 text-xs text-slate-600">
          依据来源 {props.index + 1}
          <select
            className="min-h-11 w-full rounded-md border bg-white px-2 text-sm text-slate-800"
            value={entry.observation_id}
            onChange={(event) =>
              props.onChange({
                observation_id: event.target.value,
                quote: "",
                quote_source: "raw_text",
                quote_field: null,
              })
            }
            disabled={props.busy}
          >
            {props.sources.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {basisSourceLabel(candidate)}
              </option>
            ))}
          </select>
        </label>
        {props.allowRemove ? (
          <Button type="button" variant="ghost" size="sm" className="min-h-11" onClick={props.onRemove} disabled={props.busy}>
            移除
          </Button>
        ) : null}
      </div>
      {choices.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {choices.slice(0, 12).map((choice) => (
            <button
              key={`${choice.quote_field ?? "raw"}-${choice.quote}`}
              type="button"
              className="min-h-11 rounded-full border bg-slate-50 px-3 py-1 text-xs text-slate-700 hover:border-emerald-300"
              onClick={() =>
                props.onChange({
                  quote: choice.quote,
                  quote_source: choice.quote_source,
                  quote_field: choice.quote_field,
                })
              }
              disabled={props.busy}
              data-testid="basis-quote-choice"
            >
              {choice.label}·「{choice.quote.length > 12 ? `${choice.quote.slice(0, 12)}…` : choice.quote}」
            </button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-amber-800">
          {source
            ? "这条来源暂时没有可点的逐字片段，请在下方直接输入原文中的连续片段。"
            : "请选择依据来源。"}
        </p>
      )}
      <div className="space-y-1">
        <Label className="text-xs">逐字引用片段（必须与来源完全一致）</Label>
        <Textarea
          rows={2}
          value={entry.quote}
          onChange={(event) => props.onChange({ quote: event.target.value })}
          maxLength={500}
          disabled={props.busy}
          data-testid="basis-quote-input"
        />
        {!quoteMatches ? (
          <p className="text-xs text-rose-700" role="alert">
            当前片段未能在所选来源位置逐字匹配，请从上方片段中选择或粘贴原文连续片段。
          </p>
        ) : null}
      </div>
    </div>
  );
}
