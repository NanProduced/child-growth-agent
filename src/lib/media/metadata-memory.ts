import { randomUUID } from "node:crypto";

import type { ObservationStatus } from "../types";
import { MediaError } from "./errors";
import {
  type AppendObservationAttachmentsInput,
  type AppendObservationAttachmentsResult,
  type AttachmentAuditEntry,
  type AttachmentMetadataPort,
  type AttachmentRecord,
  type AttachmentReferenceFacts,
  type AttachmentStatus,
  type DeletionLeaseResult,
  type ObservationReferencesResult,
  type RegisterAttachmentInput,
} from "./metadata-port";

/**
 * 附件元数据的进程内替身（仅用于可运行验收/开发替身，不是生产 repository）。
 *
 * 与 DATA1 已发布 repository 保持同一冻结语义：
 * - ready/deleting/deleted + revision CAS + delete_result（未知删除 = deleting+unknown）；
 * - beginDeletionLease 在**同一原子边界**重查完整引用集合再 CAS（引用新增与租约互斥）；
 * - appendObservationAttachments 先整体校验再整体写入（不产生半成功），
 *   引用、观察修订与审计同一原子边界；
 * - registerAttachment 单次原子登记，字段缺失/空白一律拒绝（不默认 ready、不伪造 checksum）；
 * - 失败点注入覆盖“提交前失败 / 提交后响应丢失 / 迟到提交 / 读回失败”等路径。
 * 生产接入点见 MediaRuntime：DATA1 repository 由整合者替换本类。
 */

export type MemoryMetadataFailpoint =
  | "get"
  | "register_before"
  | "register_after_commit"
  | "register_late_commit"
  | "getReferenceFacts"
  | "beginDeletionLease"
  | "commitDeletion"
  | "failDeletion"
  | "linkObservationReferences"
  | "appendObservationAttachments";

interface StoredReference {
  attachment_id: string;
  ref_kind: "observation" | "proposal" | "message";
  ref_id: string;
  conversation_id: string | null;
}

function refKey(ref: StoredReference): string {
  return `${ref.ref_kind}\u0000${ref.ref_id}\u0000${ref.attachment_id}`;
}

function sameInstant(a: string, b: string): boolean {
  const first = Date.parse(a);
  const second = Date.parse(b);
  return Number.isFinite(first) && Number.isFinite(second) && first === second;
}

function assertRegisterInput(input: RegisterAttachmentInput): void {
  const blank = (value: string) => typeof value !== "string" || value.trim() === "";
  if (
    blank(input.attachment_id) ||
    blank(input.owner_account_id) ||
    blank(input.object_key) ||
    blank(input.thumbnail_key) ||
    blank(input.model_key) ||
    blank(input.checksum_sha256) ||
    blank(input.thumbnail_checksum) ||
    blank(input.model_checksum) ||
    blank(input.source_checksum) ||
    !Number.isFinite(input.byte_size) ||
    input.byte_size < 0 ||
    !Number.isInteger(input.width) ||
    !Number.isInteger(input.height) ||
    input.width <= 0 ||
    input.height <= 0
  ) {
    throw new MediaError("invalid_request", "附件登记信息不完整，拒绝登记。");
  }
}

export class MemoryAttachmentMetadata implements AttachmentMetadataPort {
  private readonly records = new Map<string, AttachmentRecord>();
  private readonly objectKeys = new Set<string>();
  private readonly references = new Map<string, StoredReference>();
  private readonly observationRevisions = new Map<string, number>();
  private readonly observationStatuses = new Map<string, ObservationStatus>();
  private readonly observationConfirmedAt = new Map<string, string | null>();
  private readonly conversationOwners = new Map<string, string>();
  private readonly auditEntries: AttachmentAuditEntry[] = [];
  private readonly failpoints = new Set<MemoryMetadataFailpoint>();
  private lateCommit: Promise<void> | null = null;

  /** 测试辅助：让下一个指定操作按语义失败 */
  failNext(operation: MemoryMetadataFailpoint): void {
    this.failpoints.add(operation);
  }

  /** 测试辅助：清空未消费的失败点，避免跨场景污染 */
  clearFailpoints(): void {
    this.failpoints.clear();
  }

  /** 测试辅助：在引用事实返回后触发（模拟“查询与租约之间”的并发写入） */
  onNextReferenceFacts: (() => void) | null = null;

  /** 测试辅助：等待迟到提交落库（register_late_commit） */
  async settleLateCommit(): Promise<void> {
    if (this.lateCommit) await this.lateCommit;
  }

