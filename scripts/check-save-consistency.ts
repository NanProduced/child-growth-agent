import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ObservationStateConflictError, StaleEvidenceError } from '../src/lib/evidence-snapshot';
import type { AgentContext, Child, Observation, ObservationDraft } from '../src/lib/types';
import type { LlmMessage, LlmOptions, LlmResult } from '../src/lib/llm';

/**
 * 保存一致性检查（离线）：
 * 1) 语句级检查：UPDATE 必须在 SQL 处保护状态/上下文，保存层必须同一 client 事务内先锁儿童行再重读证据；
 * 2) withTransaction：BEGIN/COMMIT/ROLLBACK/release 顺序与错误传播；
 * 3) 时序模拟（Tail A）：迟到追问/整理结果遇到状态或上下文冲突必须抛出，不能写入；
 * 4) 时序模拟（Tail B）：锁后重读证据、冲突拒绝、正常保存、确认路径与模型调用在事务外的顺序。
 * 说明：没有连接托管数据库；实库并发（NOT_RUN）未验证，以上为语句、helper 与模拟时序检查。
 */

type ModuleMock = {
  module: (specifier: string, options: { exports: Record<string, unknown> }) => void;
};

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function functionBody(rawSource: string, name: string): string {
  const source = rawSource.replace(/\r\n/g, '\n');
  const exported = source.indexOf(`export async function ${name}(`);
  const plain = source.indexOf(`function ${name}(`);
  const start = exported >= 0 ? exported : plain;
  assert.ok(start >= 0, `未找到 ${name}`);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, `未找到 ${name} 函数结尾`);
  return source.slice(start, end);
}

function checkStatements(): number {
  const source = readFileSync(new URL('../src/lib/queries.ts', import.meta.url), 'utf8');
  const pgClientSource = readFileSync(
    new URL('../src/storage/database/pg-client.ts', import.meta.url),
    'utf8',
  );
  let passed = 0;

  const guardBody = functionBody(source, 'observationWriteConditions');
  assert.ok(guardBody.includes('expectedStatus'), '写入保护必须比较原状态');
  assert.ok(
    guardBody.includes('expectedAgentContext') &&
      guardBody.includes('agent_context IS NOT DISTINCT FROM'),
    '写入保护必须比较原 agent_context JSONB',
  );
  assert.ok(
    guardBody.includes('expectedAiDraft') && guardBody.includes('ai_draft IS NOT DISTINCT FROM'),
    '写入保护必须比较原 ai_draft，防止迟到草稿覆盖较新草稿',
  );
  passed += 1;

  const draftBody = functionBody(source, 'updateObservationAiDraft');
  assert.ok(draftBody.includes("status <> 'confirmed'"), 'AI 整理写入必须保护 confirmed 状态');
  assert.ok(
    draftBody.includes('observationWriteConditions(guard, params)'),
    'AI 整理写入必须应用原状态/上下文/草稿快照',
  );
  passed += 1;

  const contextBody = functionBody(source, 'updateObservationAgentContext');
  assert.ok(contextBody.includes('observationWriteConditions(guard, params)'), '追问上下文写入必须应用原快照');
  assert.ok(contextBody.includes('ObservationStateConflictError'), '冲突必须抛出状态冲突错误');
  passed += 1;

  const evidenceBody = functionBody(source, 'confirmedEvidenceMatches');
  assert.ok(evidenceBody.includes("o.status = 'confirmed'"), '原子条件必须比较已确认观察');
  assert.ok(evidenceBody.includes('jsonb_agg'), '原子条件必须按 id 集合比较而非时间戳');
  passed += 1;

  const lockBody = functionBody(source, 'lockChild');
  assert.ok(
    lockBody.includes('children WHERE id = $1 FOR UPDATE'),
    '儿童锁必须锁定同一 children 行（不同儿童互不阻塞）',
  );
  const readEvidenceBody = functionBody(source, 'readConfirmedEvidenceIds');
  assert.ok(
    readEvidenceBody.includes("o.status = 'confirmed'") &&
      readEvidenceBody.includes('jsonb_agg'),
    '取得锁后重读的必须是已确认观察 id 集合',
  );
  passed += 1;

  for (const name of ['updateChildGrowthProfileSummary', 'updateChildActivitySupport']) {
    const body = functionBody(source, name);
    assert.ok(body.includes('withTransaction('), `${name} 必须使用同一 client 的短事务`);
    assert.ok(body.includes('lockChild(client'), `${name} 必须锁定儿童行`);
    assert.ok(body.includes('client.query'), `${name} 事务内必须使用同一 client，不得走全局 Pool`);
    assert.ok(
      body.indexOf('lockChild(client') < body.indexOf('readConfirmedEvidenceIds(client'),
      `${name} 必须先取得锁，再重读已确认证据集合`,
    );
    assert.ok(body.includes('confirmedEvidenceMatches'), `${name} 保留 SQL 证据比较作为补充`);
  }
  passed += 1;

  const confirmBody = functionBody(source, 'confirmObservation');
  assert.ok(confirmBody.includes('withTransaction('), '确认必须与其他保存共享同一儿童锁事务');
  assert.ok(
    confirmBody.indexOf('lockChild(client') >= 0 &&
      confirmBody.indexOf('lockChild(client') < confirmBody.indexOf('FROM observations'),
    '确认必须先锁定儿童行，再读取/更新观察',
  );
  assert.ok(
    confirmBody.includes('ObservationStateConflictError'),
    '确认前提不匹配必须抛出状态冲突',
  );
  assert.ok(confirmBody.includes("status = 'confirmed'"), '确认必须写入 confirmed 状态');
  passed += 1;

  assert.ok(pgClientSource.includes('ROLLBACK'), 'withTransaction 必须覆盖回滚');
  assert.ok(pgClientSource.includes('client.release()'), 'withTransaction 必须在 finally 释放 client');
  assert.ok(
    pgClientSource.includes('BEGIN') && pgClientSource.includes('COMMIT'),
    'withTransaction 必须使用同一 client 完成 BEGIN/COMMIT',
  );
  passed += 1;

  assert.ok(
    !source.includes('export async function updateChildGrowthProfile('),
    '不应保留整体替换 growth_profile 的旧函数',
  );
  passed += 1;

  return passed;
}

