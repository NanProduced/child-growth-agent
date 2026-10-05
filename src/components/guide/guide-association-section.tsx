"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Link2, Loader2, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";

import { fetchWithAccountAuth } from "@/lib/accounts/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { classLabel, formatDateCn } from "@/lib/format";
import {
  basisQuoteChoices,
  guideDecisionChoiceLabels,
  guideItemRuleLine,
  guideLinkStatusLabel,
  guideOriginLabel,
  guideSupportLabel,
  isHealthReference,
  type BasisSourceOption,
  type GuideItemOption,
  type GuideWriteAccessView,
} from "@/lib/guide/association-types";
import {
  basisSourceLabel,
  decisionBasisFingerprint,
  draftToDecisionInput,
  emptyDecisionDraft,
  isPerformanceSupport,
  pendingStaleReason,
  sustainedConditionError,
  validateDecisionDraft,
  type DecisionBasisDraft,
  type DecisionDraft,
  type PendingDecisionDraft,
} from "@/lib/guide/decision-draft";
import {
  decisionIdentity,
  mutationTargetOutcome,
  parseGuideMutationResponse,
  parseHostObservationResponse,
  rawTargetOutcome,
  type MutationTarget,
} from "@/lib/guide/mutation-response";
import { GUIDE_AGE_BAND_LABELS } from "@/lib/guide/types";
import type { EvidenceLinkView, GuideEvidenceDecisionInput } from "@/lib/guide/view-types";
import type { ObservationStatus } from "@/lib/types";

/**
 * 指南条目关联操作区（G6-WRITE1 / R1）。
 *
 * - 手动关联与 AI 建议同等正式；AI 建议只在教师主动点击后请求；
 * - 每一个写入（confirm/reject/withdraw/suggest）都必须通过响应形状、宿主与目标结果核对
 *   才显示成功；HTTP 200 + 空对象/非法响应一律进入“待核对”，保留输入且不自动重发；
 * - 结果不确定时只能用已授权 GET 读回核对：确认已写入则进入已保存并只重新读取详情；
 *   确认未写入才允许教师手动重试；列表未找到宿主不能证明未写入；
 * - 待提交草稿记录建立时的服务端修订与依据指纹：任一变化即标记需重新核对，
 *   不静默更新 expectedRevision 直接提交；
 * - 保健参考条目使用“资料核对”语义，不出现行为表现的达成式或能力判断文案。
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
  /** 当前登录账号标识；变化时清空本组件内的私人草稿 */
  viewerKey: string;
  /** 服务端版本戳（updated_at/status/guide revision 等）；变化代表新的服务端状态已到达 */
  serverStamp: string;
  /** 宿主归档/整理等写入进行中：禁止同时修改关联草稿 */
  hostBusy: boolean;
  /** 宿主已保存（归档成功或读回核对）：禁止再次写入，只允许重新读取详情 */
  hostCommitted: boolean;
  onRevisionChange: (update: { revision: number; links: EvidenceLinkView[] }) => void;
  onPendingChange: (
    pending: { expectedRevision: number; decisions: GuideEvidenceDecisionInput[]; staleCount: number } | null,
  ) => void;
  onBusyChange?: (busy: boolean) => void;
}

interface PendingVerification {
  target: MutationTarget;
  message: string;
}

