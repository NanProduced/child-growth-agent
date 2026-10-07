/**
 * 消息与会话标题的当前来源投影（DATA1）。
 *
 * 投影只依据服务端当前事实：owner 边界先于角色；逐来源用 AUTH 授权核验；
 * 标题/正文/附件/元数据按冻结投影输出；损坏内容一律 unavailable，不默认 full。
 * GET 路径不写库、不续期、不调用模型。
 */
import type { TransactionClient } from "@/storage/database/pg-client";
import type { Principal } from "../../accounts/types";
import {
  projectChatMessage,
  projectConversationTitle,
  type YayaAttachmentProjection,
  type YayaChatMessageProjection,
  type YayaChatMessageRef,
  type YayaEvaluatedAttachment,
  type YayaFragmentProjection,
} from "../types";
import type {
  YayaConversationSummaryView,
  YayaConversationView,
  YayaMessageRole,
  YayaProjectedFragmentView,
  YayaProjectedMessageView,
  YayaStoredFragment,
} from "../storage-types";
import { parseYayaChatRecoveryMark, restrictYayaAssistantProjection } from "../chat-bind-contract";
import type { YayaChatRecoveryMark } from "../chat-bind-contract";
import { evaluateAttachmentAccess, evaluateFragmentSources } from "./access-facts";
import {
  effectiveYayaBindingState,
  projectStoredMessageText,
  redactProvenanceForVisibility,
  yayaAssistantReadPolicy,
} from "./invariants";
import {
  isoRequired,
  parseStoredFragments,
  parseStringArray,
  toConversationView,
  type YayaConversationRow,
  type YayaMessageRow,
} from "./rows";

/** 附件评估结论 → 冻结附件投影 DTO（与聊天附件投影同一口径） */
export function toAttachmentProjection(evaluation: YayaEvaluatedAttachment): YayaAttachmentProjection {
  switch (evaluation.access) {
    case "full":
      return { attachment_id: evaluation.attachment_id, readable: true, metadata_only: false, reason: "ok" };
    case "historical_read_only":
      return {
        attachment_id: evaluation.attachment_id,
        readable: false,
        metadata_only: true,
        reason: "metadata_only_historical",
      };
    case "denied":
      return {
        attachment_id: evaluation.attachment_id,
        readable: false,
        metadata_only: false,
        reason: "source_denied",
      };
    case "unavailable":
      return {
        attachment_id: evaluation.attachment_id,
        readable: false,
        metadata_only: false,
        reason: "source_unavailable",
      };
    case "broken":
      return {
        attachment_id: evaluation.attachment_id,
        readable: false,
        metadata_only: false,
        reason: "source_broken",
      };
  }
}

/** 与冻结 `projectChatMessage`（types.ts）同一组合口径，用于守门后重算消息级可见性 */
function combineProjectionVisibility(
  fragments: readonly YayaFragmentProjection[],
  attachments: readonly YayaAttachmentProjection[],
): YayaChatMessageProjection["visibility"] {
  const visible = fragments.filter((fragment) => fragment.visibility !== "hidden");
  let visibility: YayaChatMessageProjection["visibility"];
  if (fragments.length === 0) {
    visibility = "full";
  } else if (visible.length === fragments.length) {
    visibility = visible.every((fragment) => fragment.visibility === "full") ? "full" : "partial";
  } else if (visible.length > 0) {
    visibility = "partial";
  } else {
    const reasons = new Set(fragments.map((fragment) => fragment.reason));
    visibility =
      reasons.has("source_unavailable") || reasons.has("evaluation_missing") ? "unavailable" : "hidden";
  }
  if (visibility === "full" && attachments.some((attachment) => !attachment.readable)) {
    visibility = "partial";
  }
  if (visibility === "full" && attachments.length > 0 && attachments.every((a) => a.metadata_only)) {
    visibility = "metadata_only";
  }
  return visibility;
}

/**
 * 逐片段可信守门（主评审 P1-B）：空来源且未证明独立的片段不得因消息内
 * 其他片段的可读来源保持正文——整段绑定的来源并集只做消息级判定，不给
 * 单个片段兜底。非 user 消息适用；已 hidden 的片段保持原样。
 */
function enforceFragmentTrust(
  projection: YayaChatMessageProjection,
  fragments: readonly YayaStoredFragment[],
): YayaChatMessageProjection {
  let changed = false;
  const guarded = projection.fragments.map((fragmentProjection, index) => {
    const stored = fragments[index];
    if (stored === undefined) return fragmentProjection;
    if (
      stored.sources.length === 0 &&
      !stored.independently_readable &&
      fragmentProjection.visibility !== "hidden"
    ) {
      changed = true;
      return { ...fragmentProjection, visibility: "hidden" as const, reason: "source_unavailable" as const };
    }
    return fragmentProjection;
  });
  if (!changed) return projection;
  return {
    ...projection,
    fragments: guarded,
    visibility: combineProjectionVisibility(guarded, projection.attachments),
  };
}