async function checkTransactionHelper(): Promise<number> {
  const { withTransaction } = await import('../src/storage/database/pg-client');
  let passed = 0;

  const successEvents: string[] = [];
  const successClient = {
    query: async (sql: string) => {
      successEvents.push(sql);
      return { rows: [], rowCount: 0 };
    },
    release: () => {
      successEvents.push('release');
    },
  };
  const value = await withTransaction(
    async (client) => {
      successEvents.push('work');
      await client.query('SELECT 1');
      return 'done';
    },
    async () => successClient as never,
  );
  assert.equal(value, 'done');
  assert.deepEqual(successEvents, ['BEGIN', 'work', 'SELECT 1', 'COMMIT', 'release']);
  passed += 1;

  const failEvents: string[] = [];
  const failClient = {
    query: async (sql: string) => {
      failEvents.push(sql);
      return { rows: [], rowCount: 0 };
    },
    release: () => {
      failEvents.push('release');
    },
  };
  await assert.rejects(
    withTransaction(
      async () => {
        failEvents.push('work');
        throw new Error('模拟保存失败');
      },
      async () => failClient as never,
    ),
    /模拟保存失败/,
  );
  assert.deepEqual(failEvents, ['BEGIN', 'work', 'ROLLBACK', 'release']);
  passed += 1;

  return passed;
}

function makeChild(): Child {
  return {
    id: 'child-1',
    name: '测试幼儿',
    gender: '女',
    birth_date: '2022-01-01',
    class_name: '向日葵班',
    class_id: 'class-1',
    current_class: null,
    class_stage: 'middle',
    class_school_year: '2026-2027',
    avatar_emoji: null,
    note: null,
    growth_profile: null,
    is_demo: true,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: null,
  };
}

