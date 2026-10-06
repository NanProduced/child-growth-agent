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

import { query, queryOne, withTransaction, type TransactionClient } from '@/storage/database/pg-client';

import { validateMessageAttachments } from '../../data/invariants';
import { YayaDataError, canonicalizeYayaValue } from '../../storage-types';
import { YAYA_PROVENANCE_KINDS, type YayaSourceRef } from '../../types';

export const YAYA_RUN_STATES = ['active', 'terminal', 'interrupted'] as const;
export type YayaRunState = (typeof YAYA_RUN_STATES)[number];

/** 已加载数据所需的投影等级；`any` = 无投影等级要求（仅资源级授权） */
export const YAYA_RUN_PROJECTION_REQUIREMENTS = ['full', 'historical_read_only', 'any'] as const;
export type YayaRunProjectionRequirement = (typeof YAYA_RUN_PROJECTION_REQUIREMENTS)[number];

/**
 * run 级重核依赖（只增不覆盖，逐条严格校验）：
 * - tool 非空：由该只读工具产生的来源引用（按原工具动作重核）；
 * - message_id/fragment_id 非空：已装载的历史片段（按精确 id 重跑 DATA 当前投影）；
 * - image_id 非空：已装载的授权图片（走 MEDIA 当前授权判定）；
 * - projection：已加载数据所需的投影等级。`full` 记录要求当前仍为完整投影，
 *   当前只剩 historical_read_only 时不得继续消费/发布旧完整 payload。
 *   缺失该字段（旧 run 或损坏存储）一律保守不可核验，不补造历史。
 */
export interface YayaRunDependency {
  ref: YayaSourceRef | null;
  tool: string | null;
  image_id: string | null;
  message_id: string | null;
  fragment_id: string | null;
  projection: YayaRunProjectionRequirement | null;
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
  /** 持久化依赖存在损坏/缺快照条目：行仍在，但依赖不可用，内容终态保守不可核验 */
  dependencies_corrupt: boolean;
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

function parseOptionalNonEmptyString(
  value: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value === 'string' && value.length > 0) return { ok: true, value };
  return { ok: false };
}

function parseStoredSourceRef(value: unknown): YayaSourceRef | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.kind !== 'string' ||
    !(YAYA_PROVENANCE_KINDS as readonly string[]).includes(value.kind)
  ) {
    return null;
  }
  const refId = value.ref_id;
  if (refId !== null && (typeof refId !== 'string' || refId.length === 0)) return null;
  const label = value.label;
  if (label !== null && typeof label !== 'string') return null;
  const derivedFrom = value.derived_from;
  if (derivedFrom !== null && typeof derivedFrom !== 'string') return null;
  return {
    kind: value.kind as YayaSourceRef['kind'],
    ref_id: refId === null || refId === undefined ? null : refId,
    label: label === null || label === undefined ? null : label,
    derived_from: derivedFrom === null || derivedFrom === undefined ? null : derivedFrom,
  };
}

/**
 * 逐条严格校验；任一条不符合形状即整组损坏（不丢坏条后假装完整）。
 * 必要字段：ref / image_id / message_id 至少其一；message_id 与 fragment_id 成对；
 * projection 必须显式给出（旧 run 缺快照 = 损坏，不可核验）。
 */
function parseStrictDependency(value: unknown): YayaRunDependency | null {
  if (!isRecord(value)) return null;
  // 合法 ref=null 与非空 ref 解析失败必须区分：任何非空 ref 的未知 kind、缺字段或
  // 非法类型都使整组不可核验，不得因同一目另有合法 message/image 选择器而豁免。
  let ref: YayaSourceRef | null = null;
  if (value.ref !== null && value.ref !== undefined) {
    ref = parseStoredSourceRef(value.ref);
    if (ref === null) return null;
  }
  const tool = parseOptionalNonEmptyString(value.tool);
  const imageId = parseOptionalNonEmptyString(value.image_id);
  const messageId = parseOptionalNonEmptyString(value.message_id);
  const fragmentId = parseOptionalNonEmptyString(value.fragment_id);
  if (!tool.ok || !imageId.ok || !messageId.ok || !fragmentId.ok) return null;
  if ((messageId.value === null) !== (fragmentId.value === null)) return null;
  if (ref === null && imageId.value === null && messageId.value === null) return null;
  const projection = value.projection;
  if (
    typeof projection !== 'string' ||
    !(YAYA_RUN_PROJECTION_REQUIREMENTS as readonly string[]).includes(projection)
  ) {
    return null;
  }
  return {
    ref,
    tool: tool.value,
    image_id: imageId.value,
    message_id: messageId.value,
    fragment_id: fragmentId.value,
    projection: projection as YayaRunProjectionRequirement,
  };
}