const NOTICE_CLASS: Record<"info" | "warning" | "error", string> = {
  info: "border-emerald-200 bg-emerald-50 text-emerald-900",
  warning: "border-amber-300 bg-amber-50 text-amber-900",
  error: "border-rose-200 bg-rose-50 text-rose-900",
};

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
  const [pending, setPending] = useState<PendingDecisionDraft[]>([]);
  const [editing, setEditing] = useState<DecisionDraft | null>(null);
  const [editorStamp, setEditorStamp] = useState<{
    basedOnRevision: number;
    sourceIds: string[];
    basisFingerprint: string | null;
  } | null>(null);
  const [staleSaveArmed, setStaleSaveArmed] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [busy, setBusy] = useState<null | "suggest" | "submit" | "terminal">(null);
  const [reading, setReading] = useState(false);
  const [notice, setNotice] = useState<{ severity: "info" | "warning" | "error"; message: string } | null>(null);
  const [unresolved, setUnresolved] = useState<PendingVerification | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [withdrawReason, setWithdrawReason] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);

  const viewerRef = useRef(props.viewerKey);
  const stampRef = useRef(props.serverStamp);
  const modeRef = useRef(props.mode);

  // 身份变化：清空前一个账号的私人草稿，不展示给另一账号
  useEffect(() => {
    if (viewerRef.current === props.viewerKey) return;
    viewerRef.current = props.viewerKey;
    setPending([]);
    setEditing(null);
    setEditorStamp(null);
    setStaleSaveArmed(false);
    setUnresolved(null);
    setNotice(null);
    setRejecting(null);
    setWithdrawing(null);
    setRejectReason("");
    setWithdrawReason("");
    setDraftError(null);
  }, [props.viewerKey]);

  // 服务端新状态到达：清掉“待读取详情”等临时锁；
  // 只有“宿主本次从未归档变为已归档/已保存”才清空未提交草稿；已归档回看刷新保留本地输入
  useEffect(() => {
    const wasPreArchive = modeRef.current === "pre_archive";
    modeRef.current = props.mode;
    if (stampRef.current === props.serverStamp) return;
    stampRef.current = props.serverStamp;
    if (props.hostCommitted || (wasPreArchive && props.mode === "archived")) {
      setPending([]);
      setEditing(null);
      setEditorStamp(null);
      setUnresolved(null);
      setRejecting(null);
      setWithdrawing(null);
    }
  }, [props.serverStamp, props.hostCommitted, props.mode]);

  const pendingStaleness = useMemo(
    () =>
      pending.map((row) => ({
        row,
        reason: pendingStaleReason(row, props.revision, props.basisSources),
      })),
    [pending, props.revision, props.basisSources],
  );
  const staleCount = pendingStaleness.filter((entry) => entry.reason !== null).length;

  useEffect(() => {
    if (!props.access.can_decide) {
      props.onPendingChange(null);
      return;
    }
    const fresh = pendingStaleness
      .filter((entry) => entry.reason === null)
      .map((entry) => draftToDecisionInput(entry.row.draft));
    props.onPendingChange(
      pending.length > 0
        ? { expectedRevision: props.revision, decisions: fresh, staleCount }
        : null,
    );
  }, [pending, pendingStaleness, staleCount, props.access.can_decide, props.revision, props.onPendingChange]);

  useEffect(() => {
    props.onBusyChange?.(busy !== null || reading);
  }, [busy, reading, props]);

  const suggestions = props.links.filter((link) => link.status === "ai_suggested");
  const activeLinks = props.links.filter(
    (link) => link.status === "confirmed_performance" || link.status === "confirmed_clue",
  );
  const terminalLinks = props.links.filter(
    (link) => link.status === "rejected" || link.status === "withdrawn",
  );
  const focusOption = props.focusItemId ? itemById.get(props.focusItemId) ?? null : null;
  const writeLocked = !props.access.can_decide || props.hostBusy || props.hostCommitted || unresolved !== null;
  const editorStaleReason = (() => {
    if (!editing || !editorStamp) return null;
    if (editorStamp.basedOnRevision !== props.revision) return "服务端关联修订已变化，请重新核对依据。";
    // 只对被打开时引用的来源做外部变化检测；教师自己切换/新增来源不算陈旧
    const stamped = decisionBasisFingerprint(
      editorStamp.sourceIds.map((observationId) => ({
        observation_id: observationId,
        quote: "",
        quote_source: "raw_text" as const,
        quote_field: null,
      })),
      props.basisSources,
    );
    if (stamped === null) return "依据来源已不可用，请重新选择依据。";
    if (editorStamp.basisFingerprint !== null && stamped !== editorStamp.basisFingerprint) {
      return "依据来源内容已变化，请重新核对引用片段。";
    }
    return null;
  })();

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
    if (writeLocked) return;
    setDraftError(null);
    setPickerQuery("");
    setStaleSaveArmed(false);
    const draft = emptyDecisionDraft(focusOption?.id ?? "", defaultBasis(props.basisSources));
    setEditing(draft);
    setEditorStamp({
      basedOnRevision: props.revision,
      sourceIds: draft.basis.map((entry) => entry.observation_id),
      basisFingerprint: decisionBasisFingerprint(draft.basis, props.basisSources),
    });
  }

  function beginFromSuggestion(link: EvidenceLinkView) {
    if (writeLocked) return;
    setDraftError(null);
    setStaleSaveArmed(false);
    const basis: DecisionBasisDraft[] = link.basis.map((entry) => ({
      observation_id: entry.observation_id,
      quote: entry.quote,
      quote_source: entry.quote_source,
      quote_field: entry.quote_field,
    }));
    const draft: DecisionDraft = {
      link_id: link.link_id,
      item_id: link.item_id,
      support: link.support ?? "clue_only",
      basis: basis.length > 0 ? basis : defaultBasis(props.basisSources),
      sustained_note: link.sustained_note,
      adult_help_used: link.adult_help_used,
      teacher_note: link.teacher_note ?? "",
    };
    setEditing(draft);
    setEditorStamp({
      basedOnRevision: props.revision,
      sourceIds: draft.basis.map((entry) => entry.observation_id),
      basisFingerprint: decisionBasisFingerprint(draft.basis, props.basisSources),
    });
  }

  function editPendingRow(row: PendingDecisionDraft) {
    if (writeLocked) return;
    setDraftError(null);
    setStaleSaveArmed(false);
    setEditing(row.draft);
    setEditorStamp({
      basedOnRevision: row.basedOnRevision,
      sourceIds: row.draft.basis.map((entry) => entry.observation_id),
      basisFingerprint: row.basisFingerprint,
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
    if (!editing || writeLocked) return;
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
    const fingerprint = decisionBasisFingerprint(editing.basis, props.basisSources);
    if (fingerprint === null) {
      setDraftError("依据来源已不可用，请重新选择依据后再保存。");
      return;
    }
    if (editorStaleReason && !staleSaveArmed) {
      setDraftError(`${editorStaleReason} 已核对依据仍有效后，请再次点击保存。`);
      setStaleSaveArmed(true);
      return;
    }
    setStaleSaveArmed(false);
    setDraftError(null);
    if (props.mode === "pre_archive") {
      const row: PendingDecisionDraft = {
        draft: editing,
        basedOnRevision: props.revision,
        basisFingerprint: fingerprint,
      };
      setPending((previous) => {
        const next = previous.filter(
          (entry) =>
            !(editing.link_id && entry.draft.link_id === editing.link_id) &&
            !(!editing.link_id && !entry.draft.link_id && entry.draft.item_id === editing.item_id),
        );
        return [...next, row];
      });
      setEditing(null);
      setEditorStamp(null);
      return;
    }
    void submitArchivedDecision(editing);
  }

  async function submitArchivedDecision(draft: DecisionDraft) {
    const item = itemById.get(draft.item_id);
    const health = item ? isHealthReference(item.evidence_type) : false;
    const decisionInput = draftToDecisionInput(draft);
    const target: MutationTarget = {
      action: "confirm",
      decision: decisionIdentity(decisionInput, draft.item_id),
    };
    setBusy("submit");
    setNotice(null);
    try {
      const res = await fetchWithAccountAuth(`/api/observations/${props.observationId}/guide-evidence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "confirm",
          expected_guide_revision: props.revision,
          decisions: [decisionInput],
        }),
      });
      const rawText = await res.text();
      const parsed = parseGuideMutationResponse(res.status, rawText, props.observationId);
      if (!parsed.ok) {
        const failure = parsed.failure;
        if (failure.kind === "http") {
          if (failure.status === 409) {
            setNotice({
              severity: "warning",
              message: `${failure.message} 请重新读取后再核对；旧决定不会自动重放。`,
            });
            router.refresh();
          } else {
            setNotice({ severity: "error", message: failure.message });
          }
        } else {
          setUnresolved({
            target,
            message: `${failure.message} 已保留输入与写入锁，请重新读取核对；系统不会自动重复提交。`,
          });
        }
        return;
      }
      if (mutationTargetOutcome(parsed.value.links, target) !== "applied") {
        setUnresolved({
          target,
          message: "响应已收到，但无法确认本次目标结果；已保留输入，请重新读取核对。",
        });
        return;
      }
      props.onRevisionChange({ revision: parsed.value.revision, links: parsed.value.links });
      setEditing(null);
      setEditorStamp(null);
      setStaleSaveArmed(false);
      setNotice({ severity: "info", message: health ? "资料核对已保存。" : "关联已按当前依据写入。" });
    } catch {
      setUnresolved({
        target,
        message: "网络中断，写入结果不确定；已保留输入与写入锁，请重新读取核对，系统不会自动重复提交。",
      });
    } finally {
      setBusy(null);
    }
  }

  async function requestSuggestions() {
    setBusy("suggest");
    setNotice(null);
    const previousIds = new Set(props.links.map((link) => link.link_id));
    try {
      const res = await fetchWithAccountAuth(`/api/observations/${props.observationId}/guide-evidence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "suggest" }),
      });
      const rawText = await res.text();
      const parsed = parseGuideMutationResponse(res.status, rawText, props.observationId);
      if (!parsed.ok) {
        const failure = parsed.failure;
        if (failure.kind === "http") {
          setNotice({ severity: "error", message: failure.message });
        } else {
          setUnresolved({
            target: { action: "suggest" },
            message: `${failure.message} 已保留当前输入，请重新读取核对；系统不会自动重试。`,
          });
        }
        return;
      }
      props.onRevisionChange({ revision: parsed.value.revision, links: parsed.value.links });
      if (parsed.value.notice?.code === "ai_link_failed") {
        setNotice({ severity: "warning", message: `AI 关联建议没有成功：${parsed.value.notice.message}你仍可以手动关联。` });
        return;
      }
      const added = parsed.value.links.filter(
        (link) => link.status === "ai_suggested" && !previousIds.has(link.link_id),
      ).length;
      setNotice({
        severity: "info",
        message:
          added > 0
            ? `AI 返回了 ${added} 条待核对建议；请逐条核对，不会自动确认。`
            : "本次核对没有新增待核对建议；你仍可以手动关联。",
      });
    } catch {
      setUnresolved({
        target: { action: "suggest" },
        message: "网络中断，AI 建议结果不确定；已保留当前输入，请重新读取核对，系统不会自动重试。",
      });
    } finally {
      setBusy(null);
    }
  }

  async function submitTerminal(action: "reject" | "withdraw", linkId: string, reason: string) {
    const target: MutationTarget = { action, link_id: linkId, reason: reason.trim() ? reason.trim() : null };
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
      const rawText = await res.text();
      const parsed = parseGuideMutationResponse(res.status, rawText, props.observationId);
      if (!parsed.ok) {
        const failure = parsed.failure;
        if (failure.kind === "http") {
          setNotice({
            severity: failure.status === 409 ? "warning" : "error",
            message:
              failure.status === 409
                ? `${failure.message} 请重新读取后再核对，旧决定不会自动重放。`
                : failure.message,
          });
          if (failure.status === 409) router.refresh();
        } else {
          setUnresolved({
            target,
            message: `${failure.message} 已保留输入与写入锁，请重新读取核对；系统不会自动重复提交。`,
          });
        }
        return;
      }
      if (mutationTargetOutcome(parsed.value.links, target) !== "applied") {
        setUnresolved({
          target,
          message: "响应已收到，但无法确认本次目标结果；已保留输入，请重新读取核对。",
        });
        return;
      }
      props.onRevisionChange({ revision: parsed.value.revision, links: parsed.value.links });
      setRejecting(null);
      setRejectReason("");
      setWithdrawing(null);
      setWithdrawReason("");
      setNotice({
        severity: "info",
        message:
          action === "reject"
            ? "已不采用这条 AI 建议；原建议保留在审计记录中。"
            : "已撤回这条关联；原依据与撤回信息保留在审计记录中。",
      });
    } catch {
      setUnresolved({
        target,
        message: "网络中断，操作结果不确定；已保留输入与写入锁，请重新读取核对，系统不会自动重复提交。",
      });
    } finally {
      setBusy(null);
    }
  }

  async function reconcile() {
    if (reading) return;
    setReading(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/observations?child_id=${encodeURIComponent(props.childId)}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      const rawText = await res.text();
      const read = parseHostObservationResponse(res.status, rawText, props.observationId);
      if (!read.ok) {
        setNotice({
          severity: "warning",
          message: `${read.message} 不能据此认为未保存；可继续重试“重新读取”，不会自动重发写入。`,
        });
        return;
      }
      if (!unresolved) {
        setNotice({ severity: "info", message: "已请求重新读取服务端状态；详情到达后会更新显示。" });
        router.refresh();
        return;
      }
      if (unresolved.target.action === "suggest") {
        setUnresolved(null);
        setNotice({ severity: "info", message: "已重新读取当前关联状态；请核对建议列表。" });
        router.refresh();
        return;
      }
      const outcome = rawTargetOutcome(read.observation.guide_evidence, unresolved.target);
      if (outcome === "applied") {
        setUnresolved(null);
        setEditing(null);
        setEditorStamp(null);
        setRejecting(null);
        setWithdrawing(null);
        // 读取成功即恢复正常操作，不依赖版本戳变化解锁；旧修订的再次写入会被服务端 409 拦下
        setNotice({
          severity: "info",
          message: "重新读取后确认本次已写入；详情将在后续刷新中更新，可继续操作（不会自动重复发送）。",
        });
        router.refresh();
        return;
      }
      if (outcome === "not_applied") {
        setUnresolved(null);
        setNotice({
          severity: "warning",
          message: "读取后确认本次没有写入；已保留输入，可核对后重试，系统不会自动重发。",
        });
        return;
      }
      setNotice({
        severity: "warning",
        message: "读取结果仍无法核对本次目标；请稍后重试“重新读取”，不会自动重发写入。",
      });
    } catch {
      setNotice({
        severity: "warning",
        message: "读取中断，无法确认写入结果；列表未找到也不代表未写入。可继续重试“重新读取”。",
      });
    } finally {
      setReading(false);
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

  function linkEvidenceType(link: EvidenceLinkView): GuideItemOption["evidence_type"] {
    return itemById.get(link.item_id)?.evidence_type ?? "behavior";
  }

  const allActiveHealth =
    activeLinks.length > 0 && activeLinks.every((link) => isHealthReference(linkEvidenceType(link)));

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
            {allActiveHealth ? `资料已核对 ${activeLinks.length}` : `已确认 ${activeLinks.length}`}
          </span>
        ) : null}
        {pending.length > 0 ? (
          <span className={`rounded-full px-2 py-0.5 text-xs ${staleCount > 0 ? "bg-rose-100 text-rose-900" : "bg-sky-100 text-sky-900"}`}>
            待随归档提交 {pending.length}
            {staleCount > 0 ? ` · 需重新核对 ${staleCount}` : ""}
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

          {props.hostCommitted ? (
            <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-900" role="status" data-testid="guide-host-committed">
              这条观察已保存归档；本区只允许重新读取详情，不能再次提交归档或修改决定。
            </p>
          ) : null}

          {unresolved ? (
            <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2" role="status" data-testid="guide-unresolved">
              <p className="flex items-center gap-1.5 text-xs font-medium text-amber-900">
                <TriangleAlert className="size-3.5" aria-hidden="true" />
                写入结果待核对
              </p>
              <p className="text-xs leading-5 text-amber-900">{unresolved.message}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11"
                onClick={() => void reconcile()}
                disabled={reading}
                data-testid="guide-reconcile"
              >
                {reading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                重新读取核对
              </Button>
            </div>
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
              className={`rounded-lg border px-3 py-2 text-xs leading-5 ${NOTICE_CLASS[notice.severity]}`}
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

          {props.access.can_decide && !props.hostCommitted ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => void requestSuggestions()}
                disabled={busy !== null || reading || unresolved !== null}
                data-testid="guide-suggest"
              >
                {busy === "suggest" ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                请求 AI 关联建议
              </Button>
              <Button type="button" className="min-h-11" onClick={beginManual} disabled={writeLocked} data-testid="guide-manual-add">
                <Link2 className="size-4" />
                手动关联条目
              </Button>
            </div>
          ) : null}

          {editing ? (
            <DecisionEditor
              draft={editing}
              itemExists={itemById.has(editing.item_id)}
              item={editing.item_id ? itemById.get(editing.item_id) ?? null : null}
              goalLabels={props.goalLabels}
              basisSources={props.basisSources}
              liveConfirmed={props.liveConfirmed}
              pickerQuery={pickerQuery}
              pickerResults={pickerResults}
              draftError={draftError}
              staleReason={editorStaleReason}
              staleSaveArmed={staleSaveArmed}
              busy={busy !== null || reading || props.hostBusy}
              disabled={props.hostCommitted || unresolved !== null}
              mode={props.mode}
              onPickerQuery={setPickerQuery}
              onChange={updateEditing}
              onBasisChange={updateBasis}
              onAddBasis={() => updateEditing({ basis: [...editing.basis, quoteFor(props.basisSources[0]?.id ?? "")] })}
              onRemoveBasis={(index) =>
                updateEditing({ basis: editing.basis.filter((_, entryIndex) => entryIndex !== index) })
              }
              onCancel={() => {
                setEditing(null);
                setEditorStamp(null);
                setStaleSaveArmed(false);
                setDraftError(null);
              }}
              onSave={saveEditing}
            />
          ) : null}

          {pending.length > 0 ? (
            <div className="space-y-2" data-testid="pending-decisions">
              <h4 className="text-xs font-medium text-slate-700">待随归档提交的选择</h4>
              {staleCount > 0 ? (
                <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-900" role="alert" data-testid="pending-stale-note">
                  有 {staleCount} 条选择的服务端修订或依据来源已变化；这些选择不会随归档提交，请逐条重新核对或移除。
                </p>
              ) : null}
              <ul className="space-y-2">
                {pendingStaleness.map(({ row, reason }, index) => {
                  const option = itemById.get(row.draft.item_id);
                  const health = option ? isHealthReference(option.evidence_type) : false;
                  const labels = guideDecisionChoiceLabels(option?.evidence_type ?? "behavior");
                  const performance = isPerformanceSupport(row.draft.support);
                  return (
                    <li
                      key={`${row.draft.link_id ?? row.draft.item_id}-${index}`}
                      className={`rounded-lg border px-3 py-2 text-xs leading-5 ${reason ? "border-rose-200 bg-rose-50/60" : "border-sky-200 bg-sky-50/60"} text-slate-800`}
                      data-testid="pending-decision"
                      data-stale={reason ? "true" : "false"}
                    >
                      <span className="font-medium">{performance ? labels.performance : labels.clue}</span>
                      <span> · {option?.text ?? row.draft.item_id}</span>
                      <span> · 依据 {row.draft.basis.length} 条{health ? "（资料核对）" : ""}</span>
                      {reason ? <span className="mt-1 block text-rose-800">需重新核对：{reason}</span> : null}
                      <span className="mt-1 flex gap-2">
                        <button
                          type="button"
                          className="min-h-11 underline"
                          onClick={() => editPendingRow(row)}
                          disabled={writeLocked}
                          data-testid="pending-edit"
                        >
                          重新核对
                        </button>
                        <button
                          type="button"
                          className="min-h-11 underline"
                          onClick={() =>
                            setPending((previous) => previous.filter((_, entryIndex) => entryIndex !== index))
                          }
                          disabled={writeLocked}
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
                    <p className="mt-1 text-xs text-slate-600">
                      {guideLinkStatusLabel(linkEvidenceType(link), link.status)} ·{" "}
                      {guideOriginLabel(linkEvidenceType(link), link.origin)}
                    </p>
                    {link.ai_reason ? <p className="mt-1 text-xs leading-5 text-slate-700">建议理由：{link.ai_reason}</p> : null}
                    <BasisList link={link} />
                    {props.access.can_decide && !props.hostCommitted ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button type="button" size="sm" className="min-h-11" onClick={() => beginFromSuggestion(link)} disabled={writeLocked} data-testid="guide-suggestion-review">
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
                                disabled={busy !== null || unresolved !== null}
                                onClick={() => void submitTerminal("reject", link.link_id, rejectReason)}
                              >
                                确认不采用
                              </Button>
                              <Button type="button" variant="ghost" size="sm" className="min-h-11" onClick={() => setRejecting(null)}>
                                取消
                              </Button>
                            </span>
                          ) : (
                            <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={() => setRejecting(link.link_id)} disabled={writeLocked} data-testid="guide-suggestion-reject">
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
              <h4 className="text-xs font-medium text-slate-700">已核对/已确认的关联</h4>
              <ul className="space-y-3">
                {activeLinks.map((link) => {
                  const evidenceType = linkEvidenceType(link);
                  const health = isHealthReference(evidenceType);
                  return (
                    <li key={link.link_id} className="rounded-lg border border-emerald-200 bg-emerald-50/40 px-3 py-3" data-testid="guide-active-link">
                      <p className="text-sm font-medium leading-6 text-slate-800">{linkItemLabel(link)}</p>
                      {linkGoalLabel(link) ? <p className="text-xs text-slate-500">{linkGoalLabel(link)}</p> : null}
                      <p className="mt-1 text-xs text-slate-600">
                        {guideLinkStatusLabel(evidenceType, link.status)}
                        {link.support ? ` · ${guideSupportLabel(evidenceType, link.support)}` : ""}
                        {" · "}
                        {guideOriginLabel(evidenceType, link.origin)}
                        {!health && link.adult_help_used ? " · 有成人帮助" : ""}
                        {link.teacher_note ? ` · ${health ? "核对说明" : "教师说明"}：${link.teacher_note}` : ""}
                      </p>
                      {link.sustained_note ? (
                        <p className="text-xs text-slate-600">
                          连续观察纪要（{formatDateCn(link.sustained_note.period_start)} 至 {formatDateCn(link.sustained_note.period_end)}）：{link.sustained_note.description}
                        </p>
                      ) : null}
                      <BasisList link={link} />
                      {props.access.can_decide && !props.hostCommitted ? (
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
                              disabled={busy !== null || unresolved !== null}
                              onClick={() => void submitTerminal("withdraw", link.link_id, withdrawReason)}
                            >
                              确认撤回
                            </Button>
                            <Button type="button" variant="ghost" size="sm" className="min-h-11" onClick={() => setWithdrawing(null)}>
                              取消
                            </Button>
                          </div>
                        ) : (
                          <Button type="button" variant="outline" size="sm" className="mt-2 min-h-11" onClick={() => setWithdrawing(link.link_id)} disabled={writeLocked} data-testid="guide-withdraw">
                            撤回
                          </Button>
                        )
                      ) : null}
                    </li>
                  );
                })}
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
                    <span> · {guideLinkStatusLabel(linkEvidenceType(link), link.status)}</span>
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
  itemExists: boolean;
  item: GuideItemOption | null;
  goalLabels: Record<string, string>;
  basisSources: BasisSourceOption[];
  liveConfirmed: { highlight_quote: string; highlights: string[] } | null;
  pickerQuery: string;
  pickerResults: GuideItemOption[];
  draftError: string | null;
  staleReason: string | null;
  staleSaveArmed: boolean;
  busy: boolean;
  disabled: boolean;
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
  const item = props.item;
  const health = item ? isHealthReference(item.evidence_type) : false;
  const choiceLabels = guideDecisionChoiceLabels(item?.evidence_type ?? "behavior");
  const sourceById = useMemo(
    () => new Map(props.basisSources.map((source) => [source.id, source])),
    [props.basisSources],
  );
  const performance = isPerformanceSupport(draft.support);
  const sustainedRequired = !health && item?.evidence_type === "sustained";
  const days = new Set(
    draft.basis
      .map((entry) => sourceById.get(entry.observation_id)?.observed_at)
      .filter((value): value is string => Boolean(value)),
  );
  const needsNote = !health && draft.support === "sustained" && days.size < 2;
  const independenceConflict = !health && performance && draft.adult_help_used && item?.adult_help === "requires_independence";
  const sustainedHint =
    !health && draft.support === "sustained"
      ? sustainedConditionError(
          draft.basis.map((entry) => ({ observed_at: sourceById.get(entry.observation_id)?.observed_at ?? "" })),
          draft.sustained_note,
        )
      : null;

  return (
    <div className="space-y-4 rounded-lg border border-slate-300 bg-slate-50/60 px-3 py-3" data-testid="decision-editor">
      {item ? (
        <div>
          <p className="text-sm font-medium leading-6 text-slate-800">{item.text}</p>
          <p className="text-xs text-slate-500">
            {props.goalLabels[item.goal_id] ?? "未定位目标"} · {guideItemRuleLine(item)}
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
            disabled={props.busy || props.disabled}
          />
          {props.draftError && !props.itemExists ? (
            <p className="text-xs text-rose-700">{props.draftError}</p>
          ) : null}
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
                    disabled={props.busy || props.disabled}
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
        <legend className="text-xs font-medium text-slate-700">{health ? "资料核对决定" : "教师决定"}</legend>
        <div className="flex flex-wrap gap-2">
          <label className="flex min-h-11 items-center gap-2 rounded-md border bg-white px-3 py-2 text-sm">
            <input
              type="radio"
              name={`decision-${draft.item_id}`}
              checked={draft.support === "clue_only"}
              onChange={() => props.onChange({ support: "clue_only" })}
              disabled={props.busy || props.disabled}
            />
            {choiceLabels.clue}
          </label>
          <label className="flex min-h-11 items-center gap-2 rounded-md border bg-white px-3 py-2 text-sm">
            <input
              type="radio"
              name={`decision-${draft.item_id}`}
              checked={performance}
              onChange={() => props.onChange({ support: sustainedRequired ? "sustained" : "single_event" })}
              disabled={props.busy || props.disabled}
              data-testid="decision-performance"
            />
            {choiceLabels.performance}
          </label>
        </div>
        {!health && performance && !sustainedRequired ? (
          <div className="flex flex-wrap gap-2 text-xs text-slate-600">
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="radio"
                name={`support-${draft.item_id}`}
                checked={draft.support === "single_event"}
                onChange={() => props.onChange({ support: "single_event" })}
                disabled={props.busy || props.disabled}
              />
              单次表现（一次充分证据）
            </label>
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="radio"
                name={`support-${draft.item_id}`}
                checked={draft.support === "sustained"}
                onChange={() => props.onChange({ support: "sustained" })}
                disabled={props.busy || props.disabled}
              />
              持续表现（跨日证据或纪要）
            </label>
          </div>
        ) : null}
        {sustainedRequired && performance ? (
          <p className="text-xs leading-5 text-slate-600">该条目属于持续性表现，确认表现必须使用持续表现支持；也可改为确认线索。</p>
        ) : null}
        {health ? (
          <p className="text-xs leading-5 text-slate-500">
            保健参考资料只做查阅与核对记录；不参与行为统计，也不构成“正常/异常”等健康结论。
          </p>
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
            disabled={props.busy || props.disabled || draft.basis.length >= 10}
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
            disabled={props.disabled}
            onChange={(patch) => props.onBasisChange(index, patch)}
            onRemove={() => props.onRemoveBasis(index)}
          />
        ))}
      </div>

      {!health && draft.support === "sustained" ? (
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
                disabled={props.busy || props.disabled}
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
                disabled={props.busy || props.disabled}
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
            disabled={props.busy || props.disabled}
          />
          {needsNote && sustainedHint ? <p className="text-xs text-amber-800">{sustainedHint}</p> : null}
        </fieldset>
      ) : null}

      <div className="space-y-2 rounded-md border bg-white px-3 py-2">
        {!health ? (
          <>
            <label className="flex min-h-11 items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={draft.adult_help_used}
                onChange={(event) => props.onChange({ adult_help_used: event.target.checked })}
                disabled={props.busy || props.disabled || (performance && item?.adult_help === "requires_independence")}
                data-testid="adult-help-toggle"
              />
              本次使用了成人帮助
            </label>
            {independenceConflict ? (
              <p className="text-xs text-amber-800" role="alert">
                该条目要求幼儿独立完成，有成人帮助时只能确认相关线索。
              </p>
            ) : null}
          </>
        ) : null}
        <div className="space-y-1">
          <Label htmlFor="guide-teacher-note" className="text-xs">
            {!health && performance && draft.adult_help_used ? "帮助方式说明（必填）" : health ? "核对说明（选填）" : "教师说明（选填）"}
          </Label>
          <Textarea
            id="guide-teacher-note"
            rows={2}
            value={draft.teacher_note}
            onChange={(event) => props.onChange({ teacher_note: event.target.value })}
            maxLength={500}
            disabled={props.busy || props.disabled}
          />
        </div>
      </div>

      {props.staleReason ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="alert" data-testid="editor-stale">
          {props.staleReason}
          {props.staleSaveArmed ? " 已核对依据仍有效，请再次点击保存。" : ""}
        </p>
      ) : null}

      {props.draftError ? (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800" role="alert" data-testid="decision-error">
          {props.draftError}
        </p>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" className="min-h-11" onClick={props.onCancel} disabled={props.busy}>
          取消
        </Button>
        <Button
          type="button"
          className="min-h-11"
          onClick={props.onSave}
          disabled={props.busy || props.disabled}
          data-testid="decision-save"
        >
          {props.busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {props.mode === "pre_archive"
            ? "加入待提交选择"
            : props.staleSaveArmed
              ? "依据仍有效，继续保存"
              : health
                ? "保存资料核对决定"
                : "写入关联决定"}
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
  disabled: boolean;
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
            disabled={props.busy || props.disabled}
          >
            {props.sources.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {basisSourceLabel(candidate)}
              </option>
            ))}
          </select>
        </label>
        {props.allowRemove ? (
          <Button type="button" variant="ghost" size="sm" className="min-h-11" onClick={props.onRemove} disabled={props.busy || props.disabled}>
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
              disabled={props.busy || props.disabled}
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
          disabled={props.busy || props.disabled}
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