function makeObservation(overrides: Partial<Observation>): Observation {
  return {
    id: 'obs-1',
    child_id: 'child-1',
    class_id: 'class-1',
    observed_class: null,
    observed_at: '2026-09-20',
    context: '建构区',
    raw_text: '幼儿在建构区把三块长积木并排搭成小桥，桥没有倒。',
    status: 'draft',
    agent_context: null,
    ai_draft: null,
    ai_model: null,
    ai_organized_at: null,
    confirmed_content: null,
    confirmed_at: null,
    is_demo: true,
    created_at: '2026-09-20T00:00:00.000Z',
    updated_at: null,
    ...overrides,
  };
}

function makeDraft(label: string): ObservationDraft {
  return {
    domain: '科学',
    sub_domain: '科学探究',
    objective_description: label,
    highlights: [`${label} 的亮点`],
    support_suggestions: ['继续提供材料。'],
    highlight_quote: '桥没有倒',
  };
}

function reply(content: string): LlmResult {
  return { content, provider: 'stepfun', model: 'offline-save-model' };
}

function answeredContext(content: string): AgentContext {
  return {
    follow_up: {
      round: 1,
      question: '是独立完成还是教师帮忙？',
      reason: '需要知道完成方式。',
      answers: [{ action: 'answer', content, created_at: '2026-09-01T00:00:00.000Z' }],
      rounds: [
        {
          round: 1,
          question: '是独立完成还是教师帮忙？',
          reason: '需要知道完成方式。',
          answer: { action: 'answer', content, created_at: '2026-09-01T00:00:00.000Z' },
        },
      ],
      stopped: false,
    },
  };
}

type ObservationDb = {
  status: Observation['status'];
  agentContext: AgentContext | null;
  aiDraft: ObservationDraft | null;
};

type ObservationWriteGuard = {
  expectedStatus?: Observation['status'];
  expectedAgentContext?: AgentContext | null;
  expectedAiDraft?: ObservationDraft | null;
};