export interface YayaRunStoredDependencies {
  dependencies: YayaRunDependency[];
  corrupt: boolean;
}

/** 依赖组严格解析：合法空数组与损坏/部分不可读严格区分 */
export function parseStoredDependencies(value: unknown): YayaRunStoredDependencies {
  if (value === null || value === undefined) return { dependencies: [], corrupt: false };
  if (!Array.isArray(value)) return { dependencies: [], corrupt: true };
  const dependencies: YayaRunDependency[] = [];
  for (const raw of value) {
    const parsed = parseStrictDependency(raw);
    if (parsed === null) return { dependencies: [], corrupt: true };
    dependencies.push(parsed);
  }
  return { dependencies, corrupt: false };
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
  const parsedDependencies = parseStoredDependencies(data.dependencies);
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
    dependencies: parsedDependencies.dependencies,
    dependencies_corrupt: parsedDependencies.corrupt,
    cancel_requested_at: stringOrNull(data.cancel_requested_at),
    replaced_by: stringOrNull(data.replaced_by),
    deadline_at: typeof data.deadline_at === 'string' ? data.deadline_at : '',
    created_at: typeof data.created_at === 'string' ? data.created_at : '',
    updated_at: typeof data.updated_at === 'string' ? data.updated_at : '',
    terminal_at: stringOrNull(data.terminal_at),
  };
}

/** 行级三态：缺失 / 行存在但不可读 / 可读；行存在但不可读不得当作 missing */
export type YayaRunStoredRow =
  | { kind: 'missing' }
  | { kind: 'unreadable'; run_id: string }
  | { kind: 'ok'; run: YayaRunRecord };

function toStoredRow(data: unknown): YayaRunStoredRow {
  const run = parseYayaRunRecord(data);
  if (run !== null) return { kind: 'ok', run };
  const runId = isRecord(data) && typeof data.id === 'string' && data.id.length > 0 ? data.id : null;
  return runId === null ? { kind: 'missing' } : { kind: 'unreadable', run_id: runId };
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
  const stored = await loadYayaRunStoredRow(runId);
  return stored.kind === 'ok' ? stored.run : null;
}

export async function loadYayaRunStoredRow(runId: string): Promise<YayaRunStoredRow> {
  const row = await queryOne<{ data: unknown }>(
    `SELECT ${RUN_SELECT} FROM yaya_runs r WHERE r.id = $1`,
    [runId],
  );
  return row === null ? { kind: 'missing' } : toStoredRow(row.data);
}

export async function findYayaRunByClientRequest(
  ownerAccountId: string,
  conversationId: string,
  clientRequestId: string,
): Promise<YayaRunRecord | null> {
  const stored = await findYayaRunStoredRowByClientRequest(
    ownerAccountId,
    conversationId,
    clientRequestId,
  );
  return stored.kind === 'ok' ? stored.run : null;
}

export async function findYayaRunStoredRowByClientRequest(
  ownerAccountId: string,
  conversationId: string,
  clientRequestId: string,
): Promise<YayaRunStoredRow> {
  const row = await queryOne<{ data: unknown }>(
    `SELECT ${RUN_SELECT} FROM yaya_runs r
      WHERE r.owner_account_id = $1 AND r.conversation_id = $2 AND r.client_request_id = $3`,
    [ownerAccountId, conversationId, clientRequestId],
  );
  return row === null ? { kind: 'missing' } : toStoredRow(row.data);
}

/** 依赖唯一键：同一引用/图片/历史片段/投影要求只保留一份（只增不覆盖） */
export function yayaRunDependencyKey(dependency: YayaRunDependency): string {
  return JSON.stringify(dependency);
}

export interface YayaRunDependenciesAppendResult {
  dependencies: YayaRunDependency[];
  /** 持久化依赖已损坏/缺快照：不覆盖写入，调用方必须保守停止 */
  corrupt: boolean;
}

/**
 * 按 run 累积重核依赖：读当前值、合并去重后整写；只增不覆盖。
 * 每个 run 只有唯一派发者写这一列，先读后写即可；查询路径不写。
 * 当前存储若已损坏，绝不“修复式”覆盖抹掉损坏证据。
 */
export async function appendYayaRunDependencies(
  runId: string,
  additions: readonly YayaRunDependency[],
): Promise<YayaRunDependenciesAppendResult> {
  const current = await queryOne<{ dependencies: unknown; state: string }>(
    'SELECT dependencies, state FROM yaya_runs WHERE id = $1',
    [runId],
  );
  if (current === null) return { dependencies: [], corrupt: false };
  const existing = parseStoredDependencies(current.dependencies);
  if (existing.corrupt) return { dependencies: [], corrupt: true };
  const merged: YayaRunDependency[] = [...existing.dependencies];
  const seen = new Set(merged.map((entry) => yayaRunDependencyKey(entry)));
  let fresh = 0;
  for (const addition of additions) {
    const key = yayaRunDependencyKey(addition);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(addition);
    fresh += 1;
  }
  if (fresh > 0 && current.state === 'active') {
    await query(
      `UPDATE yaya_runs SET dependencies = $2::jsonb, updated_at = now()
        WHERE id = $1 AND state = 'active'`,
      [runId, JSON.stringify(merged)],
    );
  }
  return { dependencies: merged, corrupt: false };
}

