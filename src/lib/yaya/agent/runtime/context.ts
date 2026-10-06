/**
 * 芽芽运行期上下文装配与动态授权重核（AGENT-APP1）。
 *
 * - 历史加载走 DATA 当前投影：只有 full 片段进入模型上下文与来源清单；
 * - 图片只加载 MEDIA 当前授权、处理后的 `model` 变体字节（base64），
 *   不接触对象 key / 签名 URL / Cookie / CSRF；
 * - READ1 的 `recheck_dependencies` 按 run 累积（只增不覆盖），历史片段与图片
 *   一并登记为 run 级依赖；
 * - `revalidateProjectedContext` 逐项复读真实资源并按**原工具动作**授权
 *   （scope_query 走原 scope 边界，对象引用按对应读取动作/指南参考边界），
 *   历史片段重跑 DATA 当前投影比对 full 可见性，图片走 MEDIA 当前授权判定；
 *   任何不可核验都保守返回 context_revoked，不继续消费旧私域数据。
 */
import { authorizeAction } from '@/lib/accounts/authorize';
import type { HeaderCarrier } from '@/lib/accounts/guards';
import type { AccessAction, AccessResource, Principal } from '@/lib/accounts/types';
import { withPrivateRead, yayaDataRepository } from '@/lib/yaya/data';
import { projectMessageRow } from '@/lib/yaya/data/projection';
import type { YayaMessageRow } from '@/lib/yaya/data/rows';
import { evaluateAttachmentRead, loadAttachmentContent } from '@/lib/media/content-service';
import { createDatabaseRecordAccessLoader } from '@/lib/media/record-access';
import { mediaRuntimeOrThrow } from '@/lib/media/runtime';
import { queryOne } from '@/storage/database/pg-client';

import type {
  YayaAuthorizedImage,
  YayaContextRevalidation,
  YayaContextRevalidationInput,
  YayaContextTurn,
  YayaProjectedContext,
} from '../types';
import { YAYA_AUTHORIZED_IMAGE_MEDIA_TYPES } from '../types';
import type { YayaSourceRef } from '../../types';

import {
  appendYayaRunDependencies,
  yayaRunDependencyKey,
  type YayaRunDependency,
  type YayaRunRecord,
} from './store';

export const YAYA_RUN_HISTORY_LIMIT = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 单次 run 的运行上下文：原会话令牌、run 级依赖、历史片段快照与图片 id */
export interface YayaRunRuntimeState {
  run: YayaRunRecord;
  token: string;
  owner_instance: string;
  carrier: HeaderCarrier;
  dependencies: Map<string, YayaRunDependency>;
  image_ids: Set<string>;
  /** 上下文加载不可核验（DATA/MEDIA 失败）：重核必须保守停止 */
  load_failed: boolean;
  /** 持久化依赖损坏/缺快照（行存在但不可读）：内容终态保守不可核验 */
  dependencies_unreadable: boolean;
}

export function createYayaRunRuntimeState(input: {
  run: YayaRunRecord;
  token: string;
  owner_instance: string;
  carrier: HeaderCarrier;
}): YayaRunRuntimeState {
  return {
    run: input.run,
    token: input.token,
    owner_instance: input.owner_instance,
    carrier: input.carrier,
    dependencies: new Map(),
    image_ids: new Set(),
    load_failed: false,
    dependencies_unreadable: false,
  };
}

/** 查询路径：从持久化的 run 记录复原依赖集合，用当前请求会话重核终态可展示性 */
export function createYayaRunRuntimeStateFromRecord(
  run: YayaRunRecord,
  carrier: HeaderCarrier,
): YayaRunRuntimeState {
  const state: YayaRunRuntimeState = {
    run,
    token: '',
    owner_instance: '',
    carrier,
    dependencies: new Map(),
    image_ids: new Set(),
    load_failed: false,
    dependencies_unreadable: run.dependencies_corrupt,
  };
  for (const dependency of run.dependencies) {
    state.dependencies.set(yayaRunDependencyKey(dependency), dependency);
    if (dependency.image_id !== null) state.image_ids.add(dependency.image_id);
  }
  return state;
}