/** Tail A：迟到异步写入必须携带完整服务端快照；模拟 DB 按 guard 语义判定冲突 */
async function simulateObservationWrites(): Promise<number> {
  const { mock } = await import('node:test');
  const mockModule = mock as unknown as ModuleMock;

  const db: ObservationDb = { status: 'draft', agentContext: null, aiDraft: null };
  const snapshot = (): ObservationDb => db;
  let rejectedWrites = 0;

  const guardMatches = (guard: ObservationWriteGuard | undefined): boolean => {
    if (
      !guard ||
      guard.expectedStatus === undefined ||
      guard.expectedAgentContext === undefined ||
      guard.expectedAiDraft === undefined
    ) {
      return false;
    }
    return (
      guard.expectedStatus === db.status &&
      canonicalJson(guard.expectedAgentContext) === canonicalJson(db.agentContext) &&
      canonicalJson(guard.expectedAiDraft) === canonicalJson(db.aiDraft)
    );
  };

  mockModule.module('@/lib/queries', {
    exports: {
      updateObservationAgentContext: async (
        _id: string,
        context: AgentContext,
        status: Observation['status'],
        guard?: ObservationWriteGuard,
      ) => {
        if (!guardMatches(guard)) {
          rejectedWrites += 1;
          throw new ObservationStateConflictError('记录在核对后已被更新，迟到的补充不会被写入');
        }
        db.status = status;
        db.agentContext = context;
        return makeObservation({ status, agent_context: context });
      },
      updateObservationAiDraft: async (
        _id: string,
        draft: ObservationDraft,
        _model: string,
        guard?: ObservationWriteGuard,
      ) => {
        if (!guardMatches(guard)) {
          rejectedWrites += 1;
          throw new ObservationStateConflictError('记录在核对后已被更新，迟到的 AI 整理结果不会被写入');
        }
        db.status = 'ai_organized';
        db.aiDraft = draft;
        return makeObservation({ status: 'ai_organized', ai_draft: draft });
      },
    },
  });

  const { processObservationAgent } = await import('@/lib/observation-agent');
  let passed = 0;

  const validDraft: ObservationDraft = {
    domain: '科学',
    sub_domain: '科学探究',
    objective_description: '幼儿在搭建中尝试让结构保持稳定。',
    highlights: ['把三块长积木并排搭成小桥。'],
    support_suggestions: ['提供不同长度的积木继续探索。'],
    highlight_quote: '桥没有倒',
  };
  const askInvoke = async (
    _messages: LlmMessage[],
    options: LlmOptions = {},
  ): Promise<LlmResult> => {
    if (options.responseType === 'follow_up_decision') {
      return reply(
        JSON.stringify({ decision: 'ask', question: '当时教师怎样支持？', reason: '需要支持行为。' }),
      );
    }
    return reply(JSON.stringify(validDraft));
  };
  const proceedInvoke = async (
    _messages: LlmMessage[],
    options: LlmOptions = {},
  ): Promise<LlmResult> => {
    if (options.responseType === 'follow_up_decision') {
      return reply(JSON.stringify({ decision: 'proceed', question: '', reason: '现有证据已经足够。' }));
    }
    return reply(JSON.stringify(validDraft));
  };

  // 1) A 等待判断，B stop 并整理完成，A 返回 ask：仍为 ai_organized，stop 保留，A 冲突
  const verboseContext = answeredContext('是独立完成。');
  const stoppedContext: AgentContext = {
    follow_up: {
      ...answeredContext('是独立完成。').follow_up!,
      stopped: true,
    },
  };
  db.status = 'ai_organized';
  db.agentContext = stoppedContext;
  db.aiDraft = validDraft;
  await assert.rejects(
    processObservationAgent({
      observation: makeObservation({
        status: 'needs_input',
        agent_context: verboseContext,
        ai_draft: null,
      }),
      child: makeChild(),
      invoke: askInvoke,
    }),
    (error: Error) => error instanceof ObservationStateConflictError,
  );
  assert.equal(db.status, 'ai_organized', '迟到的 ask 不得把记录恢复为 needs_input');
  assert.equal(snapshot().agentContext?.follow_up?.stopped, true, 'stop 标记必须保留');
  passed += 1;

  // 2) 状态仍为 needs_input，但轮次已被另一请求推进：旧写入被拒绝
  const roundOneContext = answeredContext('提醒后');
  const roundTwoContext: AgentContext = {
    follow_up: {
      round: 2,
      question: '教师当时怎么帮忙的？',
      reason: '需要支持行为。',
      answers: roundOneContext.follow_up!.answers,
      rounds: [
        ...roundOneContext.follow_up!.rounds!,
        { round: 2, question: '教师当时怎么帮忙的？', reason: '需要支持行为。', answer: null },
      ],
      stopped: false,
    },
  };
  db.status = 'needs_input';
  db.agentContext = roundTwoContext;
  db.aiDraft = null;
  await assert.rejects(
    processObservationAgent({
      observation: makeObservation({ status: 'needs_input', agent_context: roundOneContext, ai_draft: null }),
      child: makeChild(),
      invoke: askInvoke,
    }),
    (error: Error) => error instanceof ObservationStateConflictError,
  );
  assert.equal(snapshot().agentContext?.follow_up?.round, 2, '轮次不得被旧请求回退');
  passed += 1;

  // 3) 状态相同但教师回答已更正：旧模型结果被拒绝
  const correctedContext = answeredContext('实际是教师帮忙完成。');
  db.status = 'needs_input';
  db.agentContext = correctedContext;
  await assert.rejects(
    processObservationAgent({
      observation: makeObservation({
        status: 'needs_input',
        agent_context: answeredContext('是独立完成。'),
        ai_draft: null,
      }),
      child: makeChild(),
      invoke: askInvoke,
    }),
    (error: Error) => error instanceof ObservationStateConflictError,
  );
  assert.equal(
    snapshot().agentContext?.follow_up?.answers[0]?.content,
    '实际是教师帮忙完成。',
    '更正后的回答不得被旧请求覆盖',
  );
  passed += 1;

  // 4) 较新草稿已保存：迟到草稿不能覆盖
  const newerDraft: ObservationDraft = { ...validDraft, objective_description: '较新的草稿。' };
  db.status = 'ai_organized';
  db.agentContext = null;
  db.aiDraft = newerDraft;
  await assert.rejects(
    processObservationAgent({
      observation: makeObservation({ status: 'ai_organized', agent_context: null, ai_draft: validDraft }),
      child: makeChild(),
      invoke: proceedInvoke,
    }),
    (error: Error) => error instanceof ObservationStateConflictError,
  );
  assert.equal(snapshot().aiDraft?.objective_description, '较新的草稿。', '新草稿不得被旧结果覆盖');
  passed += 1;

  // 5) 正常首次处理：草稿记录 → 保存追问
  db.status = 'draft';
  db.agentContext = null;
  db.aiDraft = null;
  const first = await processObservationAgent({
    observation: makeObservation({ status: 'draft', agent_context: null, ai_draft: null }),
    child: makeChild(),
    invoke: askInvoke,
  });
  assert.equal(first.status, 'needs_input');
  assert.equal(snapshot().agentContext?.follow_up?.round, 1);
  passed += 1;

  // 6) 教师主动重新生成：使用最新读取的快照，允许覆盖旧草稿
  db.status = 'ai_organized';
  db.agentContext = null;
  db.aiDraft = newerDraft;
  const regenerated = await processObservationAgent({
    observation: makeObservation({ status: 'ai_organized', agent_context: null, ai_draft: newerDraft }),
    child: makeChild(),
    invoke: proceedInvoke,
  });
  assert.equal(regenerated.status, 'ai_organized');
  assert.notEqual(snapshot().aiDraft?.objective_description, '较新的草稿。');
  passed += 1;

  // 7) confirmed 保护继续有效：迟到写入抛出冲突
  const beforeConfirmed = db.aiDraft;
  db.status = 'confirmed';
  await assert.rejects(
    processObservationAgent({
      observation: makeObservation({ status: 'ai_organized', agent_context: null, ai_draft: beforeConfirmed }),
      child: makeChild(),
      invoke: proceedInvoke,
    }),
    (error: Error) => error instanceof ObservationStateConflictError,
  );
  assert.equal(db.status, 'confirmed');
  passed += 1;

  assert.ok(rejectedWrites >= 5, '过期写入必须全部被拒绝');
  return passed;
}