async function projectFragments(
  client: TransactionClient,
  principal: Principal,
  schoolId: string,
  ownerAccountId: string,
  conversationId: string,
  role: YayaMessageRole,
  bindingState: string | null,
  fragments: readonly YayaStoredFragment[],
  attachments: readonly string[],
): Promise<{ projection: YayaChatMessageProjection; fragments: YayaProjectedFragmentView[] }> {
  const reference: YayaChatMessageRef = {
    message_id: "",
    owner_account_id: ownerAccountId,
    session_id: conversationId,
    created_at: null,
    message_kind: "mixed",
    execution_state: "none",
    fragments: fragments.map((fragment) => ({
      fragment_id: fragment.fragment_id,
      sources: fragment.sources,
      independently_readable: fragment.independently_readable,
    })),
    attachment_ids: attachments,
  };
  const evaluatedSources = await evaluateFragmentSources(client, principal, schoolId, fragments);
  const evaluatedAttachments = await evaluateAttachmentAccess(client, principal, schoolId, attachments);
  const baseProjection = projectChatMessage(
    reference,
    { account_id: principal.account_id, role: principal.role },
    evaluatedSources,
    evaluatedAttachments,
  );
  // 读侧绑定兜底：正文/provenance/标题一律基于限制后的投影（绑定不可信时整段降级）
  let projection =
    role === "user"
      ? baseProjection
      : restrictYayaAssistantProjection(baseProjection, {
          role,
          policy: yayaAssistantReadPolicy(bindingState, fragments),
        });
  if (role !== "user") {
    projection = enforceFragmentTrust(projection, fragments);
  }
  const visible = projectStoredMessageText(fragments, projection.fragments);
  const projectedFragments: YayaProjectedFragmentView[] = fragments.map((fragment, index) => {
    const fragmentProjection: YayaFragmentProjection = projection.fragments[index] ?? {
      fragment_id: fragment.fragment_id,
      visibility: "hidden",
      reason: "evaluation_missing",
    };
    const entry = visible[index];
    const visibility = entry?.visibility ?? "hidden";
    return {
      fragment_id: fragment.fragment_id,
      visibility,
      reason: fragmentProjection.reason,
      text: entry?.text ?? null,
      provenance: redactProvenanceForVisibility(visibility, fragment.provenance),
      independently_readable: fragment.independently_readable,
    };
  });
  return { projection, fragments: projectedFragments };
}

/** 恢复标记投影：无标记 / 损坏 / 旧消息一律 null（不猜测、不补默认） */
function parseRecoveryMark(value: unknown): YayaChatRecoveryMark | null {
  if (value === null || value === undefined) return null;
  const parsed = parseYayaChatRecoveryMark(value);
  return parsed.ok ? parsed.value : null;
}

export async function projectMessageRow(
  client: TransactionClient,
  principal: Principal,
  schoolId: string,
  row: YayaMessageRow,
): Promise<YayaProjectedMessageView> {
  // 恢复标记：结构解析 ≠ 关联证明（P1-B）——必须与行 owner/conversation/run 一致，
  // 缺失、损坏或关联不符一律 null，且绑定按无法核验降级；不改写原行。
  const structuralRecovery = parseRecoveryMark(row.recovery_mark);
  const hasMark = row.recovery_mark !== null && row.recovery_mark !== undefined;
  const recoveryLinked =
    structuralRecovery !== null &&
    structuralRecovery.conversation_id === row.conversation_id &&
    structuralRecovery.owner_account_id === row.owner_account_id &&
    structuralRecovery.run !== null &&
    structuralRecovery.run.run_id === row.run_id;
  const recovery = recoveryLinked ? structuralRecovery : null;
  const bindingState = effectiveYayaBindingState(
    row.binding_state,
    row.run_id,
    hasMark && !recoveryLinked,
  );
  const parsed = parseStoredFragments(row.fragments);
  const attachmentIds = parseStringArray(row.attachment_ids);
  const corrupt = parsed.corrupt || attachmentIds === null;
  const ids = attachmentIds ?? [];
  const createdAt = isoRequired(row.created_at);
  if (corrupt) {
    // 损坏存储：整个消息不可用；元数据仍只含白名单字段，正文/标题不再输出。
    const metadata = {
      created_at: createdAt,
      message_kind: row.message_kind,
      fragment_count: 0,
      has_attachments: ids.length > 0,
      execution_state: row.execution_state,
    };
    return {
      message_id: row.id,
      conversation_id: row.conversation_id,
      owner_account_id: row.owner_account_id,
      role: row.role,
      message_kind: row.message_kind,
      execution_state: row.execution_state,
      revision: row.revision,
      created_at: createdAt,
      projection: {
        visibility: "unavailable",
        fragments: [],
        attachments: ids.map((attachmentId) => ({
          attachment_id: attachmentId,
          readable: false,
          metadata_only: false,
          reason: "source_broken" as const,
        })),
        metadata,
        execution_allowed: false,
      },
      fragments: [],
      attachment_ids: ids,
      metadata,
      recovery,
    };
  }
  const { projection, fragments } = await projectFragments(
    client,
    principal,
    schoolId,
    row.owner_account_id,
    row.conversation_id,
    row.role,
    bindingState,
    parsed.fragments,
    ids,
  );
  return {
    message_id: row.id,
    conversation_id: row.conversation_id,
    owner_account_id: row.owner_account_id,
    role: row.role,
    message_kind: row.message_kind,
    execution_state: row.execution_state,
    revision: row.revision,
    created_at: createdAt,
    projection,
    fragments,
    attachment_ids: ids,
    metadata: projection.metadata,
    recovery,
  };
}