/** 依赖先记入内存（本 run 权威集合），再持久化供跨进程查询；持久化失败/损坏保守停 run */
export async function absorbYayaRunDependencies(
  state: YayaRunRuntimeState,
  additions: readonly YayaRunDependency[],
): Promise<void> {
  const fresh: YayaRunDependency[] = [];
  for (const dependency of additions) {
    const key = yayaRunDependencyKey(dependency);
    if (state.dependencies.has(key)) continue;
    state.dependencies.set(key, dependency);
    fresh.push(dependency);
  }
  for (const dependency of additions) {
    if (dependency.image_id !== null) state.image_ids.add(dependency.image_id);
  }
  if (fresh.length === 0) return;
  if (state.run.state !== 'active') return;
  try {
    const stored = await appendYayaRunDependencies(state.run.run_id, fresh);
    if (stored.corrupt) state.dependencies_unreadable = true;
  } catch {
    state.load_failed = true;
  }
}

export function listYayaRunDependencies(state: YayaRunRuntimeState): YayaRunDependency[] {
  return [...state.dependencies.values()];
}

/* --------------------------------- 上下文加载 --------------------------------- */

function sourceKey(source: YayaSourceRef): string {
  return `${source.kind}\u0000${source.ref_id ?? ''}\u0000${source.derived_from ?? ''}`;
}

async function loadHistory(
  state: YayaRunRuntimeState,
): Promise<{ turns: YayaContextTurn[]; sources: YayaSourceRef[]; dependencies: YayaRunDependency[] }> {
  const view = await withPrivateRead(state.carrier, ({ client, principal, schoolId }) =>
    yayaDataRepository.listMessages(client, principal, schoolId, state.run.conversation_id, {
      limit: YAYA_RUN_HISTORY_LIMIT,
    }),
  );
  const turns: YayaContextTurn[] = [];
  const sources: YayaSourceRef[] = [];
  const sourceKeys = new Set<string>();
  const dependencies: YayaRunDependency[] = [];
  for (const message of view.messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = message.fragments
      .map((fragment) => fragment.text)
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .join('\n');
    if (text.trim().length === 0) continue;
    turns.push({ role: message.role, content: text });
    for (const fragment of message.fragments) {
      if (fragment.visibility !== 'full') continue;
      if (fragment.provenance !== null) {
        const key = sourceKey(fragment.provenance);
        if (!sourceKeys.has(key)) {
          sourceKeys.add(key);
          sources.push(fragment.provenance);
        }
      }
      dependencies.push({
        ref: fragment.provenance,
        tool: null,
        image_id: null,
        message_id: message.message_id,
        fragment_id: fragment.fragment_id,
        projection: 'any',
      });
    }
  }
  return { turns, sources, dependencies };
}