  seedObservation(observation_id: string, status: ObservationStatus, confirmed_at: string | null = null): void {
    this.observationStatuses.set(observation_id, status);
    this.observationConfirmedAt.set(observation_id, confirmed_at);
  }

  seedConversation(conversation_id: string, owner_account_id: string): void {
    this.conversationOwners.set(conversation_id, owner_account_id);
  }

  /** 测试辅助：直接登记引用（消息/提案引用由 DATA1 会话/提案流程写入） */
  seedReference(ref: StoredReference): void {
    this.references.set(refKey(ref), { ...ref });
  }

  /** 测试辅助：模拟 DATA deleteConversation 的“解除本会话消息引用”步骤（owner 校验） */
  detachConversationReferences(conversation_id: string, owner_account_id: string): number {
    const owner = this.conversationOwners.get(conversation_id);
    if (owner === undefined || owner !== owner_account_id) {
      throw new MediaError("not_owner", "只能解除自己会话中的附件引用。");
    }
    let detached = 0;
    for (const [key, ref] of [...this.references.entries()]) {
      if (ref.ref_kind === "message" && ref.conversation_id === conversation_id) {
        this.references.delete(key);
        detached += 1;
      }
    }
    return detached;
  }

  audits(): readonly AttachmentAuditEntry[] {
    return this.auditEntries.map((entry) => ({ ...entry }));
  }

  countAttachments(): number {
    return this.records.size;
  }

  countReferences(): number {
    return this.references.size;
  }

  private consumeFailpoint(operation: MemoryMetadataFailpoint): void {
    if (this.failpoints.delete(operation)) {
      throw new MediaError("metadata_unavailable", "附件元数据服务暂时不可用，请稍后重试。");
    }
  }

  private requireReady(attachment_id: string, actor_account_id: string): AttachmentRecord {
    const record = this.records.get(attachment_id);
    if (!record) throw new MediaError("attachment_not_found", `附件不存在：${attachment_id}`);
    if (record.owner_account_id !== actor_account_id) {
      throw new MediaError("not_owner", "只能关联自己上传的图片。");
    }
    if (record.status === "deleting") {
      throw new MediaError("attachment_deleting", "附件正在回收，不能新增引用。");
    }
    if (record.status !== "ready") {
      throw new MediaError("attachment_gone", "附件不可用，不能新增引用。");
    }
    return record;
  }

  async get(attachment_id: string): Promise<AttachmentRecord | null> {
    this.consumeFailpoint("get");
    const record = this.records.get(attachment_id);
    return record ? { ...record } : null;
  }

  async registerAttachment(input: RegisterAttachmentInput): Promise<AttachmentRecord> {
    assertRegisterInput(input);
    this.consumeFailpoint("register_before");
    const commit = (): AttachmentRecord => {
      if (this.records.has(input.attachment_id)) {
        throw new MediaError("idempotency_conflict", "附件标识已登记，拒绝覆盖。");
      }
      if (this.objectKeys.has(input.object_key)) {
        throw new MediaError("attachment_conflict", "对象键已登记，拒绝重复。");
      }
      const now = new Date().toISOString();
      const record: AttachmentRecord = {
        ...input,
        status: "ready",
        revision: 0,
        delete_result: null,
        created_at: now,
        updated_at: now,
        deletion_started_at: null,
        deleted_at: null,
      };
      this.records.set(record.attachment_id, record);
      this.objectKeys.add(record.object_key);
      return { ...record };
    };
    if (this.failpoints.delete("register_after_commit")) {
      commit();
      throw new MediaError("metadata_unavailable", "登记已提交，但响应丢失。");
    }
    if (this.failpoints.delete("register_late_commit")) {
      this.lateCommit = new Promise<void>((resolve) => {
        setTimeout(() => {
          try {
            commit();
          } catch {
            // 迟到提交与已有记录冲突时按幂等冲突处理，不影响迟到窗口语义
          }
          resolve();
        }, 0);
      });
      throw new MediaError("metadata_unavailable", "登记结果未知。");
    }
    return commit();
  }

