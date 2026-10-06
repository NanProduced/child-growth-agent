/**
 * 芽芽 run 持久化（AGENT-APP1，唯一 owner）。
 *
 * 只读写本模块新引入的 `yaya_runs` 表（DDL 见 scripts/upgrade-yaya-runs-v1.sql），
 * 不动既有业务/yaya 表。不变量：
 * - owner + conversation + client_request_id 唯一绑定原请求；同键同摘要不再次派发，异内容 409；
 * - 原请求登记（含 user_text 原文、附件、版本前提、原 session）成功提交后才允许派发模型；
 * - 终态用 `state='active' AND owner_instance=$` 守卫写入：迟到结果被拒，不覆盖新运行；
 * - dependencies 只增不覆盖；取消、替换、中断恢复标记均持久化。
 */
import { createHash } from 'node:crypto';

import { query, queryOne, type TransactionClient } from '@/storage/database/pg-client';

import { validateMessageAttachments } from '../../data/invariants';
import { YayaDataError, canonicalizeYayaValue } from '../../storage-types';
import type { YayaSourceRef } from '../../types';

export const YAYA_RUN_STATES = ['active', 'terminal', 'interrupted'] as const;
export type YayaRunState = (typeof YAYA_RUN_STATES)[number];

/**
 * run 级重核依赖（只增不覆盖）：
 * - tool 非空：由该只读工具产生的来源引用（按原工具动作重核）；
 * - message_id/fragment_id 非空：已装载的历史片段（重跑 DATA 当前投影比对可见性）；
 * - image_id 非空：已装载的授权图片（走 MEDIA 当前授权判定）。
 */
export interface YayaRunDependency {
  ref: YayaSourceRef | null;
  tool: string | null;
  image_id: string | null;
  message_id: string | null;
  fragment_id: string | null;
}

export interface YayaRunRecord {
  run_id: string;
  owner_account_id: string;
  conversation_id: string;
  client_request_id: string;
  request_digest: string;
  user_text: string;
  attachment_ids: string[];
  expected_conversation_revision: number;
  session_id: string;
  owner_instance: string;
  state: YayaRunState;
  outcome: unknown;
  dependencies: YayaRunDependency[];
  cancel_requested_at: string | null;
  replaced_by: string | null;
  deadline_at: string;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
}

export const YAYA_RUN_MAX_CLIENT_REQUEST_ID_LENGTH = 128;

export function computeYayaRunRequestDigest(input: {
  conversation_id: string;
  client_request_id: string;
  user_text: string;
  attachment_ids: readonly string[];
  expected_conversation_revision: number;
}): string {
  const canonical = canonicalizeYayaValue({
    conversation_id: input.conversation_id,
    client_request_id: input.client_request_id,
    user_text: input.user_text,
    attachment_ids: [...input.attachment_ids].sort(),
    expected_conversation_revision: input.expected_conversation_revision,
  });
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

const RUN_SELECT = 'to_jsonb(r.*) AS data';
const RUN_RETURNING = 'to_jsonb(yaya_runs.*) AS data';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((entry) => typeof entry === 'string') ? [...value] : null;
}

function parseDependency(value: unknown): YayaRunDependency | null {
  if (!isRecord(value)) return null;
  const nullableString = (entry: unknown): string | null =>
    typeof entry === 'string' && entry.length > 0 ? entry : null;
  const ref = value.ref;
  let parsedRef: YayaSourceRef | null = null;
  if (isRecord(ref) && typeof ref.kind === 'string') {
    parsedRef = {
      kind: ref.kind as YayaSourceRef['kind'],
      ref_id: typeof ref.ref_id === 'string' ? ref.ref_id : null,
      label: typeof ref.label === 'string' ? ref.label : null,
      derived_from: typeof ref.derived_from === 'string' ? ref.derived_from : null,
    };
  }
  const parsed: YayaRunDependency = {
    ref: parsedRef,
    tool: nullableString(value.tool),
    image_id: nullableString(value.image_id),
    message_id: nullableString(value.message_id),
    fragment_id: nullableString(value.fragment_id),
  };
  if (
    parsed.ref === null &&
    parsed.tool === null &&
    parsed.image_id === null &&
    parsed.message_id === null
  ) {
    return null;
  }
  return parsed;
}

