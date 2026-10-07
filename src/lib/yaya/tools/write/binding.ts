/**
 * payload ↔ 批准元数据绑定（R2 P1-A）：
 * 从保存 payload 的 kind+operation 推导真实 action / resource / resource_ref，
 * 与提案条目声明逐字段比较；不一致在 `loadOperations`（模型与回执之前）抛
 * `invalid_request`——零模型、零回执、批准不消费。
 * 比较不用 JSON.stringify（resource_ref 键序来自 jsonb，不稳定）。
 * 公开准备入口只做 `parseWritePayload` 形状校验，绑定必须在执行入口：
 * DATA 回归用声明与 payload 不一致的合成条目走公开准备（201）是既定语义。
 */
import type { TransactionClient } from '@/storage/database/pg-client';

import { parseResourceRef } from '../../data/rows';
import { YayaDataError, type YayaItemResourceRef } from '../../storage-types';
import type { YayaDomainPayload } from '../../types';
import { parseWritePayload } from './schemas';

interface DerivedBinding {
  action: string;
  resource: string;
  ref: YayaItemResourceRef;
}

async function deriveItemBinding(
  client: TransactionClient,
  payload: YayaDomainPayload,
): Promise<DerivedBinding> {
  switch (payload.kind) {
    case 'create_observation':
      return { action: 'observation.write', resource: 'child', ref: { kind: 'child', child_id: payload.child_id } };
    case 'organize_observation':
    case 'follow_up_observation':
      return {
        action: 'observation.organize',
        resource: 'observation',
        ref: { kind: 'observation', observation_id: payload.observation_id },
      };
    case 'confirm_observation':
      return {
        action: 'observation.confirm',
        resource: 'observation',
        ref: { kind: 'observation', observation_id: payload.observation_id },
      };
    case 'guide_decision':
      return {
        action: 'guide.decide',
        resource: 'observation',
        ref: { kind: 'observation', observation_id: payload.observation_id },
      };
    case 'create_child':
      return {
        action: 'child.create_profile',
        resource: 'class',
        ref: { kind: 'class', class_id: payload.target_class_id },
      };
    case 'transfer_child':
      return {
        action: 'child.transfer',
        resource: 'transfer',
        ref: { kind: 'transfer', child_id: payload.child_id, target_class_id: payload.target_class_id },
      };
    case 'manage_class':
      return { action: 'class.manage', resource: 'class', ref: { kind: 'class', class_id: payload.class_id } };
    case 'manage_teacher':
      return payload.operation === 'set_status'
        ? { action: 'teacher.manage', resource: 'school', ref: { kind: 'school' } }
        : {
            action: 'teacher.assign',
            resource: 'class',
            ref: { kind: 'class', class_id: payload.class_ids[0] ?? null },
          };
    case 'refresh_growth_profile':
      return { action: 'growth_profile.write', resource: 'child', ref: { kind: 'child', child_id: payload.child_id } };
    case 'refresh_activity_support':
      return {
        action: 'activity_support.write',
        resource: 'child',
        ref: { kind: 'child', child_id: payload.child_id },
      };
    case 'attach_observation_images': {
      const found = await client.query<{ child_id: string }>(
        'SELECT child_id FROM observations WHERE id = $1',
        [payload.observation_id],
      );
      const childId = found.rows[0]?.child_id;
      if (childId === undefined) throw new YayaDataError('not_found', '观察记录不存在。');
      return { action: 'observation.write', resource: 'child', ref: { kind: 'child', child_id: childId } };
    }
  }
}

function sameResourceRef(left: YayaItemResourceRef, right: YayaItemResourceRef): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'school':
      return true;
    case 'class':
      return right.kind === 'class' && left.class_id === right.class_id;
    case 'child':
      return right.kind === 'child' && left.child_id === right.child_id;
    case 'transfer':
      return (
        right.kind === 'transfer' &&
        left.child_id === right.child_id &&
        left.target_class_id === right.target_class_id
      );
    case 'observation':
      return right.kind === 'observation' && left.observation_id === right.observation_id;
  }
}

/** 执行入口绑定：payload 形状 + 推导身份与提案条目声明一致性；不一致即 `invalid_request`。 */
export async function assertProposalItemBinding(
  client: TransactionClient,
  item: { action: string; resource: string; resource_ref: unknown; payload: unknown },
): Promise<void> {
  const payload = parseWritePayload(item.payload);
  const derived = await deriveItemBinding(client, payload);
  if (item.action !== derived.action || item.resource !== derived.resource) {
    throw new YayaDataError('invalid_request', '提案条目声明与 payload 不一致。');
  }
  const declaredRef = parseResourceRef(item.resource_ref);
  if (declaredRef === null || !sameResourceRef(declaredRef, derived.ref)) {
    throw new YayaDataError('invalid_request', '提案条目标与 payload 目标不一致。');
  }
}