const CANCELLED_OUTCOME = { kind: 'stopped', reason: 'cancelled', detail: null } as const;
const REPLACED_OUTCOME = { kind: 'stopped', reason: 'run_replaced', detail: null } as const;
const DEADLINE_OUTCOME = { kind: 'stopped', reason: 'deadline', detail: null } as const;

export interface YayaRunFinalizeOptions {
  /**
   * run 行锁之前的身份阶段（同一 TransactionClient）：
   * 账号/会话取共享行锁并重核当前身份；返回非空停止候选时按该停止落账
   * （取消/替换/到期仍优先）。
   */
  verify?: (client: TransactionClient) => Promise<unknown | null>;
  /**
   * run 行锁**等待完成后**的来源阶段（同一 TransactionClient）：
   * 以锁后的当前事实重核已装载来源/历史/图片投影；返回非空停止候选时按该停止落账。
   */
  verifyProjections?: (client: TransactionClient) => Promise<unknown | null>;
}

/**
 * 终态落库（最后保存边界）：
 * 1. 身份阶段（可选 `verify`）：账号/会话共享锁 + 身份重核；
 * 2. `SELECT ... FOR UPDATE` 取得 run 行锁（如被占用则等待，锁序为 账号/会话 → run）；
 * 3. 来源阶段（可选 `verifyProjections`）：按锁等待后的当前事实重核已装载投影；
 * 4. 条件更新：`state='active' AND owner_instance=$` + 取消/替换/到期裁决；
 *    deadline 与 terminal_at 使用 `clock_timestamp()`（实际裁决时刻，不掩盖锁等待）；
 * 5. 行已被外部终态化时返回其已存终态，否则返回 null（不得当作当前结果发布）。
 */
export async function finalizeYayaRun(
  runId: string,
  ownerInstance: string,
  outcome: unknown,
  options: YayaRunFinalizeOptions = {},
): Promise<YayaRunRecord | null> {
  return withTransaction(async (client) => {
    let candidate = outcome;
    if (options.verify !== undefined) {
      const forced = await options.verify(client);
      if (forced !== null && forced !== undefined) candidate = forced;
    }
    const locked = await client.query<{ data: unknown }>(
      `SELECT ${RUN_SELECT} FROM yaya_runs r WHERE r.id = $1 FOR UPDATE`,
      [runId],
    );
    if (!locked.rows[0]) return null;
    const current = parseYayaRunRecord(locked.rows[0].data);
    if (current === null) return null;
    if (current.state !== 'active' || current.owner_instance !== ownerInstance) {
      return current.state === 'terminal' ? current : null;
    }
    if (options.verifyProjections !== undefined) {
      const forced = await options.verifyProjections(client);
      if (forced !== null && forced !== undefined) candidate = forced;
    }
    const updated = await client.query<{ data: unknown }>(
      `UPDATE yaya_runs
          SET state = 'terminal',
              outcome = CASE
                WHEN yaya_runs.cancel_requested_at IS NOT NULL THEN $3::jsonb
                WHEN yaya_runs.replaced_by IS NOT NULL THEN $4::jsonb
                WHEN yaya_runs.deadline_at <= clock_timestamp() THEN $5::jsonb
                ELSE $6::jsonb
              END,
              terminal_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE yaya_runs.id = $1 AND yaya_runs.state = 'active' AND yaya_runs.owner_instance = $2
        RETURNING ${RUN_RETURNING}`,
      [
        runId,
        ownerInstance,
        JSON.stringify(CANCELLED_OUTCOME),
        JSON.stringify(REPLACED_OUTCOME),
        JSON.stringify(DEADLINE_OUTCOME),
        JSON.stringify(candidate ?? null),
      ],
    );
    return updated.rows[0] ? parseYayaRunRecord(updated.rows[0].data) : null;
  });
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
  // 期限必须在取得行锁之后按实际当前时刻判定（锁等待可能跨过 deadline）。
  const deadline = await client.query<{ expired: boolean }>(
    'SELECT deadline_at <= clock_timestamp() AS expired FROM yaya_runs WHERE id = $1',
    [runId],
  );
  if (deadline.rows[0]?.expired === true) {
    throw new YayaRunInactiveError('运行已超过时间上限，拒绝保存迟到结果。');
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