export function parseYayaRunRecord(data: unknown): YayaRunRecord | null {
  if (!isRecord(data)) return null;
  if (typeof data.id !== 'string' || typeof data.owner_account_id !== 'string') return null;
  if (typeof data.conversation_id !== 'string' || typeof data.client_request_id !== 'string') return null;
  if (typeof data.request_digest !== 'string' || typeof data.user_text !== 'string') return null;
  if (typeof data.expected_conversation_revision !== 'number') return null;
  if (typeof data.session_id !== 'string' || typeof data.owner_instance !== 'string') return null;
  if (typeof data.state !== 'string' || !(YAYA_RUN_STATES as readonly string[]).includes(data.state)) {
    return null;
  }
  const attachments = stringArray(data.attachment_ids);
  if (attachments === null) return null;
  const rawDependencies = Array.isArray(data.dependencies) ? data.dependencies : [];
  const dependencies: YayaRunDependency[] = [];
  for (const raw of rawDependencies) {
    const parsed = parseDependency(raw);
    if (parsed !== null) dependencies.push(parsed);
  }
  const stringOrNull = (entry: unknown): string | null =>
    typeof entry === 'string' && entry.length > 0 ? entry : null;
  return {
    run_id: data.id,
    owner_account_id: data.owner_account_id,
    conversation_id: data.conversation_id,
    client_request_id: data.client_request_id,
    request_digest: data.request_digest,
    user_text: data.user_text,
    attachment_ids: attachments,
    expected_conversation_revision: data.expected_conversation_revision,
    session_id: data.session_id,
    owner_instance: data.owner_instance,
    state: data.state as YayaRunState,
    outcome: data.outcome ?? null,
    dependencies,
    cancel_requested_at: stringOrNull(data.cancel_requested_at),
    replaced_by: stringOrNull(data.replaced_by),
    deadline_at: typeof data.deadline_at === 'string' ? data.deadline_at : '',
    created_at: typeof data.created_at === 'string' ? data.created_at : '',
    updated_at: typeof data.updated_at === 'string' ? data.updated_at : '',
    terminal_at: stringOrNull(data.terminal_at),
  };
}

export interface YayaRunRegistrationInput {
  run_id: string;
  owner_account_id: string;
  conversation_id: string;
  client_request_id: string;
  user_text: string;
  attachment_ids: readonly string[];
  expected_conversation_revision: number;
  session_id: string;
  owner_instance: string;
  deadline_at: string;
}

export type YayaRunRegistration =
  | { kind: 'created'; run: YayaRunRecord }
  | { kind: 'replayed'; run: YayaRunRecord }
  | { kind: 'conflict'; run: YayaRunRecord }
  | { kind: 'active'; run: YayaRunRecord };

/**
 * 原请求登记（必须在事务内、且在派发模型之前提交）。
 * - 唯一索引裁决双连接竞争：只有一条 insert 成功；
 * - 已存在同键行：摘要一致按原运行处理（终态可回放、活跃中不重派），摘要不一致判幂等冲突。
 */
export async function registerYayaRun(
  client: TransactionClient,
  input: YayaRunRegistrationInput,
): Promise<YayaRunRegistration> {
  const digest = computeYayaRunRequestDigest(input);
  const inserted = await client.query<{ data: unknown }>(
    `INSERT INTO yaya_runs
       (id, owner_account_id, conversation_id, client_request_id, request_digest, user_text,
        attachment_ids, expected_conversation_revision, session_id, owner_instance, deadline_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11::timestamptz)
     ON CONFLICT (owner_account_id, conversation_id, client_request_id) DO NOTHING
     RETURNING ${RUN_RETURNING}`,
    [
      input.run_id,
      input.owner_account_id,
      input.conversation_id,
      input.client_request_id,
      digest,
      input.user_text,
      JSON.stringify([...input.attachment_ids]),
      input.expected_conversation_revision,
      input.session_id,
      input.owner_instance,
      input.deadline_at,
    ],
  );
  const created = inserted.rows[0] ? parseYayaRunRecord(inserted.rows[0]?.data) : null;
  if (created !== null) return { kind: 'created', run: created };

  const existing = await client.query<{ data: unknown }>(
    `SELECT ${RUN_SELECT} FROM yaya_runs r
      WHERE r.owner_account_id = $1 AND r.conversation_id = $2 AND r.client_request_id = $3
      FOR UPDATE`,
    [input.owner_account_id, input.conversation_id, input.client_request_id],
  );
  const run = existing.rows[0] ? parseYayaRunRecord(existing.rows[0]?.data) : null;
  if (run === null) {
    throw new YayaDataError('server_error', '运行登记失败。');
  }
  if (run.request_digest !== digest) return { kind: 'conflict', run };
  if (run.state === 'terminal') return { kind: 'replayed', run };
  return { kind: 'active', run };
}