async function loadImages(
  state: YayaRunRuntimeState,
  principal: Principal,
): Promise<{
  images: YayaAuthorizedImage[];
  dependencies: YayaRunDependency[];
  denied: string[];
}> {
  if (state.run.attachment_ids.length === 0) {
    return { images: [], dependencies: [], denied: [] };
  }
  const runtime = mediaRuntimeOrThrow();
  const viewer = { account_id: principal.account_id, role: principal.role };
  const loadRecordAccess = createDatabaseRecordAccessLoader(principal);
  const images: YayaAuthorizedImage[] = [];
  const dependencies: YayaRunDependency[] = [];
  const denied: string[] = [];
  for (const attachmentId of state.run.attachment_ids) {
    try {
      const content = await loadAttachmentContent(runtime, {
        attachment_id: attachmentId,
        viewer,
        loadRecordAccess,
        variant: 'model',
      });
      const mediaType = content.content_type;
      if (!(YAYA_AUTHORIZED_IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
        denied.push(attachmentId);
        continue;
      }
      images.push({
        image_id: attachmentId,
        media_type: mediaType as YayaAuthorizedImage['media_type'],
        data_base64: content.body.toString('base64'),
        source: {
          kind: 'image_interpretation',
          ref_id: attachmentId,
          label: '教师上传图片（服务端已授权、已处理字节）',
          derived_from: null,
        },
      });
      dependencies.push({
        ref: null,
        tool: null,
        image_id: attachmentId,
        message_id: null,
        fragment_id: null,
        projection: 'any',
      });
    } catch {
      denied.push(attachmentId);
    }
  }
  return { images, dependencies, denied };
}

/**
 * 正式 `loadProjectedContext`：任何子步骤不可核验都返回空上下文并置 load_failed，
 * 由下一次重核保守停止；绝不把未核验的私域内容送入模型。
 */
export async function loadYayaRunProjectedContext(
  state: YayaRunRuntimeState,
  principal: Principal | null,
): Promise<YayaProjectedContext> {
  if (principal === null) {
    state.load_failed = true;
    return { history: [], sources: [], images: [], guide_catalog: null };
  }
  let turns: YayaContextTurn[] = [];
  let sources: YayaSourceRef[] = [];
  let images: YayaAuthorizedImage[] = [];
  const additions: YayaRunDependency[] = [];
  try {
    const history = await loadHistory(state);
    turns = history.turns;
    sources = history.sources;
    additions.push(...history.dependencies);
  } catch {
    state.load_failed = true;
  }
  try {
    const loaded = await loadImages(state, principal);
    images = loaded.images;
    additions.push(...loaded.dependencies);
    if (loaded.denied.length > 0) state.load_failed = true;
  } catch {
    state.load_failed = true;
  }
  await absorbYayaRunDependencies(state, additions);
  return { history: turns, sources, images, guide_catalog: null };
}

/* --------------------------------- 依赖重核 --------------------------------- */

const AGGREGATE_SCOPE_SOURCES = new Set([
  'children:current_scope',
  'observations:current_scope',
  'classes:assigned',
  'classes:catalog',
]);

function readResourceFacts(
  kind: 'child' | 'class' | 'observation',
  id: string,
): Promise<AccessResource | null> {
  if (kind === 'class') {
    return queryOne<{ id: string }>('SELECT id FROM classes WHERE id = $1', [id]).then((row) =>
      row === null ? null : { kind: 'class', class_id: id },
    );
  }
  if (kind === 'child') {
    return queryOne<{ current_class_id: string | null }>(
      `SELECT (SELECT e.class_id FROM child_class_enrollments e
                WHERE e.child_id = c.id AND e.end_date IS NULL
                ORDER BY e.start_date DESC LIMIT 1) AS current_class_id
         FROM children c WHERE c.id = $1`,
      [id],
    ).then((row) =>
      row === null ? null : { kind: 'child', child_id: id, current_class_id: row.current_class_id },
    );
  }
  return queryOne<{
    child_id: string;
    observed_class_id: string | null;
    current_class_id: string | null;
    author_account_id: string | null;
  }>(
    `SELECT o.child_id,
            o.class_id AS observed_class_id,
            (SELECT e.class_id FROM child_class_enrollments e
              WHERE e.child_id = o.child_id AND e.end_date IS NULL
              ORDER BY e.start_date DESC LIMIT 1) AS current_class_id,
            to_jsonb(o.*)->>'created_by_account_id' AS author_account_id
       FROM observations o WHERE o.id = $1`,
    [id],
  ).then((row) =>
    row === null
      ? null
      : {
          kind: 'observation',
          observation_id: id,
          child_id: row.child_id,
          current_class_id: row.current_class_id,
          observed_class_id: row.observed_class_id,
          author_account_id: row.author_account_id,
        },
  );
}

/** business_scope 边界探针：复用 AUTH `class.catalog.read` 的当前范围判定（空任教/无范围拒绝） */
function scopeBoundaryAllows(principal: Principal): boolean {
  return authorizeAction(principal, 'class.catalog.read', {
    kind: 'class',
    class_id: 'yaya-scope-probe',
  }).allowed;
}

/**
 * 逐引用按**原工具动作 + 已加载投影要求**重核：
 * - 对象引用（child/class/observation）复读真实资源事实后按对应读取动作授权；
 *   `list_classes` / `resolve_child_class` 的班级引用按基础目录（class.catalog.read）核验；
 * - 已按完整投影加载的数据（`projection='full'`）要求当前仍给完整投影；
 *   当前只剩 historical_read_only 时停止消费/发布旧完整 payload；
 *   仅按历史只读加载的数据保持可用（合法最小查询不被全禁）；
 * - `projection` 缺失（旧 run / 损坏存储）保守拒绝，不补造历史；
 * - scope/目录来源走原 scope 边界；指南引用只要求有效账号（authenticated_reference）；
 * - 教师账号引用要求管理员 + 全园范围；未知引用保守拒绝。
 */
export async function recheckYayaRunDependency(
  principal: Principal,
  dependency: YayaRunDependency,
): Promise<boolean> {
  if (dependency.image_id !== null) return true; // 图片由 MEDIA 当前授权单独判定
  const requiredProjection = dependency.projection;
  if (requiredProjection === null) return false;
  const source = dependency.ref;
  if (source === null || source.ref_id === null) return true;
  const refId = source.ref_id;
  if (
    refId.startsWith('guide_item:') ||
    refId.startsWith('guide_goal:') ||
    refId.startsWith('guide_suggestion:') ||
    refId === 'guide_catalog:items'
  ) {
    return principal.account_status === 'active';
  }
  if (AGGREGATE_SCOPE_SOURCES.has(refId)) {
    return scopeBoundaryAllows(principal);
  }
  if (refId.startsWith('teacher:') || refId === 'teacher_accounts:school') {
    return authorizeAction(principal, 'teacher.manage', {
      kind: 'school',
      school_id: 'yaya-school',
    }).allowed;
  }
  const separator = refId.indexOf(':');
  if (separator <= 0) return false;
  const prefix = refId.slice(0, separator);
  const id = refId.slice(separator + 1);
  if (id.length === 0) return false;
  let action: AccessAction;
  if (prefix === 'child') action = 'child.read';
  else if (prefix === 'observation') action = 'observation.read';
  else if (prefix === 'class') {
    action =
      dependency.tool === 'list_classes' || dependency.tool === 'resolve_child_class'
        ? 'class.catalog.read'
        : 'class.read';
  } else {
    return false;
  }
  const facts = await readResourceFacts(prefix as 'child' | 'class' | 'observation', id);
  if (facts === null) return false;
  const decision = authorizeAction(principal, action, facts);
  if (!decision.allowed) return false;
  if (requiredProjection === 'full' && decision.projection !== 'full') return false;
  return true;
}

/**
 * 历史片段重核（精确读取，不受最近 20 条模型窗口限制）：
 * - 按本 run 登记的 message_id/fragment_id 直接读取该行，重跑 DATA 当前投影；
 * - 只有该片段当前仍为 full 才放行；删除、损坏、来源撤权、会话删除一律保守拒绝；
 * - 不扩大模型历史加载（loadHistory 仍保留 20 条上限）。
 */
async function recheckHistory(
  state: YayaRunRuntimeState,
  denied: string[],
): Promise<void> {
  const snapshots = [...state.dependencies.values()].filter(
    (dependency) => dependency.message_id !== null && dependency.fragment_id !== null,
  );
  if (snapshots.length === 0) return;
  const messageIds = [...new Set(snapshots.map((dependency) => dependency.message_id as string))];
  let deniedKeys: string[];
  try {
    deniedKeys = await withPrivateRead(state.carrier, async ({ client, principal, schoolId }) => {
      const conversation = await yayaDataRepository.getConversation(
        client,
        principal.account_id,
        state.run.conversation_id,
      );
      if (conversation === null) {
        return snapshots.map(
          (dependency) => `${dependency.message_id as string}#${dependency.fragment_id as string}`,
        );
      }
      const result = await client.query<{ data: unknown }>(
        'SELECT to_jsonb(m.*) AS data FROM yaya_messages m WHERE m.id = ANY($1::varchar[])',
        [messageIds],
      );
      const byId = new Map<string, Record<string, unknown>>();
      for (const row of result.rows) {
        if (isRecord(row.data) && typeof row.data.id === 'string') byId.set(row.data.id, row.data);
      }
      const localDenied: string[] = [];
      for (const dependency of snapshots) {
        const messageId = dependency.message_id as string;
        const fragmentId = dependency.fragment_id as string;
        const key = `${messageId}#${fragmentId}`;
        const raw = byId.get(messageId);
        if (
          raw === undefined ||
          (raw.deleted_at !== null && raw.deleted_at !== undefined) ||
          raw.owner_account_id !== principal.account_id
        ) {
          localDenied.push(key);
          continue;
        }
        let visible = false;
        try {
          const projection = await projectMessageRow(
            client,
            principal,
            schoolId,
            raw as unknown as YayaMessageRow,
          );
          const fragment = projection.fragments.find((entry) => entry.fragment_id === fragmentId);
          visible = fragment !== undefined && fragment.visibility === 'full' && fragment.text !== null;
        } catch {
          visible = false;
        }
        if (!visible) localDenied.push(key);
      }
      return localDenied;
    });
  } catch {
    deniedKeys = snapshots.map(
      (dependency) => `${dependency.message_id as string}#${dependency.fragment_id as string}`,
    );
  }
  for (const key of deniedKeys) denied.push(key);
}

async function recheckImages(state: YayaRunRuntimeState, denied: string[], viewer: Principal): Promise<void> {
  const imageIds = [...state.image_ids];
  if (imageIds.length === 0) return;
  let runtime;
  try {
    runtime = mediaRuntimeOrThrow();
  } catch {
    for (const imageId of imageIds) denied.push(imageId);
    return;
  }
  const loadRecordAccess = createDatabaseRecordAccessLoader(viewer);
  for (const attachmentId of imageIds) {
    try {
      const evaluation = await evaluateAttachmentRead(runtime, {
        attachment_id: attachmentId,
        viewer: { account_id: viewer.account_id, role: viewer.role },
        loadRecordAccess,
      });
      if (!evaluation.decision.readable) denied.push(attachmentId);
    } catch {
      denied.push(attachmentId);
    }
  }
}

/**
 * 正式 `revalidateProjectedContext`：
 * 引擎传入的 sources/image_ids 与本 run 累积依赖合并后逐项重核；
 * 任何一个不可核验（含加载阶段失败）都返回 `context_revoked` 并列出拒绝引用。
 */
export async function revalidateYayaRunContext(
  state: YayaRunRuntimeState,
  input: YayaContextRevalidationInput,
  identity: { principal: Principal | null },
): Promise<YayaContextRevalidation> {
  if (state.load_failed) {
    return { ok: false, reason: 'context_revoked', denied_refs: ['context_load_failed'] };
  }
  if (state.dependencies_unreadable) {
    // 行存在但依赖损坏/缺快照：内容不可核验，不补造历史、不继续消费。
    return { ok: false, reason: 'context_revoked', denied_refs: ['dependencies_unreadable'] };
  }
  const principal = identity.principal;
  if (principal === null) {
    return { ok: false, reason: 'context_revoked', denied_refs: ['identity_missing'] };
  }
  const dependencies = new Map(state.dependencies);
  const recordedRefKeys = new Set(
    [...state.dependencies.values()]
      .map((dependency) => (dependency.ref === null ? null : sourceKey(dependency.ref)))
      .filter((key): key is string => key !== null),
  );
  for (const source of input.sources) {
    // 已登记的来源（含历史片段 provenance）由各自的完整依赖重核覆盖，不重复挂载。
    if (recordedRefKeys.has(sourceKey(source))) continue;
    const dependency: YayaRunDependency = {
      ref: source,
      tool: null,
      image_id: null,
      message_id: null,
      fragment_id: null,
      projection: 'any',
    };
    const key = yayaRunDependencyKey(dependency);
    if (!dependencies.has(key)) dependencies.set(key, dependency);
  }
  const denied: string[] = [];
  for (const dependency of dependencies.values()) {
    // 历史片段依赖由 recheckHistory 重跑当前投影校验；这里不再按 provenance ref 单独判资源。
    if (dependency.message_id !== null) continue;
    let allowed = false;
    try {
      allowed = await recheckYayaRunDependency(principal, dependency);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      denied.push(
        dependency.ref?.ref_id ??
          dependency.image_id ??
          dependency.message_id ??
          dependency.fragment_id ??
          'unknown',
      );
    }
  }
  await recheckHistory(state, denied);
  await recheckImages(state, denied, principal);
  const unique = [...new Set(denied)];
  if (unique.length > 0) {
    return { ok: false, reason: 'context_revoked', denied_refs: unique };
  }
  return { ok: true };
}
