import type { ObservationStatus } from "../types";
import { MediaError } from "./errors";
import {
  type AttachmentAuditEntry,
  type AttachmentMetadataPort,
  type AttachmentRecord,
  type AttachmentReference,
  type AttachmentReferenceFacts,
  type DeletionLeaseResult,
  type ObservationReferencesResult,
} from "./metadata-port";
import { newLeaseToken } from "./object-store";

/**
 * 附件元数据的进程内替身（仅用于可运行验收/开发替身，不是生产 repository）。
 *
 * 与真实 DATA1 repository 保持同一冻结语义：状态机、CAS 租约、引用完整性、
 * 业务事务内递增 revision、失败点注入（验证上传/处理/元数据失败补偿路径）。
 * 生产接入点见 MediaRuntime：DATA1 交付后由整合者替换，本类不得作为正式闭环。
 */

type Failpoint =
  | "insertPending"
  | "markReady"
  | "removePending"
  | "addObservationReferences"
  | "getReferenceFacts"
  | "beginDeletionLease"
  | "completeDeletion";

function refKey(ref: AttachmentReference): string {
  return `${ref.ref_kind}\u0000${ref.ref_id}\u0000${ref.attachment_id}`;
}

export class MemoryAttachmentMetadata implements AttachmentMetadataPort {
  private readonly attachments = new Map<string, AttachmentRecord>();
  private readonly clientIndex = new Map<string, string>();
  private readonly references = new Map<string, AttachmentReference>();
  private readonly observationRevisions = new Map<string, number>();
  private readonly observationStatuses = new Map<string, ObservationStatus>();
  private readonly conversationOwners = new Map<string, string>();
  private readonly auditEntries: AttachmentAuditEntry[] = [];
  private readonly failpoints = new Set<Failpoint>();

  /** 测试辅助：让下一个指定操作抛“元数据不可用”，验证补偿/保守路径 */
  failNext(operation: Failpoint): void {
    this.failpoints.add(operation);
  }

  /** 测试辅助：登记会话归属，验证“只解除自己的引用” */
  seedConversation(conversation_id: string, owner_account_id: string): void {
    this.conversationOwners.set(conversation_id, owner_account_id);
  }

  /** 测试辅助：登记观察当前状态（引用事实投影用；未登记的按 draft 保守处理） */
  seedObservation(observation_id: string, status: ObservationStatus): void {
    this.observationStatuses.set(observation_id, status);
  }

  /** 测试辅助：直接登记引用（消息/提案引用由 DATA1 的会话/提案流程写入） */
  seedReference(ref: AttachmentReference): void {
    this.references.set(refKey(ref), { ...ref });
  }

  audits(): readonly AttachmentAuditEntry[] {
    return this.auditEntries.map((entry) => ({ ...entry, attachment_ids: [...entry.attachment_ids] }));
  }

  countAttachments(): number {
    return this.attachments.size;
  }

  countReferences(): number {
    return this.references.size;
  }

  private consumeFailpoint(operation: Failpoint): void {
    if (this.failpoints.delete(operation)) {
      throw new MediaError("metadata_unavailable", "附件元数据服务暂时不可用，请稍后重试。");
    }
  }

  private clientKey(owner: string, clientUploadId: string): string {
    return `${owner}\u0000${clientUploadId}`;
  }

  async findByClientUploadId(
    owner_account_id: string,
    client_upload_id: string,
  ): Promise<AttachmentRecord | null> {
    const id = this.clientIndex.get(this.clientKey(owner_account_id, client_upload_id));
    if (id === undefined) return null;
    const record = this.attachments.get(id);
    return record ? { ...record } : null;
  }

  async insertPending(record: AttachmentRecord): Promise<void> {
    this.consumeFailpoint("insertPending");
    if (record.status !== "pending") {
      throw new MediaError("invalid_request", "新增附件记录必须是 pending 状态。");
    }
    if (this.attachments.has(record.attachment_id)) {
      throw new MediaError("object_conflict", "附件标识已存在，拒绝覆盖。");
    }
    if (record.client_upload_id !== null) {
      const key = this.clientKey(record.owner_account_id, record.client_upload_id);
      if (this.clientIndex.has(key)) {
        throw new MediaError("object_conflict", "重复的客户端上传标识，拒绝覆盖。");
      }
      this.clientIndex.set(key, record.attachment_id);
    }
    this.attachments.set(record.attachment_id, { ...record });
  }

  async markReady(attachment_id: string): Promise<AttachmentRecord> {
    this.consumeFailpoint("markReady");
    const record = this.attachments.get(attachment_id);
    if (!record) throw new MediaError("attachment_not_found", "附件不存在。");
    if (record.status !== "pending") {
      throw new MediaError("metadata_conflict", "附件状态不允许标记为可用。");
    }
    record.status = "ready";
    return { ...record };
  }

  async removePending(attachment_id: string): Promise<boolean> {
    this.consumeFailpoint("removePending");
    const record = this.attachments.get(attachment_id);
    if (!record || record.status !== "pending") return false;
    this.attachments.delete(attachment_id);
    if (record.client_upload_id !== null) {
      this.clientIndex.delete(this.clientKey(record.owner_account_id, record.client_upload_id));
    }
    return true;
  }