export async function loadYayaRun(runId: string): Promise<YayaRunRecord | null> {
  const row = await queryOne<{ data: unknown }>(
    `SELECT ${RUN_SELECT} FROM yaya_runs r WHERE r.id = $1`,
    [runId],
  );
  return row === null ? null : parseYayaRunRecord(row.data);
}

export async function findYayaRunByClientRequest(
  ownerAccountId: string,
  conversationId: string,
  clientRequestId: string,
): Promise<YayaRunRecord | null> {
  const row = await queryOne<{ data: unknown }>(
    `SELECT ${RUN_SELECT} FROM yaya_runs r
      WHERE r.owner_account_id = $1 AND r.conversation_id = $2 AND r.client_request_id = $3`,
    [ownerAccountId, conversationId, clientRequestId],
  );
  return row === null ? null : parseYayaRunRecord(row.data);
}

/** 依赖唯一键：同一引用/图片/历史片段只保留一份（只增不覆盖） */
export function yayaRunDependencyKey(dependency: YayaRunDependency): string {
  return JSON.stringify(dependency);
}

/**
 * 按 run 累积重核依赖：读当前值、合并去重后整写；只增不覆盖。
 * 每个 run 只有唯一派发者写这一列，先读后写即可；查询路径不写。
 */
export async function appendYayaRunDependencies(
  runId: string,
  additions: readonly YayaRunDependency[],
): Promise<YayaRunDependency[]> {
  const current = await queryOne<{ dependencies: unknown }>(
    'SELECT dependencies FROM yaya_runs WHERE id = $1',
    [runId],
  );
  const merged: YayaRunDependency[] = [];
  const seen = new Set<string>();
  const absorb = (raw: unknown): void => {
    const entry = parseDependency(raw);
    if (entry === null) return;
    const key = yayaRunDependencyKey(entry);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(entry);
  };
  if (current !== null && Array.isArray(current.dependencies)) {
    for (const raw of current.dependencies) absorb(raw);
  }
  for (const addition of additions) absorb(addition);
  if (current !== null && merged.length > 0) {
    await query(
      `UPDATE yaya_runs SET dependencies = $2::jsonb, updated_at = now()
        WHERE id = $1 AND state = 'active'`,
      [runId, JSON.stringify(merged)],
    );
  }
  return merged;
}

/**
 * 终态落库（迟到结果守卫）：
 * - 仅 `state='active' AND owner_instance=$` 的当前运行可写；已被外部终态化/替换/中断的行拒绝覆盖；
 * - 取消与替换在引擎的每个异步边界生效（`resolveYayaRunCurrentIdentity` 返回取消/替换停止）；
 *   引擎已完成并发布终态后才到达的取消/替换不回溯改写已发布结果，保证流与库一致；
 * - 写入失败（返回 null）表示该结果已被取代，调用方不得把它当作当前终态发布。
 */
export async function finalizeYayaRun(
  runId: string,
  ownerInstance: string,
  outcome: unknown,
): Promise<YayaRunRecord | null> {
  const row = await queryOne<{ data: unknown }>(
    `UPDATE yaya_runs r
        SET state = 'terminal', outcome = $3::jsonb, terminal_at = now(), updated_at = now()
      WHERE r.id = $1 AND r.state = 'active' AND r.owner_instance = $2
      RETURNING ${RUN_SELECT}`,
    [runId, ownerInstance, JSON.stringify(outcome ?? null)],
  );
  return row === null ? null : parseYayaRunRecord(row.data);
}

