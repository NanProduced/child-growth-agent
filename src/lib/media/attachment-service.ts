import { randomUUID } from "node:crypto";

import { authorizeAction } from "../accounts/authorize";
import { AccountsError } from "../accounts/errors";
import type { Principal } from "../accounts/types";
import type { ObservationStatus } from "../types";
import { MediaError } from "./errors";
import { MEDIA_MAX_IMAGES_PER_UPLOAD } from "./limits";
import type { AttachmentRecord } from "./metadata-port";
import type { MediaServiceDeps } from "./runtime";

/**
 * MEDIA1 附件与业务记录的关联。
 *
 * 冻结口径：
 * - 创建观察的附图必须由业务保存在**同一事务**内调用 associateObservationImagesOnCreate
 *   （元数据端口由调用方绑定到该事务；本服务不另开连接、不独立提交）；
 * - 归档后追加资料走 appendObservationImages：核宿主幼儿 observation.write/child、
 *   观察已确认、source_confirmed_at、附件 revision 与图片所有权；单独审计；
 * - 两者都不改 raw_text/confirmed_content，也不点亮指南证据（本模块无这些参数）；
 * - 管理员只读：authorizeAction 对 observation.write 一律 forbidden_role。
 */

export interface HostObservationFacts {
  observation_id: string;
  child_id: string;
  status: ObservationStatus;
  confirmed_at: string | null;
  current_class_id: string | null;
  observed_class_id: string | null;
}

/** 宿主幼儿观察写权限：动作/资源组合与角色/范围全部复用冻结 AUTH 判定 */
export function assertHostChildWrite(principal: Principal, host: HostObservationFacts): void {
  const decision = authorizeAction(principal, "observation.write", {
    kind: "child",
    child_id: host.child_id,
    current_class_id: host.current_class_id,
  });
  if (!decision.allowed) {
    if ("invalid_request" in decision) {
      throw new AccountsError("invalid_request", "动作与资源组合不合法。");
    }
    throw new AccountsError(decision.deny, "当前账号没有该幼儿的观察写权限。");
  }
}

function sameInstant(a: string, b: string): boolean {
  const first = Date.parse(a);
  const second = Date.parse(b);
  return Number.isFinite(first) && Number.isFinite(second) && first === second;
}

function assertImageIds(imageIds: readonly string[]): void {
  if (imageIds.length === 0) {
    throw new MediaError("invalid_request", "请至少选择一张图片。");
  }
  if (imageIds.length > MEDIA_MAX_IMAGES_PER_UPLOAD) {
    throw new MediaError(
      "too_many_images",
      `每次最多关联 ${MEDIA_MAX_IMAGES_PER_UPLOAD} 张图片。`,
    );
  }
  if (new Set(imageIds).size !== imageIds.length) {
    throw new MediaError("invalid_request", "同一张图片不能重复关联。");
  }
}

async function assertReadyAndOwned(
  deps: MediaServiceDeps,
  actorAccountId: string,
  imageIds: readonly string[],
): Promise<void> {
  for (const imageId of imageIds) {
    const record: AttachmentRecord | null = await deps.metadata.get(imageId);
    if (record === null) throw new MediaError("attachment_not_found", `附件不存在：${imageId}`);
    if (record.owner_account_id !== actorAccountId) {
      throw new MediaError("not_owner", "只能关联自己上传的图片。");
    }
    if (record.status === "deleting") {
      throw new MediaError("attachment_deleting", "附件正在回收，不能新增引用。");
    }
    if (record.status !== "ready") {
      throw new MediaError("attachment_gone", "附件不可用，不能新增引用。");
    }
  }
}

export interface CreateObservationAttachmentInput {
  host: HostObservationFacts;
  principal: Principal;
  image_ids: readonly string[];
  request_id: string | null;
}

/**
 * 创建观察时的附图关联（必须在业务保存事务内调用，端口绑定到同一 client）。
 */
export async function associateObservationImagesOnCreate(
  deps: MediaServiceDeps,
  input: CreateObservationAttachmentInput,
): Promise<{ attachment_revision: number; attached: readonly string[] }> {
  assertImageIds(input.image_ids);
  assertHostChildWrite(input.principal, input.host);
  await assertReadyAndOwned(deps, input.principal.account_id, input.image_ids);
  const result = await deps.metadata.addObservationReferences({
    observation_id: input.host.observation_id,
    attachment_ids: input.image_ids,
    actor_account_id: input.principal.account_id,
  });
  await deps.metadata.appendAttachmentAudit({
    audit_id: randomUUID(),
    action: "create_observation_attachments",
    observation_id: input.host.observation_id,
    attachment_ids: [...input.image_ids],
    actor_account_id: input.principal.account_id,
    source_confirmed_at: null,
    request_id: input.request_id,
    recorded_at: new Date().toISOString(),
  });
  return { attachment_revision: result.attachment_revision, attached: [...input.image_ids] };
}

export interface AppendObservationImagesInput {
  host: HostObservationFacts;
  principal: Principal;
  image_ids: readonly string[];
  expected_attachment_revision: number;
  source_confirmed_at: string | null;
  request_id: string | null;
}

/**
 * 归档后追加资料附件（attach_observation_images）：不改原文/确认稿，不自动成为指南证据。
 */
export async function appendObservationImages(
  deps: MediaServiceDeps,
  input: AppendObservationImagesInput,
): Promise<{ attachment_revision: number; attached: readonly string[] }> {
  assertImageIds(input.image_ids);
  assertHostChildWrite(input.principal, input.host);
  if (input.host.status !== "confirmed" || input.host.confirmed_at === null) {
    throw new MediaError("observation_not_confirmed", "只有已确认归档的观察才能追加资料附件。");
  }
  if (
    input.source_confirmed_at === null ||
    !sameInstant(input.source_confirmed_at, input.host.confirmed_at)
  ) {
    throw new MediaError(
      "source_conflict",
      "观察确认时间与提交的来源时间不一致，请刷新后重新核对。",
    );
  }
  const currentRevision = await deps.metadata.getObservationAttachmentRevision(input.host.observation_id);
  if (currentRevision !== input.expected_attachment_revision) {
    throw new MediaError("revision_conflict", "附件已在别处更新，请刷新后重新核对。");
  }
  await assertReadyAndOwned(deps, input.principal.account_id, input.image_ids);
  const result = await deps.metadata.addObservationReferences({
    observation_id: input.host.observation_id,
    attachment_ids: input.image_ids,
    actor_account_id: input.principal.account_id,
  });
  await deps.metadata.appendAttachmentAudit({
    audit_id: randomUUID(),
    action: "attach_observation_images",
    observation_id: input.host.observation_id,
    attachment_ids: [...input.image_ids],
    actor_account_id: input.principal.account_id,
    source_confirmed_at: input.source_confirmed_at,
    request_id: input.request_id,
    recorded_at: new Date().toISOString(),
  });
  return { attachment_revision: result.attachment_revision, attached: [...input.image_ids] };
}
