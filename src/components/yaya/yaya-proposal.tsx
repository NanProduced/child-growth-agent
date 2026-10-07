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
import {
  GUIDE_EVIDENCE_QUOTE_FIELDS,
  GUIDE_EVIDENCE_QUOTE_SOURCES,
  GUIDE_EVIDENCE_SUPPORT_KINDS,
} from "@/lib/guide/types";
import {
  confirmObservationSchema,
  guideEvidenceBasisInputSchema,
  guideEvidenceDecisionSchema,
  guideEvidenceMutationSchema,
} from "@/lib/validation";
import { yayaDomainPayloadWireSchema } from "@/lib/yaya/api-contract";
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

const GUIDE_ACTION_LABEL: Record<string, string> = {
  suggest: "提出建议",
  confirm: "确认关联",
  reject: "拒绝关联",
  withdraw: "撤回关联",
};

const CLASS_STAGE_LABEL: Record<string, string> = {
  small: "小班",
  middle: "中班",
  large: "大班",
};

const TEACHER_OPERATION_LABEL: Record<string, string> = {
  create: "建立账号",
  set_status: "修改状态",
  reset_password: "重置密码",
  assign_class: "分配任教班级",
  remove_assignment: "移除任教班级",
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

interface ProposalContentDetails {
  payload: YayaDomainPayload | null;
  targetLabel: string | null;
  lines: string[];
  missing: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readText(value: unknown, keys: readonly string[]): string | null {
  const record = asRecord(value);
  if (record === null) return null;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  return null;
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isNonBlank(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isGuideBasis(value: unknown): boolean {
  const parsed = guideEvidenceBasisInputSchema.safeParse(value);
  if (!parsed.success) return false;
  const source = parsed.data.quote_source;
  const field = parsed.data.quote_field ?? null;
  if (!(GUIDE_EVIDENCE_QUOTE_SOURCES as readonly string[]).includes(source)) return false;
  if (source === "raw_text") return field === null;
  return (GUIDE_EVIDENCE_QUOTE_FIELDS as readonly string[]).includes(field ?? "");
}

function isGuideDecision(value: unknown): boolean {
  const parsed = guideEvidenceDecisionSchema.safeParse(value);
  if (!parsed.success) return false;
  if (!(GUIDE_EVIDENCE_SUPPORT_KINDS as readonly string[]).includes(parsed.data.support)) return false;
  const note = parsed.data.sustained_note;
  if (note !== undefined && note.period_start > note.period_end) return false;
  return parsed.data.basis.every(isGuideBasis);
}

function isGuideMutation(value: unknown): boolean {
  const parsed = guideEvidenceMutationSchema.safeParse(value);
  if (!parsed.success) return false;
  if (parsed.data.action !== "confirm") return true;
  return parsed.data.decisions.every(isGuideDecision);
}

function isConfirmInput(value: unknown): boolean {
  const parsed = confirmObservationSchema.safeParse(value);
  if (!parsed.success) return false;
  const guide = parsed.data.guide_decisions;
  return guide === undefined || guide.decisions.every(isGuideDecision);
}

function decodeProposalPayload(value: unknown): YayaDomainPayload | null {
  const parsed = yayaDomainPayloadWireSchema.safeParse(value);
  if (!parsed.success) return null;
  const payload = parsed.data;
  const record = asRecord(payload);
  if (record === null) return null;
  switch (payload.kind) {
    case "create_observation":
      return isNonBlank(record.child_id) &&
        isNonBlank(record.observed_at) &&
        isNonBlank(record.raw_text) &&
        isNullableString(record.context) &&
        isNullableString(record.confirmed_class_id) &&
        isStringArray(record.image_ids) &&
        (record.source_input === null || asRecord(record.source_input) !== null)
        ? payload
        : null;
    case "organize_observation":
      return isNonBlank(record.observation_id) ? payload : null;
    case "follow_up_observation":
      return isNonBlank(record.observation_id) && isNonBlank(record.action) && isNonBlank(record.content)
        ? payload
        : null;
    case "confirm_observation":
      return isNonBlank(record.observation_id) && isConfirmInput(record.input) ? payload : null;
    case "guide_decision":
      return isNonBlank(record.observation_id) && isGuideMutation(record.mutation) ? payload : null;
    case "create_child":
      return (
        isNonBlank(record.name) &&
        isNonBlank(record.gender) &&
        isNonBlank(record.birth_date) &&
        isNonBlank(record.target_class_id) &&
        isNullableString(record.note)
      )
        ? payload
        : null;
    case "transfer_child":
      return isNonBlank(record.child_id) && isNonBlank(record.target_class_id) && isNullableString(record.effective_date)
        ? payload
        : null;
    case "manage_class":
      return (
        isNonBlank(record.operation) &&
        isNullableString(record.class_id) &&
        isNonBlank(record.name) &&
        isNonBlank(record.stage) &&
        isNonBlank(record.school_year) &&
        (record.is_active === null || typeof record.is_active === "boolean")
      )
        ? payload
        : null;
    case "manage_teacher":
      return (
        isNonBlank(record.operation) &&
        isNullableString(record.teacher_account_id) &&
        isNullableString(record.username) &&
        isNullableString(record.display_name) &&
        isStringArray(record.class_ids) &&
        isNullableString(record.status) &&
        record.secret_via_secure_control === true
      )
        ? payload
        : null;
    case "refresh_growth_profile":
    case "refresh_activity_support":
      return isNonBlank(record.child_id) ? payload : null;
    case "attach_observation_images":
      return (
        isNonBlank(record.observation_id) &&
        isStringArray(record.image_ids) &&
        typeof record.expected_attachment_revision === "number" &&
        isNullableString(record.source_confirmed_at)
      )
        ? payload
        : null;
  }
}

export function proposalPayloadIsReviewable(value: unknown): boolean {
  return decodeProposalPayload(value) !== null;
}

function addLine(lines: string[], label: string, value: unknown): void {
  if (typeof value === "string" && value.trim() !== "") lines.push(label + "：" + value);
  else if (typeof value === "number" || typeof value === "boolean") lines.push(label + "：" + String(value));
}

function addStringList(lines: string[], label: string, values: readonly string[]): void {
  if (values.length === 0) return;
  lines.push(label + "：");
  values.forEach((value, index) => lines.push("  " + String(index + 1) + ". " + value));
}

function guideDecisionLines(lines: string[], value: unknown, title: string): void {
  const record = asRecord(value);
  if (record === null) return;
  addLine(lines, title + "动作", GUIDE_ACTION_LABEL[String(record.action)] ?? record.action);
  addLine(lines, title + "指南修订", record.expected_guide_revision);
  addLine(lines, title + "关联标识", record.link_id);
  addLine(lines, title + "撤回/拒绝理由", record.reason);
  const decisions = Array.isArray(record.decisions) ? record.decisions : [];
  decisions.forEach((decision, index) => {
    const entry = asRecord(decision);
    if (entry === null) return;
    const prefix = title + "第 " + String(index + 1) + " 项";
    addLine(lines, prefix + "条目", entry.item_label ?? entry.item_id ?? entry.link_id);
    addLine(lines, prefix + "决定", entry.support);
    addLine(lines, prefix + "成人帮助", entry.adult_help_used);
    addLine(lines, prefix + "备注", entry.teacher_note);
    const basis = Array.isArray(entry.basis) ? entry.basis : [];
    basis.forEach((basisEntry, basisIndex) => {
      const basisRecord = asRecord(basisEntry);
      if (basisRecord === null) return;
      addLine(lines, prefix + "依据 " + String(basisIndex + 1) + " 引文", basisRecord.quote);
      addLine(lines, prefix + "依据 " + String(basisIndex + 1) + "来源", basisRecord.quote_source);
      addLine(lines, prefix + "依据 " + String(basisIndex + 1) + "字段", basisRecord.quote_field);
    });
    const sustained = asRecord(entry.sustained_note);
    if (sustained !== null) {
      addLine(lines, prefix + "期间开始", sustained.period_start);
      addLine(lines, prefix + "期间结束", sustained.period_end);
      addLine(lines, prefix + "持续性纪要", sustained.description);
    }
  });
}

function proposalContentDetails(item: ProjectedProposalItem): ProposalContentDetails {
  const payload = decodeProposalPayload(item.payload);
  if (payload === null) {
    return { payload: null, targetLabel: null, lines: [], missing: ["内容格式无法核对"] };
  }
  const lines: string[] = [];
  const missing: string[] = [];
  const payloadRecord = asRecord(payload);
  const resourceRecord = asRecord(item.resource_ref);
  const childName =
    readText(payload, ["child_name", "childName"]) ??
    readText(resourceRecord, ["child_name", "childName", "label"]);
  const observationLabel =
    readText(payload, ["observation_label", "observation_name"]) ??
    readText(resourceRecord, ["observation_label", "observation_name", "label"]);
  const className =
    readText(payload, ["class_name", "target_class_name", "targetClassName"]) ??
    readText(resourceRecord, ["class_name", "target_class_name", "targetClassName", "label"]);
  let targetLabel: string | null = null;

  switch (payload.kind) {
    case "create_observation":
      targetLabel = childName;
      if (targetLabel === null) missing.push("幼儿名称");
      addLine(lines, "观察日期", payload.observed_at);
      addLine(lines, "情境", payload.context);
      addLine(lines, "原始观察", payload.raw_text);
      addLine(lines, "关联图片", payload.image_ids.length + " 张");
      break;
    case "organize_observation":
      targetLabel = childName ?? observationLabel;
      if (targetLabel === null) missing.push("幼儿或观察名称");
      missing.push("待整理的原文与草稿");
      addLine(lines, "整理目标", "服务端准备内容未随当前投影提供");
      break;
    case "follow_up_observation":
      targetLabel = childName ?? observationLabel;
      if (targetLabel === null) missing.push("幼儿或观察名称");
      addLine(lines, "补充内容", payload.content);
      break;
    case "confirm_observation":
      targetLabel = childName ?? observationLabel;
      if (targetLabel === null) missing.push("幼儿或观察名称");
      const confirmedObservedAt = readText(payloadRecord, ["observed_at", "observation_date"]);
      const confirmedRawText = readText(payloadRecord, ["raw_text", "observation_text"]);
      if (confirmedObservedAt === null) missing.push("观察日期");
      if (confirmedRawText === null) missing.push("原始观察");
      addLine(lines, "观察日期", confirmedObservedAt);
      addLine(lines, "原始观察", confirmedRawText);
      addLine(lines, "教师确认稿·领域", payload.input.content.domain);
      addLine(lines, "教师确认稿·子领域", payload.input.content.sub_domain);
      addLine(lines, "教师确认稿·目标描述", payload.input.content.objective_description);
      addStringList(lines, "教师确认稿·发展亮点", payload.input.content.highlights);
      addStringList(lines, "教师确认稿·支持建议", payload.input.content.support_suggestions);
      addLine(lines, "教师确认稿·原文引句", payload.input.content.highlight_quote);
      addLine(lines, "教师备注", payload.input.teacher_note);
      addLine(lines, "澄清补充", payload.input.clarification);
      if (payload.input.guide_decisions !== undefined) {
        guideDecisionLines(lines, payload.input.guide_decisions, "归档时指南决定");
      }
      break;
    case "guide_decision":
      targetLabel = childName ?? observationLabel;
      if (targetLabel === null) missing.push("幼儿或观察名称");
      guideDecisionLines(lines, payload.mutation, "指南决定");
      if (payload.mutation.action === "confirm") {
        const mutation = asRecord(payload.mutation);
        if (mutation === null || !Array.isArray(mutation.decisions) || mutation.decisions.length === 0) {
          missing.push("指南条目与依据");
        }
      }
      break;
    case "create_child":
      targetLabel = payload.name;
      addLine(lines, "性别", payload.gender);
      addLine(lines, "出生日期", payload.birth_date);
      addLine(lines, "目标班级", className);
      addLine(lines, "备注", payload.note);
      if (className === null) missing.push("目标班级名称");
      break;
    case "transfer_child":
      targetLabel = childName !== null && className !== null ? childName + " → " + className : null;
      addLine(lines, "幼儿", childName);
      addLine(lines, "目标班级", className);
      addLine(lines, "生效日期", payload.effective_date);
      if (childName === null) missing.push("幼儿名称");
      if (className === null) missing.push("目标班级名称");
      if (payload.effective_date === null) missing.push("生效日期");
      break;
    case "manage_class":
      targetLabel = payload.name;
      addLine(lines, "班级", payload.name);
      addLine(lines, "动作", payload.operation === "create" ? "新建" : "修改");
      addLine(lines, "学段", CLASS_STAGE_LABEL[payload.stage] ?? payload.stage);
      addLine(lines, "学年", payload.school_year);
      addLine(lines, "启用状态", payload.is_active);
      break;
    case "manage_teacher":
      targetLabel = payload.display_name ?? payload.username;
      addLine(lines, "账号", payload.username);
      addLine(lines, "动作", TEACHER_OPERATION_LABEL[payload.operation] ?? payload.operation);
      addLine(lines, "状态", payload.status === "active" ? "启用" : payload.status === "disabled" ? "停用" : payload.status);
      addLine(lines, "任教班级技术标识", payload.class_ids.join("、"));
      if (targetLabel === null) missing.push("教师姓名或账号");
      if (payload.operation === "assign_class" && payload.class_ids.length === 0) missing.push("目标班级");
      lines.push("密码等秘密不会进入聊天；如需改密，必须通过安全控件。");
      break;
    case "refresh_growth_profile":
      targetLabel = childName;
      if (targetLabel === null) missing.push("幼儿名称");
      break;
    case "refresh_activity_support":
      targetLabel = childName;
      if (targetLabel === null) missing.push("幼儿名称");
      break;
    case "attach_observation_images":
      targetLabel = childName ?? observationLabel;
      if (targetLabel === null) missing.push("幼儿或观察名称");
      addLine(lines, "追加图片", payload.image_ids.length + " 张");
      addLine(lines, "附件修订前提", payload.expected_attachment_revision);
      addLine(lines, "确认来源时间", payload.source_confirmed_at);
      break;
    default:
      break;
  }

  if (payloadRecord !== null && targetLabel === null) {
    targetLabel = readText(payloadRecord, ["target_label", "label"]);
  }
  return { payload, targetLabel, lines, missing: [...new Set(missing)] };
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
      ? success
        ? "已保存（服务端回执核对一致）"
        : "回执缺少完整成功证明"
      : outcome.kind === "saved_detail_unavailable"
        ? success
          ? "已保存，详情暂不可读"
          : "回执缺少完整成功证明"
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
          className="inline-flex h-11 items-center gap-1 rounded-md border px-2 text-xs"
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
  const detailsByOperation = useMemo(
    () => new Map(items.map((item) => [item.operation_id, proposalContentDetails(item)] as const)),
    [items]
  );
  const eligible = useMemo(
    () =>
      items.filter(
        (item) =>
          item.status === "pending" &&
          item.access === "full" &&
          item.payload !== null &&
          (detailsByOperation.get(item.operation_id)?.missing.length ?? 1) === 0 &&
          results[item.operation_id] === undefined
      ),
    [detailsByOperation, items, results]
  );
  const selectedIds = useMemo(() => eligible.filter((item) => selected.has(item.operation_id)).map((item) => item.operation_id), [eligible, selected]);
  const busy = phase === "approving" || phase === "executing";

  const lockUnknown = (operationIds: readonly string[]) => {
    setResults((current) => {
      const next = { ...current };
      for (const operationId of operationIds) {
        if (next[operationId] === undefined) next[operationId] = { kind: "unknown", reason: "no_receipt" };
      }
      return next;
    });
    setSelected(new Set());
  };

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
    const submittedIds = [...selectedIds];
    let approvalRecorded = false;
    setActionError(null);
    setPhase("approving");
    try {
      const approval = await approveProposalItems(proposal.proposal_id, submittedIds);
      approvalRecorded = true;
      setPhase("executing");
      const plan = planFromProjection(
        proposal,
        { accountId: principal.account_id, role: principal.role, displayName: principal.display_name },
        submittedIds
      );
      const outcome = await executeApprovedOperations(plan, approval.approval_id, submittedIds);
      if (outcome.kind === "rejected") {
        lockUnknown(submittedIds);
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
      if (approvalRecorded) lockUnknown(submittedIds);
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
      const expected =
        proposal === null || principal === null
          ? undefined
          : planFromProjection(
              proposal,
              { accountId: principal.account_id, role: principal.role, displayName: principal.display_name },
              [operationId]
            )[0];
      const result = await queryOriginalOperation(operationId, expected ?? null);
      setResults((current) => ({ ...current, [result.operation_id]: result.outcome }));
    } catch {
      setActionError("读取暂未完成，这不代表没有数据；仍按结果未知处理。");
    } finally {
      setCheckingId(null);
    }
  };

  const savedCount = Object.values(results).filter((entry) => receiptShowsSuccess(entry)).length;
  const pendingCount = eligible.length;
  const restrictedCount = items.length - eligible.length;

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
            <span className="w-full text-xs text-muted-foreground">
              可提交 {pendingCount} · 已选 {selectedIds.length} · 受限/待补 {restrictedCount}
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
          <Button type="button" variant="outline" size="sm" className="h-11" onClick={() => void load()}>
            <RefreshCw className="size-3.5" aria-hidden /> 重新读取
          </Button>
        </div>
      ) : null}

      <div className="mt-3 space-y-3">
        {items.map((item) => {
          const outcome = results[item.operation_id];
          const details = detailsByOperation.get(item.operation_id) ?? {
            payload: null,
            targetLabel: null,
            lines: [],
            missing: ["内容当前不可读"],
          };
          const eligibleItem =
            item.status === "pending" &&
            item.access === "full" &&
            item.payload !== null &&
            details.missing.length === 0 &&
            outcome === undefined;
          const summary = payloadSummary(details.payload);
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
                    </Badge>
                    <Badge
                      variant="secondary"
                      className={cn(
                        "text-xs",
                        item.access === "full"
                          ? details.missing.length === 0
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-amber-100 text-amber-700"
                          : item.access === "historical_read_only"
                            ? "bg-sky-100 text-sky-700"
                            : "bg-rose-100 text-rose-700"
                      )}
                    >
                      {item.access === "full"
                        ? details.missing.length === 0
                          ? "内容可核对"
                          : "内容需补齐"
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
                  <p className="text-sm font-medium text-foreground">
                    核对对象：{details.targetLabel ?? "名称未提供"}
                  </p>
                  {(details.lines.length > 0 ? details.lines : summary.lines).map((line, index) => (
                    <p key={index} className="whitespace-pre-wrap text-sm text-foreground/90">
                      {line}
                    </p>
                  ))}
                  {item.target_id !== null ? (
                    <details className="text-xs text-muted-foreground">
                      <summary className="cursor-pointer py-1">查看技术标识（仅作审计）</summary>
                      <p className="break-all pt-1">目标标识：{item.target_id}</p>
                      <p className="break-all">操作标识：{item.operation_id}</p>
                    </details>
                  ) : null}
                  {details.missing.length > 0 ? (
                    <p className="text-xs text-amber-700">
                      批准前还需核对：{details.missing.join("、")}。当前不会提交此项。
                    </p>
                  ) : null}
                  {galleryImage !== null ? (
                    <YayaAttachmentGallery images={[galleryImage]} onOpen={(image) => setViewer(image)} />
                  ) : item.attachment_associations.length > 0 ? (
                    <p className="text-xs text-muted-foreground">关联图片当前不可读或仅保留元数据。</p>
                  ) : null}
                  {!eligibleItem && outcome === undefined ? (
                    <p className="text-xs text-amber-700">
                      {item.status !== "pending"
                        ? "该项已处理，不能再次提交。"
                        : details.missing.length > 0
                          ? "目标或实际写入内容不完整；不会随整批提交。"
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