  async get(attachment_id: string): Promise<AttachmentRecord | null> {
    const record = this.attachments.get(attachment_id);
    return record ? { ...record } : null;
  }

  async addObservationReferences(input: {
    observation_id: string;
    attachment_ids: readonly string[];
    actor_account_id: string;
  }): Promise<ObservationReferencesResult> {
    this.consumeFailpoint("addObservationReferences");
    let added = 0;
    for (const attachmentId of input.attachment_ids) {
      const record = this.attachments.get(attachmentId);
      if (!record) throw new MediaError("attachment_not_found", `附件不存在：${attachmentId}`);
      if (record.status === "deleting") {
        throw new MediaError("attachment_deleting", "附件正在回收，不能新增引用。");
      }
      if (record.status !== "ready") {
        throw new MediaError("attachment_gone", "附件不可用，不能新增引用。");
      }
      const key = refKey({
        attachment_id: attachmentId,
        ref_kind: "observation",
        ref_id: input.observation_id,
        conversation_id: null,
      });
      if (this.references.has(key)) continue;
      this.references.set(key, {
        attachment_id: attachmentId,
        ref_kind: "observation",
        ref_id: input.observation_id,
        conversation_id: null,
      });
      added += 1;
    }
    const revision = (this.observationRevisions.get(input.observation_id) ?? 0) + added;
    this.observationRevisions.set(input.observation_id, revision);
    return { added, attachment_revision: revision };
  }

  async getObservationAttachmentRevision(observation_id: string): Promise<number> {
    return this.observationRevisions.get(observation_id) ?? 0;
  }

  async getReferenceFacts(attachment_id: string): Promise<AttachmentReferenceFacts> {
    // 查询不可用必须抛错：调用方按“引用查询不完整”保守处理，不能当空集。
    this.consumeFailpoint("getReferenceFacts");
    const observation_refs: { observation_id: string; status: ObservationStatus }[] = [];
    const message_refs: { conversation_id: string; message_id: string }[] = [];
    const proposal_refs: string[] = [];
    for (const ref of this.references.values()) {
      if (ref.attachment_id !== attachment_id) continue;
      if (ref.ref_kind === "observation") {
        observation_refs.push({
          observation_id: ref.ref_id,
          status: this.observationStatuses.get(ref.ref_id) ?? "draft",
        });
      } else if (ref.ref_kind === "message" && ref.conversation_id !== null) {
        message_refs.push({ conversation_id: ref.conversation_id, message_id: ref.ref_id });
      } else if (ref.ref_kind === "proposal") {
        proposal_refs.push(ref.ref_id);
      }
    }
    return { attachment_id, observation_refs, message_refs, proposal_refs };
  }

  async releaseConversationReferences(input: {
    conversation_id: string;
    message_ids: readonly string[];
    owner_account_id: string;
  }): Promise<number> {
    const owner = this.conversationOwners.get(input.conversation_id);
    if (owner === undefined || owner !== input.owner_account_id) {
      // 删除聊天只能解除自己的引用；不是自己的会话一律拒绝。
      throw new MediaError("not_owner", "只能删除自己会话中的附件引用。");
    }
    const messageIds = new Set(input.message_ids);
    let released = 0;
    for (const [key, ref] of [...this.references.entries()]) {
      if (ref.ref_kind !== "message") continue;
      if (ref.conversation_id !== input.conversation_id) continue;
      if (!messageIds.has(ref.ref_id)) continue;
      this.references.delete(key);
      released += 1;
    }
    return released;
  }

  async beginDeletionLease(attachment_id: string): Promise<DeletionLeaseResult> {
    this.consumeFailpoint("beginDeletionLease");
    const record = this.attachments.get(attachment_id);
    if (!record) return { outcome: "not_found" };
    if (record.status === "deleting") return { outcome: "already_deleting" };
    if (record.status === "deleted") return { outcome: "already_deleted" };
    if (record.status !== "ready" && record.status !== "deletion_unknown") {
      return { outcome: "not_ready" };
    }
    const leaseToken = newLeaseToken();
    record.status = "deleting";
    record.deletion_lease_id = leaseToken;
    return { outcome: "acquired", lease_token: leaseToken };
  }

  async completeDeletion(
    attachment_id: string,
    lease_token: string,
    outcome: "deleted" | "unknown" | "failed",
  ): Promise<AttachmentRecord> {
    this.consumeFailpoint("completeDeletion");
    const record = this.attachments.get(attachment_id);
    if (!record) throw new MediaError("attachment_not_found", "附件不存在。");
    if (record.status !== "deleting" || record.deletion_lease_id !== lease_token) {
      throw new MediaError("metadata_conflict", "回收租约不匹配，拒绝落状态。");
    }
    record.deletion_lease_id = null;
    if (outcome === "deleted") record.status = "deleted";
    else if (outcome === "unknown") record.status = "deletion_unknown";
    else record.status = "ready";
    return { ...record };
  }

  async appendAttachmentAudit(entry: AttachmentAuditEntry): Promise<void> {
    this.auditEntries.push({ ...entry, attachment_ids: [...entry.attachment_ids] });
  }
}