/**
 * 会话标题投影：标题引用的来源片段任何非 full（或缺失/损坏/无法核验）都回退通用标题，
 * 不把受限正文事实经标题旁路泄漏。
 *
 * 返回的是**对外投影视图**：不含原始 `title` / `title_source_fragments`，
 * 调用方不得再把内部存储视图拼接进响应。
 */
export async function projectConversationView(
  client: TransactionClient,
  principal: Principal,
  schoolId: string,
  view: YayaConversationView,
): Promise<YayaConversationSummaryView> {
  const base = {
    conversation_id: view.conversation_id,
    owner_account_id: view.owner_account_id,
    revision: view.revision,
    created_at: view.created_at,
    updated_at: view.updated_at,
    deleted_at: view.deleted_at,
  };
  if (view.title === null) {
    return { ...base, projected_title: "未命名会话", title_restricted: false };
  }
  if (view.title_source_fragments === null) {
    // 损坏/无法核验的来源：不得当作手工标题放行
    return { ...base, projected_title: "受限会话", title_restricted: true };
  }
  if (view.title_source_fragments.length === 0) {
    return { ...base, projected_title: view.title, title_restricted: false };
  }
  const messages = await client.query<
    Pick<
      YayaMessageRow,
      "id" | "fragments" | "owner_account_id" | "conversation_id" | "role" | "binding_state" | "run_id"
    >
  >(
    `SELECT id, fragments, owner_account_id, conversation_id, role, binding_state, run_id FROM yaya_messages
      WHERE conversation_id = $1 AND deleted_at IS NULL`,
    [view.conversation_id],
  );
  const projections: YayaFragmentProjection[] = [];
  for (const fragmentId of view.title_source_fragments) {
    let matched: YayaStoredFragment | null = null;
    let matchedRole: YayaMessageRole | null = null;
    let matchedBinding: string | null = null;
    for (const message of messages.rows) {
      const parsed = parseStoredFragments(message.fragments);
      const found = parsed.fragments.find((fragment) => fragment.fragment_id === fragmentId);
      if (found) {
        matched = found;
        matchedRole = message.role;
        matchedBinding = effectiveYayaBindingState(message.binding_state, message.run_id);
        break;
      }
    }
    if (matched === null || matchedRole === null) {
      projections.push({ fragment_id: fragmentId, visibility: "hidden", reason: "evaluation_missing" });
      continue;
    }
    const projected = await projectFragments(
      client,
      principal,
      schoolId,
      view.owner_account_id,
      view.conversation_id,
      matchedRole,
      matchedBinding,
      [matched],
      [],
    );
    projections.push(
      projected.projection.fragments[0] ?? {
        fragment_id: fragmentId,
        visibility: "hidden",
        reason: "evaluation_missing",
      },
    );
  }
  const title = projectConversationTitle(
    { title: view.title, derived_from_fragment_ids: view.title_source_fragments },
    projections,
    "受限会话",
  );
  return { ...base, projected_title: title.title, title_restricted: title.restricted };
}

export async function projectConversationSummary(
  client: TransactionClient,
  principal: Principal,
  schoolId: string,
  row: YayaConversationRow,
): Promise<YayaConversationSummaryView> {
  return projectConversationView(client, principal, schoolId, toConversationView(row));
}