type FakeClientQuery = {
  rows: unknown[];
  rowCount: number;
};

/** Tail B：模拟同一 client 的短事务、儿童锁、锁后重读与确认路径 */
async function simulateChildSaves(): Promise<number> {
  const { mock } = await import('node:test');
  const mockModule = mock as unknown as ModuleMock;

  const events: string[] = [];
  const state = {
    confirmedIds: ['obs-1'] as string[],
    observation: {
      status: 'ai_organized',
      agent_context: null as unknown,
      ai_draft: makeDraft('草稿 D1') as unknown,
    },
    onLock: null as null | (() => void),
    updateChildParams: null as null | unknown[],
    updateObservationParams: null as null | unknown[],
    released: false,
    transactionActive: false,
  };

  const fakeClient = {
    query: async (sql: string, params?: unknown[]): Promise<FakeClientQuery> => {
      if (sql.includes('children WHERE id = $1 FOR UPDATE')) {
        events.push('lock-child');
        if (state.onLock) state.onLock();
        return { rows: [{ id: 'child-1' }], rowCount: 1 };
      }
      if (sql.includes('jsonb_agg') && sql.includes('observations') && !sql.startsWith('UPDATE')) {
        events.push('read-evidence');
        return { rows: [{ ids: [...state.confirmedIds] }], rowCount: 1 };
      }
      if (sql.includes('SELECT status, agent_context, ai_draft FROM observations')) {
        events.push('read-observation');
        return { rows: [state.observation], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE children')) {
        events.push('update-child');
        state.updateChildParams = params ?? null;
        const fields = JSON.parse(String(params?.[1] ?? '{}')) as Record<string, unknown>;
        return {
          rows: [
            {
              data: {
                id: 'child-1',
                name: '测试幼儿',
                gender: '女',
                birth_date: '2022-01-01',
                class_name: '向日葵班',
                avatar_emoji: null,
                note: null,
                growth_profile: fields,
                is_demo: true,
                created_at: '2026-09-01T00:00:00.000Z',
                updated_at: null,
              },
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.startsWith('UPDATE observations')) {
        events.push('update-observation');
        state.updateObservationParams = params ?? null;
        state.observation.status = 'confirmed';
        return {
          rows: [
            {
              data: {
                id: 'obs-1',
                child_id: 'child-1',
                class_id: 'class-1',
                observed_at: '2026-09-20',
                context: '建构区',
                raw_text: '桥没有倒。',
                status: 'confirmed',
                agent_context: state.observation.agent_context,
                ai_draft: state.observation.ai_draft,
                ai_model: null,
                ai_organized_at: null,
                confirmed_content: JSON.parse(String(params?.[1] ?? '{}')),
                confirmed_at: '2026-09-30T00:00:00.000Z',
                is_demo: true,
                created_at: '2026-09-20T00:00:00.000Z',
                updated_at: null,
              },
            },
          ],
          rowCount: 1,
        };
      }
      throw new Error(`未预期的 SQL：${sql.slice(0, 80)}`);
    },
    release: () => {
      events.push('release');
      state.released = true;
    },
  };

  mockModule.module('@/storage/database/pg-client', {
    exports: {
      query: async () => [],
      queryOne: async () => null,
      withTransaction: async <T>(fn: (client: typeof fakeClient) => Promise<T>): Promise<T> => {
        events.push('BEGIN');
        state.transactionActive = true;
        try {
          const result = await fn(fakeClient);
          events.push('COMMIT');
          return result;
        } catch (error) {
          events.push('ROLLBACK');
          throw error;
        } finally {
          state.transactionActive = false;
          fakeClient.release();
        }
      },
    },
  });

  const {
    confirmObservation,
    updateChildActivitySupport,
    updateChildGrowthProfileSummary,
  } = await import('@/lib/queries');
  let passed = 0;

  const growthProfile = {
    summary: '小结',
    recent_change: '变化',
    development_clues: ['线索'],
    next_support: '支持',
    next_focus: '关注',
    source_observation_ids: ['obs-1'],
    ai_model: 'offline-model',
    updated_at: '2026-09-30T00:00:00.000Z',
  };

  // 1) 小结保存等待儿童锁期间新增确认：锁后重读看到新集合 → 拒绝且不写
  events.length = 0;
  state.confirmedIds = ['obs-1'];
  state.onLock = () => {
    state.confirmedIds = ['obs-1', 'obs-2'];
  };
  state.updateChildParams = null;
  await assert.rejects(
    updateChildGrowthProfileSummary('child-1', growthProfile, ['obs-1']),
    (error: Error) => error instanceof StaleEvidenceError,
  );
  assert.deepEqual(events, ['BEGIN', 'lock-child', 'read-evidence', 'ROLLBACK', 'release']);
  assert.equal(state.updateChildParams, null, '证据不匹配时不得写 children');
  passed += 1;

  // 2) 活动支持同样检查
  events.length = 0;
  state.confirmedIds = ['obs-1'];
  state.onLock = () => {
    state.confirmedIds = ['obs-1', 'obs-2'];
  };
  state.updateChildParams = null;
  await assert.rejects(
    updateChildActivitySupport(
      'child-1',
      {
        suggestions: [],
        source_observation_ids: ['obs-1'],
        ai_model: 'offline-model',
        generated_at: '2026-09-30T00:00:00.000Z',
      },
      null,
      ['obs-1'],
    ),
    (error: Error) => error instanceof StaleEvidenceError,
  );
  assert.deepEqual(events, ['BEGIN', 'lock-child', 'read-evidence', 'ROLLBACK', 'release']);
  assert.equal(state.updateChildParams, null);
  passed += 1;

  // 3) 证据一致：锁 → 重读 → 定向更新 → 提交
  events.length = 0;
  state.onLock = null;
  state.confirmedIds = ['obs-1'];
  state.updateChildParams = null;
  const saved = await updateChildGrowthProfileSummary('child-1', growthProfile, ['obs-1']);
  assert.deepEqual(events, ['BEGIN', 'lock-child', 'read-evidence', 'update-child', 'COMMIT', 'release']);
  assert.ok(state.updateChildParams, '正常路径必须执行 JSONB 更新');
  assert.equal(saved.id, 'child-1');
  passed += 1;

  // 4) 确认路径：先锁儿童行，再核对/写入观察；前提一致时成功
  events.length = 0;
  state.observation = {
    status: 'ai_organized',
    agent_context: null,
    ai_draft: makeDraft('草稿 D1'),
  };
  state.updateObservationParams = null;
  const confirmed = await confirmObservation('obs-1', 'child-1', makeDraft('教师确认稿'), {
    status: 'ai_organized',
    agentContext: null,
    aiDraft: makeDraft('草稿 D1'),
  });
  assert.deepEqual(events, ['BEGIN', 'lock-child', 'read-observation', 'update-observation', 'COMMIT', 'release']);
  assert.equal(confirmed.status, 'confirmed');
  assert.ok(state.updateObservationParams, '确认必须写入 confirmed_content');
  passed += 1;

  // 5) 确认前提已变化：抛出状态冲突且不写确认稿
  events.length = 0;
  state.observation = {
    status: 'ai_organized',
    agent_context: { follow_up: undefined } as unknown,
    ai_draft: makeDraft('草稿 D2'),
  };
  state.updateObservationParams = null;
  await assert.rejects(
    confirmObservation('obs-1', 'child-1', makeDraft('教师确认稿'), {
      status: 'ai_organized',
      agentContext: null,
      aiDraft: makeDraft('草稿 D1'),
    }),
    (error: Error) => error instanceof ObservationStateConflictError,
  );
  assert.deepEqual(events, ['BEGIN', 'lock-child', 'read-observation', 'ROLLBACK', 'release']);
  assert.equal(state.updateObservationParams, null, '前提变化时不得写确认稿');
  passed += 1;

  // 6) 模型调用发生在事务之外
  events.length = 0;
  state.observation = {
    status: 'ai_organized',
    agent_context: null,
    ai_draft: makeDraft('草稿 D1'),
  };
  state.confirmedIds = ['obs-1'];
  const { updateGrowthProfileAfterConfirmation } = await import('@/lib/growth-profile');
  const profileReply = JSON.stringify({
    summary: '小结',
    recent_change: '变化',
    development_clues: ['线索'],
    next_support: '支持',
    next_focus: '关注',
  });
  await updateGrowthProfileAfterConfirmation(makeChild(), [makeObservation({ status: 'confirmed', confirmed_content: makeDraft('已确认') })], {
    reloadObservations: async () => [{ ...makeObservation({ status: 'confirmed' }), confirmed_content: { objective_description: '已确认' } } as Observation],
    invoke: async () => {
      assert.equal(state.transactionActive, false, '模型调用不得在事务内');
      events.push('model-call');
      return reply(profileReply);
    },
  });
  const beginIndex = events.indexOf('BEGIN');
  const modelIndex = events.indexOf('model-call');
  assert.ok(modelIndex >= 0 && beginIndex > modelIndex, '必须先完成模型调用，再开事务保存');
  assert.ok(state.released, '保存结束必须释放 client');
  passed += 1;

  return passed;
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === 'simulate-observation') {
    const passed = await simulateObservationWrites();
    console.log(`ok simulate-observation-writes (${passed})`);
    return;
  }
  if (mode === 'simulate-child-saves') {
    const passed = await simulateChildSaves();
    console.log(`ok simulate-child-saves (${passed})`);
    return;
  }

  const statementPassed = checkStatements();
  console.log(`ok update-statements (${statementPassed})`);

  const transactionPassed = await checkTransactionHelper();
  console.log(`ok with-transaction (${transactionPassed})`);

  const scriptPath = fileURLToPath(import.meta.url);
  for (const childMode of ['simulate-observation', 'simulate-child-saves']) {
    const result = spawnSync(
      process.execPath,
      ['--experimental-test-module-mocks', '--no-warnings', '--import', 'tsx', scriptPath, childMode],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) {
      throw new Error(`时序模拟失败：${childMode}`);
    }
  }

  const total = statementPassed + transactionPassed + 13;
  console.log(JSON.stringify({ passed: total, total }));
}

void main();