  async getReferenceFacts(attachment_id: string): Promise<AttachmentReferenceFacts> {
    this.consumeFailpoint("getReferenceFacts");
    let complete = true;
    const observation_refs: { observation_id: string; status: ObservationStatus }[] = [];
    const message_refs: { conversation_id: string; message_id: string }[] = [];
    const proposal_refs: string[] = [];
    for (const ref of this.references.values()) {
      if (ref.attachment_id !== attachment_id) continue;
      if (ref.ref_kind === "observation") {
        const status = this.observationStatuses.get(ref.ref_id);
        if (status === undefined) {
          // 悬空引用：与 DATA LEFT JOIN 缺失一致，查询不完整
          complete = false;
          continue;
        }
        observation_refs.push({ observation_id: ref.ref_id, status });
      } else if (ref.ref_kind === "message" && ref.conversation_id !== null) {
        message_refs.push({ conversation_id: ref.conversation_id, message_id: ref.ref_id });
      } else if (ref.ref_kind === "proposal") {
        proposal_refs.push(ref.ref_id);
      } else {
        complete = false;
      }
    }
    const facts: AttachmentReferenceFacts = {
      attachment_id,
      reference_query_complete: complete,
      observation_refs,
      message_refs,
      proposal_refs,
    };
    const hook = this.onNextReferenceFacts;
    this.onNextReferenceFacts = null;
    hook?.();
    return facts;
  }

  async beginDeletionLease(input: {
    attachment_id: string;
    expected_revision: number;
    actor_account_id?: string;
  }): Promise<DeletionLeaseResult> {
    this.consumeFailpoint("beginDeletionLease");
    const record = this.records.get(input.attachment_id);
    if (!record) return { outcome: "not_found" };
    if (
      input.actor_account_id !== undefined &&
      record.owner_account_id !== input.actor_account_id
    ) {
      throw new MediaError("not_owner", "只能回收自己上传的图片。");
    }
    // 共同原子边界：引用集合重查与租约 CAS 之间不得插入引用写入。
    // 悬空观察引用（宿主不存在）按查询不完整保守拒绝，不折叠为“有引用”。
    let referenced = false;
    let incomplete = false;
    for (const ref of this.references.values()) {
      if (ref.attachment_id !== input.attachment_id) continue;
      if (ref.ref_kind === "observation" && !this.observationStatuses.has(ref.ref_id)) {
        incomplete = true;
        continue;
      }
      referenced = true;
    }
    if (incomplete) return { outcome: "reference_incomplete" };
    if (referenced) return { outcome: "referenced" };
    if (record.status !== "ready") return { outcome: "not_ready", status: record.status };
    if (record.revision !== input.expected_revision) return { outcome: "revision_conflict" };
    record.status = "deleting";
    record.revision += 1;
    record.deletion_started_at = new Date().toISOString();
    record.updated_at = record.deletion_started_at;
    record.delete_result = null;
    return { outcome: "acquired", record: { ...record } };
  }

  async commitDeletion(input: {
    attachment_id: string;
    expected_revision: number;
  }): Promise<AttachmentRecord> {
    this.consumeFailpoint("commitDeletion");
    const record = this.records.get(input.attachment_id);
    if (!record) throw new MediaError("attachment_not_found", "附件不存在。");
    if (record.status !== "deleting") {
      throw new MediaError("attachment_conflict", "附件不在删除租约中。");
    }
    if (record.revision !== input.expected_revision) {
      throw new MediaError("revision_conflict", "删除租约修订不匹配，拒绝落账。");
    }
    record.status = "deleted";
    record.delete_result = "deleted";
    record.revision += 1;
    record.deleted_at = new Date().toISOString();
    record.updated_at = record.deleted_at;
    return { ...record };
  }

  async failDeletion(input: {
    attachment_id: string;
    expected_revision: number;
  }): Promise<AttachmentRecord> {
    this.consumeFailpoint("failDeletion");
    const record = this.records.get(input.attachment_id);
    if (!record) throw new MediaError("attachment_not_found", "附件不存在。");
    if (record.status !== "deleting") {
      throw new MediaError("attachment_conflict", "附件不在删除租约中。");
    }
    if (record.revision !== input.expected_revision) {
      throw new MediaError("revision_conflict", "删除租约修订不匹配，拒绝落账。");
    }
    // 未知删除：保持 deleting + unknown；绝不恢复 ready、绝不伪装 deleted。
    record.delete_result = "unknown";
    record.revision += 1;
    record.updated_at = new Date().toISOString();
    return { ...record };
  }