/** 中断恢复标记：不可核验的异常终止；不产生终态 outcome（查询按不可核验返回） */
export async function markYayaRunInterrupted(
  runId: string,
  ownerInstance: string,
): Promise<YayaRunRecord | null> {
  const row = await queryOne<{ data: unknown }>(
    `UPDATE yaya_runs r
        SET state = 'interrupted', updated_at = now()
      WHERE r.id = $1 AND r.state = 'active' AND r.owner_instance = $2
      RETURNING ${RUN_SELECT}`,
    [runId, ownerInstance],
  );
  return row === null ? null : parseYayaRunRecord(row.data);
}

/** 取消请求持久化（owner 限定，幂等）；owner 进程在下一个异步边界观察到并停止后续派发/消费 */
export async function requestYayaRunCancel(
  client: TransactionClient,
  runId: string,
  ownerAccountId: string,
): Promise<YayaRunRecord | null> {
  const row = await client.query<{ data: unknown }>(
    `UPDATE yaya_runs
        SET cancel_requested_at = COALESCE(yaya_runs.cancel_requested_at, now()), updated_at = now()
      WHERE yaya_runs.id = $1 AND yaya_runs.owner_account_id = $2
      RETURNING ${RUN_RETURNING}`,
    [runId, ownerAccountId],
  );
  return row.rows[0] ? parseYayaRunRecord(row.rows[0].data) : null;
}

export class YayaRunInactiveError extends Error {
  readonly code = 'run_inactive' as const;
  constructor(message = '原运行已结束、被取消或被取代，拒绝保存迟到结果。') {
    super(message);
    this.name = 'YayaRunInactiveError';
  }
}

/**
 * TOOLS1 保存前 hook：在同一 TransactionClient 内锁定并核对当前 run 仍为
 * 本进程的 active 运行。提案落库、模型结果发布、终态落库前都应调用。
 */
export async function assertYayaRunActive(
  client: TransactionClient,
  runId: string,
  ownerInstance: string,
): Promise<void> {
  const row = await client.query<{
    state: string;
    owner_instance: string;
    cancel_requested_at: Date | string | null;
    replaced_by: string | null;
  }>(
    `SELECT state, owner_instance, cancel_requested_at, replaced_by
       FROM yaya_runs WHERE id = $1 FOR UPDATE`,
    [runId],
  );
  const current = row.rows[0];
  if (
    !current ||
    current.state !== 'active' ||
    current.owner_instance !== ownerInstance ||
    current.cancel_requested_at !== null ||
    current.replaced_by !== null
  ) {
    throw new YayaRunInactiveError();
  }
}

/** 发起前附件绑定核对：必须 ready 且 uploader 就是本次 run 的 owner（不泄漏他人附件存在性） */
export async function assertYayaRunAttachments(
  client: TransactionClient,
  ownerAccountId: string,
  attachmentIds: readonly string[],
): Promise<void> {
  if (attachmentIds.length === 0) return;
  const rows = await client.query<{ id: string; uploader_account_id: string; status: string }>(
    'SELECT id, uploader_account_id, status FROM yaya_attachments WHERE id = ANY($1::varchar[])',
    [[...attachmentIds]],
  );
  const byId = new Map(rows.rows.map((row) => [row.id, row] as const));
  const facts = attachmentIds.map((attachmentId) => {
    const row = byId.get(attachmentId);
    return row === undefined
      ? { attachment_id: attachmentId, uploader_account_id: '', status: 'absent' as const }
      : {
          attachment_id: attachmentId,
          uploader_account_id: row.uploader_account_id,
          status: row.status as 'pending' | 'ready' | 'deleting' | 'deleted',
        };
  });
  const errors = validateMessageAttachments(ownerAccountId, facts);
  if (errors.length === 0) return;
  if (errors.some((entry) => entry.startsWith('attachment_conflict'))) {
    throw new YayaDataError('attachment_conflict', '附件尚未就绪或不可用。');
  }
  throw new YayaDataError('attachment_missing', '附件不存在或不属于当前账号。');
}
