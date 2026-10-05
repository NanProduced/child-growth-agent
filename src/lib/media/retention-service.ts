import { mayPurgeImage, type YayaImageLifecycleFacts } from "../yaya/types";
import { MediaError } from "./errors";
import type { MediaVariant } from "./limits";
import type { AttachmentRecord } from "./metadata-port";
import type { MediaServiceDeps } from "./runtime";

/**
 * MEDIA1 引用保护与回收租约。
 *
 * 冻结口径：
 * - 删除聊天只解除**自己会话**的引用；草稿/待补充/已整理/已确认观察、提案与其他
 *   消息引用都保护图片；引用查询不完整一律不删；
 * - 回收先 CAS 拿到 deleting 租约（阻止新引用），再在**数据库事务外**删除精确对象
 *   key（不长持事务）；外部删除结果未知时保留 deletion_unknown 可核验状态，
 *   不伪装成功、不恢复 ready；
 * - 只删除记录中的三个精确对象 key，绝不按前缀全量清空。
 */

export interface RecycleObjectOutcome {
  variant: MediaVariant;
  outcome: "deleted" | "not_found" | "unknown";
}

export interface RecycleResult {
  status:
    | "deleted"
    | "deletion_unknown"
    | "referenced"
    | "already_deleted"
    | "not_found"
    | "lease_busy"
    | "not_ready";
  objects: readonly RecycleObjectOutcome[];
}

async function loadLifecycleFacts(
  deps: MediaServiceDeps,
  attachmentId: string,
): Promise<YayaImageLifecycleFacts> {
  try {
    const facts = await deps.metadata.getReferenceFacts(attachmentId);
    return {
      image_id: attachmentId,
      reference_query_complete: true,
      observation_refs: [...facts.observation_refs],
      message_refs: [...facts.message_refs],
      proposal_refs: [...facts.proposal_refs],
    };
  } catch (error) {
    if (error instanceof MediaError && error.code === "metadata_unavailable") {
      // 查询不完整禁止回收；保留为未知引用，等待可核验后重试。
      throw new MediaError("reference_query_incomplete", "暂时无法确认附件引用关系，已禁止回收。");
    }
    throw error;
  }
}

function keysOf(record: AttachmentRecord): readonly { variant: MediaVariant; key: string }[] {
  return [
    { variant: "original", key: record.object_key },
    { variant: "thumbnail", key: record.thumbnail_key },
    { variant: "model", key: record.model_key },
  ];
}

export async function recycleAttachment(
  deps: MediaServiceDeps,
  input: { attachment_id: string },
): Promise<RecycleResult> {
  const record = await deps.metadata.get(input.attachment_id);
  if (record === null) return { status: "not_found", objects: [] };
  if (record.status === "deleted") return { status: "already_deleted", objects: [] };

  const facts = await loadLifecycleFacts(deps, input.attachment_id);
  if (!mayPurgeImage(facts)) {
    return { status: "referenced", objects: [] };
  }

  const lease = await deps.metadata.beginDeletionLease(input.attachment_id);
  if (lease.outcome === "already_deleted") return { status: "already_deleted", objects: [] };
  if (lease.outcome === "already_deleting") return { status: "lease_busy", objects: [] };
  if (lease.outcome === "not_ready") return { status: "not_ready", objects: [] };
  if (lease.outcome === "not_found") return { status: "not_found", objects: [] };

  const objects: RecycleObjectOutcome[] = [];
  for (const { variant, key } of keysOf(record)) {
    let outcome: RecycleObjectOutcome["outcome"];
    try {
      outcome = await deps.store.delete(key);
    } catch {
      outcome = "unknown";
    }
    objects.push({ variant, outcome });
  }
  const unknown = objects.some((entry) => entry.outcome === "unknown");
  await deps.metadata.completeDeletion(
    input.attachment_id,
    lease.lease_token,
    unknown ? "unknown" : "deleted",
  );
  return { status: unknown ? "deletion_unknown" : "deleted", objects };
}

/** 删除会话时只解除该 owner 自己消息的引用；其他引用保持保护 */
export async function releaseConversationReferences(
  deps: MediaServiceDeps,
  input: {
    conversation_id: string;
    message_ids: readonly string[];
    owner_account_id: string;
  },
): Promise<{ released: number }> {
  const released = await deps.metadata.releaseConversationReferences(input);
  return { released };
}
