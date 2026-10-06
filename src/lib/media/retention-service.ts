import { mayPurgeImage, type YayaImageLifecycleFacts } from "../yaya/types";
import { MediaError } from "./errors";
import type { MediaVariant } from "./limits";
import type { AttachmentRecord } from "./metadata-port";
import type { MediaServiceDeps } from "./runtime";

/**
 * MEDIA1 引用保护与回收租约（R1：引用核验与租约原子协调）。
 *
 * 冻结口径：
 * - 前置 `getReferenceFacts` 只用于快速判断，**不能单独授权物理删除**；
 *   真正的许可来自 `beginDeletionLease` 在共同原子边界重查完整引用集合后的 CAS：
 *   引用先成立 → 租约拒绝；租约先成立 → 新引用被拒；查询与租约之间新增引用 → 租约拒绝；
 * - 引用查询不完整（悬空引用/不可读）一律不删；
 * - 未知删除 = `deleting + delete_result="unknown"`：不可新增引用、不恢复 ready，
 *   可凭当前 revision 重试删除并 commit；
 * - 对象删除在数据库事务外，仅删除记录中的三个精确对象 key，绝不按前缀清空；
 * - 落账失败不假成功：对象可能已删但记录保持 deleting（可核验），如实报错。
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
    | "revision_conflict";
  objects: readonly RecycleObjectOutcome[];
}

async function loadLifecycleFacts(
  deps: MediaServiceDeps,
  attachmentId: string,
): Promise<YayaImageLifecycleFacts> {
  let facts;
  try {
    facts = await deps.metadata.getReferenceFacts(attachmentId);
  } catch (error) {
    if (error instanceof MediaError && error.code === "metadata_unavailable") {
      throw new MediaError("reference_query_incomplete", "暂时无法确认附件引用关系，已禁止回收。");
    }
    throw error;
  }
  if (!facts.reference_query_complete) {
    throw new MediaError("reference_query_incomplete", "附件引用关系不完整，已禁止回收。");
  }
  return {
    image_id: attachmentId,
    reference_query_complete: true,
    observation_refs: [...facts.observation_refs],
    message_refs: [...facts.message_refs],
    proposal_refs: [...facts.proposal_refs],
  };
}

function keysOf(record: AttachmentRecord): readonly { variant: MediaVariant; key: string }[] {
  return [
    { variant: "original", key: record.object_key },
    { variant: "thumbnail", key: record.thumbnail_key },
    { variant: "model", key: record.model_key },
  ];
}

async function finishDeletion(
  deps: MediaServiceDeps,
  record: AttachmentRecord,
  expectedRevision: number,
): Promise<RecycleResult> {
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
  try {
    if (unknown) {
      await deps.metadata.failDeletion({
        attachment_id: record.attachment_id,
        expected_revision: expectedRevision,
      });
    } else {
      await deps.metadata.commitDeletion({
        attachment_id: record.attachment_id,
        expected_revision: expectedRevision,
      });
    }
  } catch (error) {
    if (error instanceof MediaError && error.code === "revision_conflict") {
      // 租约身份已被其他落账更新：不重复落账，如实报告冲突。
      return { status: "revision_conflict", objects };
    }
    // 状态落账失败：尝试标记未知删除，避免留下无身份的 deleting；仍失败则保持可核验状态。
    try {
      await deps.metadata.failDeletion({
        attachment_id: record.attachment_id,
        expected_revision: expectedRevision,
      });
    } catch {
      // 保持 deleting（可核验）；下面如实报错，不宣称成功。
    }
    throw new MediaError(
      "metadata_unavailable",
      "对象删除已执行，但删除状态未能落账，请稍后按附件状态核对。",
      { attachment_id: record.attachment_id },
    );
  }
  return { status: unknown ? "deletion_unknown" : "deleted", objects };
}

export async function recycleAttachment(
  deps: MediaServiceDeps,
  input: { attachment_id: string },
): Promise<RecycleResult> {
  const record = await deps.metadata.get(input.attachment_id);
  if (record === null) return { status: "not_found", objects: [] };
  if (record.status === "deleted") return { status: "already_deleted", objects: [] };
  if (record.status === "deleting") {
    if (record.delete_result !== "unknown") {
      // 首次租约进行中（或状态未知）：没有可靠租约身份，不删对象。
      return { status: "lease_busy", objects: [] };
    }
    // 未知删除的可核验重试：deleting+unknown 仍禁止新引用，按当前 revision 重试落账。
    return finishDeletion(deps, record, record.revision);
  }

  // 快速判断：前置无引用快照不能单独授权删除；真正许可是下面的原子租约。
  const facts = await loadLifecycleFacts(deps, input.attachment_id);
  if (!mayPurgeImage(facts)) {
    return { status: "referenced", objects: [] };
  }

  const lease = await deps.metadata.beginDeletionLease({
    attachment_id: input.attachment_id,
    expected_revision: record.revision,
  });
  switch (lease.outcome) {
    case "referenced":
      return { status: "referenced", objects: [] };
    case "revision_conflict":
      return { status: "revision_conflict", objects: [] };
    case "not_ready":
      return lease.status === "deleted"
        ? { status: "already_deleted", objects: [] }
        : { status: "lease_busy", objects: [] };
    case "not_found":
      return { status: "not_found", objects: [] };
    case "acquired":
      return finishDeletion(deps, lease.record, lease.record.revision);
  }
}
