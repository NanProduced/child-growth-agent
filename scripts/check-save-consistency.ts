import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Child, Observation } from '../src/lib/types';
import type { LlmMessage, LlmOptions, LlmResult } from '../src/lib/llm';

/**
 * 保存一致性检查（离线）：
 * 1) 语句级检查：实际 UPDATE 语句必须在 SQL 处保护 confirmed 状态、只合并自身 JSONB 键；
 * 2) 时序模拟：迟到的整理/追问写入遇到保护时，错误必须向上抛出，不能被吞掉。
 * 说明：这里没有连接托管数据库，SQL 原子性只做了语句与模拟时序验证。
 */

function functionBody(rawSource: string, name: string): string {
  const source = rawSource.replace(/\r\n/g, '\n');
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `未找到 ${name}`);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, `未找到 ${name} 函数结尾`);
  return source.slice(start, end);
}

function checkStatements(): number {
  const source = readFileSync(new URL('../src/lib/queries.ts', import.meta.url), 'utf8');
  let passed = 0;

  const draftBody = functionBody(source, 'updateObservationAiDraft');
  assert.ok(
    draftBody.includes("AND status <> 'confirmed'"),
    'AI 整理写入必须在 SQL 处保护 confirmed 状态',
  );
  passed += 1;

  const contextBody = functionBody(source, 'updateObservationAgentContext');
  assert.ok(
    contextBody.includes("AND status <> 'confirmed'"),
    '追问上下文写入必须在 SQL 处保护 confirmed 状态',
  );
  passed += 1;

  const activityBody = functionBody(source, 'updateChildActivitySupport');
  assert.ok(activityBody.includes("'{activity_support}'"), '活动支持只更新自身键');
  assert.ok(activityBody.includes('jsonb_set('), '活动支持使用 JSONB 定向合并');
  assert.ok(activityBody.includes('coalesce(growth_profile'), '仅在档案为空时使用 fallback 底座');
  passed += 1;

  const summaryBody = functionBody(source, 'updateChildGrowthProfileSummary');
  assert.ok(summaryBody.includes("- 'is_fallback'"), 'AI 小结写入应清除回退标记');
  assert.ok(summaryBody.includes('|| $2::jsonb'), '小结使用 JSONB 合并而非整体替换');
  const summarySql = summaryBody.slice(
    summaryBody.indexOf('`'),
    summaryBody.lastIndexOf('`') + 1,
  );
  assert.ok(!summarySql.includes('activity_support'), '小结 SQL 不得写入 activity_support');
  assert.ok(
    summaryBody.includes('delete fields.activity_support'),
    '小结保存前应剔除 activity_support 字段',
  );
  passed += 1;

  assert.ok(
    !source.includes('export async function updateChildGrowthProfile('),
    '不应保留整体替换 growth_profile 的旧函数',
  );
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

function reply(content: string): LlmResult {
  return { content, provider: 'stepfun', model: 'offline-save-model' };
}

type ModuleMock = {
  module: (specifier: string, options: { exports: Record<string, unknown> }) => void;
};

async function simulateLateWrites(): Promise<number> {
  const { mock } = await import('node:test');
  const mockModule = mock as unknown as ModuleMock;
  let draftSaveCalls = 0;
  let contextSaveCalls = 0;
  mockModule.module('@/lib/queries', {
    exports: {
      updateObservationAiDraft: async () => {
        draftSaveCalls += 1;
        throw new Error('该记录已由教师确认归档，迟到的 AI 整理结果不会覆盖确认稿');
      },
      updateObservationAgentContext: async () => {
        contextSaveCalls += 1;
        throw new Error('该记录已由教师确认归档，迟到的补充信息不会改写已确认记录');
      },
    },
  });

  const { processObservationAgent } = await import('@/lib/observation-agent');
  let passed = 0;

  const validDraft = {
    domain: '科学',
    sub_domain: '科学探究',
    objective_description: '幼儿在搭建中尝试让结构保持稳定。',
    highlights: ['把三块长积木并排搭成小桥。'],
    support_suggestions: ['提供不同长度的积木继续探索。'],
    highlight_quote: '桥没有倒',
  };
  const invoke = async (
    _messages: LlmMessage[],
    options: LlmOptions = {},
  ): Promise<LlmResult> => {
    if (options.responseType === 'follow_up_decision') {
      return reply(
        JSON.stringify({ decision: 'proceed', question: '', reason: '现有证据已经足够。' }),
      );
    }
    return reply(JSON.stringify(validDraft));
  };

  // 迟到的整理写入：保护触发时错误必须抛出，不能静默成功
  await assert.rejects(
    processObservationAgent({
      observation: makeObservation({ status: 'ai_organized' }),
      child: makeChild(),
      invoke,
    }),
    (error: Error) => error.message.includes('迟到的 AI 整理结果'),
  );
  assert.equal(draftSaveCalls, 1);
  passed += 1;

  // 迟到的追问写入：保护触发时错误必须抛出，不能把已确认记录降级
  await assert.rejects(
    processObservationAgent({
      observation: makeObservation({
        status: 'needs_input',
        agent_context: {
          follow_up: { round: 1, question: '幼儿当时说了什么？', reason: '需要原话。', answers: [], stopped: false },
        },
      }),
      child: makeChild(),
      invoke: async () =>
        reply(
          JSON.stringify({ decision: 'ask', question: '当时教师怎样支持？', reason: '需要支持行为。' }),
        ),
    }),
    (error: Error) => error.message.includes('迟到的补充信息'),
  );
  assert.equal(contextSaveCalls, 1);
  passed += 1;

  return passed;
}

async function main(): Promise<void> {
  if (process.argv[2] === 'simulate') {
    const passed = await simulateLateWrites();
    console.log(`ok simulate-late-writes (${passed})`);
    return;
  }

  const statementPassed = checkStatements();
  console.log(`ok update-statements (${statementPassed})`);

  const scriptPath = fileURLToPath(import.meta.url);
  const result = spawnSync(
    process.execPath,
    ['--experimental-test-module-mocks', '--no-warnings', '--import', 'tsx', scriptPath, 'simulate'],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error('迟到时序模拟失败');
  }
  console.log(JSON.stringify({ passed: statementPassed + 2, total: statementPassed + 2 }));
}

void main();