  async linkObservationReferences(input: {
    observation_id: string;
    attachment_ids: readonly string[];
    actor_account_id: string;
  }): Promise<ObservationReferencesResult> {
    this.consumeFailpoint("linkObservationReferences");
    if (input.attachment_ids.length === 0 || new Set(input.attachment_ids).size !== input.attachment_ids.length) {
      throw new MediaError("invalid_request", "关联附件集合不合法。");
    }
    // 先整体校验，再整体写入：后一附件失败不得留下半成功。
    for (const attachmentId of input.attachment_ids) {
      this.requireReady(attachmentId, input.actor_account_id);
    }
    let linked = 0;
    for (const attachmentId of input.attachment_ids) {
      const ref: StoredReference = {
        attachment_id: attachmentId,
        ref_kind: "observation",
        ref_id: input.observation_id,
        conversation_id: null,
      };
      if (!this.references.has(refKey(ref))) {
        this.references.set(refKey(ref), ref);
        linked += 1;
      }
    }
    return { linked };
  }

  async appendObservationAttachments(
    input: AppendObservationAttachmentsInput,
  ): Promise<AppendObservationAttachmentsResult> {
    this.consumeFailpoint("appendObservationAttachments");
    if (input.attachment_ids.length === 0 || new Set(input.attachment_ids).size !== input.attachment_ids.length) {
      throw new MediaError("invalid_request", "追加附件集合不合法。");
    }
    if (!Number.isInteger(input.expected_attachment_revision) || input.expected_attachment_revision < 0) {
      throw new MediaError("invalid_request", "附件修订前提不合法。");
    }
    // 共同原子边界：整体校验 → 宿主前提核验 → CAS → 引用+审计+修订一次性写入（无 await 插入）。
    for (const attachmentId of input.attachment_ids) {
      this.requireReady(attachmentId, input.actor_account_id);
    }
    // 宿主前提：必须在本边界内成立；来源写进审计不等于前提成立。
    const hostStatus = this.observationStatuses.get(input.observation_id);
    if (hostStatus === undefined || hostStatus !== "confirmed") {
      throw new MediaError("observation_not_confirmed", "宿主观察当前不是已确认状态，拒绝追加资料。");
    }
    const hostConfirmedAt = this.observationConfirmedAt.get(input.observation_id) ?? null;
    if (
      hostConfirmedAt === null ||
      input.source_confirmed_at === null ||
      !sameInstant(hostConfirmedAt, input.source_confirmed_at)
    ) {
      throw new MediaError("source_conflict", "宿主确认来源前提已变化，拒绝追加资料。");
    }
    const current = this.observationRevisions.get(input.observation_id) ?? 0;
    if (current !== input.expected_attachment_revision) {
      throw new MediaError("revision_conflict", "观察附件修订已变化，请刷新后重试。");
    }
    for (const attachmentId of input.attachment_ids) {
      const ref: StoredReference = {
        attachment_id: attachmentId,
        ref_kind: "observation",
        ref_id: input.observation_id,
        conversation_id: null,
      };
      if (this.references.has(refKey(ref))) {
        throw new MediaError("attachment_referenced", "附件已关联到该观察。");
      }
    }
    const nextRevision = current + 1;
    const recordedAt = new Date().toISOString();
    for (const attachmentId of input.attachment_ids) {
      this.references.set(
        refKey({
          attachment_id: attachmentId,
          ref_kind: "observation",
          ref_id: input.observation_id,
          conversation_id: null,
        }),
        {
          attachment_id: attachmentId,
          ref_kind: "observation",
          ref_id: input.observation_id,
          conversation_id: null,
        },
      );
      this.auditEntries.push({
        audit_id: randomUUID(),
        action: "attach_observation_images",
        observation_id: input.observation_id,
        attachment_id: attachmentId,
        attachment_revision: nextRevision,
        actor_account_id: input.actor_account_id,
        source_confirmed_at: input.source_confirmed_at,
        request_id: input.request_id,
        approval_id: input.approval_id,
        recorded_at: recordedAt,
      });
    }
    this.observationRevisions.set(input.observation_id, nextRevision);
    return { attachment_revision: nextRevision, appended: [...input.attachment_ids] };
  }

  async getObservationAttachmentRevision(observation_id: string): Promise<number> {
    return this.observationRevisions.get(observation_id) ?? 0;
  }

  /** 测试辅助：读取记录当前状态名（不修改状态） */
  statusOf(attachment_id: string): AttachmentStatus | null {
    return this.records.get(attachment_id)?.status ?? null;
  }

  /** 测试辅助：模拟记录在服务读取后、租约前被其他写者更新（revision 变化） */
  bumpAttachmentRevision(attachment_id: string): boolean {
    const record = this.records.get(attachment_id);
    if (!record) return false;
    record.revision += 1;
    return true;
  }
}
