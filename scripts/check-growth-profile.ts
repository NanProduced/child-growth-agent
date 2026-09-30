import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { requireTeacher } from '../src/lib/auth';
import {
  buildGrowthProfileMessages,
  generateGrowthProfile,
} from '../src/lib/ai';
import {
  buildGrowthProfileFallback,
  updateGrowthProfileAfterConfirmation,
  updateGrowthProfileSafely,
} from '../src/lib/growth-profile';
import type { LlmResult } from '../src/lib/llm';
import type {
  Child,
  GrowthProfileDraft,
  Observation,
  ObservationDraft,
  ObservationStatus,
} from '../src/lib/types';
import { growthProfileSchema } from '../src/lib/validation';

const CONFIRMED_CONTENT: ObservationDraft = {
  domain: '科学',
  sub_domain: '科学观察',
  objective_description: '幼儿在搭建中尝试调整支撑位置。',
  highlights: ['把两块积木并排放在下面当桥墩。'],
  support_suggestions: ['提供不同长度的积木继续观察。'],
  highlight_quote: '这次桥不会塌了。',
};

const PROFILE: GrowthProfileDraft = {
  summary: '已确认的观察显示，幼儿会在搭建过程中尝试调整材料位置。',
  recent_change: '最近一次观察中，幼儿主动增加支撑并再次尝试。',
  development_clues: ['发现桥面变化后调整支撑位置。'],
  next_support: '提供不同长度的积木，邀请幼儿说说每次调整的原因。',
  next_focus: '下一次可以继续看看幼儿是否会主动比较不同支撑方式。',
};

function observation(
  id: string,
  status: ObservationStatus,
  confirmedContent: ObservationDraft | null,
): Observation {
  return {
    id,
    child_id: 'child-1',
    observed_at: '2026-09-25',
    context: '建构区',
    raw_text: status === 'confirmed' ? `已确认原文 ${id}` : `未确认原文 ${id}`,
    status,
    agent_context: null,
    ai_draft: status === 'confirmed' ? { ...CONFIRMED_CONTENT, objective_description: `AI 草稿 ${id}` } : null,
    ai_model: 'offline-model',
    ai_organized_at: '2026-09-25T10:00:00.000Z',
    confirmed_content: confirmedContent,
    confirmed_at: status === 'confirmed' ? '2026-09-25T11:00:00.000Z' : null,
    is_demo: true,
    created_at: '2026-09-25T09:00:00.000Z',
    updated_at: null,
  };
}

const confirmed = observation('confirmed-1', 'confirmed', CONFIRMED_CONTENT);
const mixedObservations = [
  confirmed,
  observation('draft-1', 'draft', null),
  observation('needs-input-1', 'needs_input', null),
  observation('ai-organized-1', 'ai_organized', CONFIRMED_CONTENT),
];

const child: Child = {
  id: 'child-1',
  name: '测试幼儿',
  gender: '女',
  birth_date: '2022-01-01',
  class_name: '向日葵班',
  avatar_emoji: '🌱',
  note: null,
  growth_profile: null,
  is_demo: true,
  created_at: '2026-09-25T09:00:00.000Z',
  updated_at: null,
};

function reply(content: string): LlmResult {
  return { content, provider: 'stepfun', model: 'offline-profile-model' };
}

async function main(): Promise<void> {
  let passed = 0;

  // 1) 只有 confirmed 记录进入 profile Agent；其他三种状态与 AI 草稿不会进入输入。
  const messages = buildGrowthProfileMessages({
    childName: child.name,
    childGender: child.gender,
    observations: mixedObservations,
  });
  const userMessage = messages[1].content;
  assert.ok(userMessage.includes('confirmed-1'));
  assert.ok(userMessage.includes('已确认原文 confirmed-1'));
  assert.ok(!userMessage.includes('draft-1'));
  assert.ok(!userMessage.includes('needs-input-1'));
  assert.ok(!userMessage.includes('ai-organized-1'));
  assert.ok(!userMessage.includes('AI 草稿 confirmed-1'));
  passed += 1;

  // 2) 合法 profile 输出通过最终 Zod schema，且使用增长档案 response type。
  let responseType = '';
  const generated = await generateGrowthProfile(
    { childName: child.name, childGender: child.gender, observations: mixedObservations },
    async (_request, options) => {
      responseType = options?.responseType ?? '';
      return reply(JSON.stringify(PROFILE));
    },
  );
  assert.equal(responseType, 'growth_profile');
  assert.equal(growthProfileSchema.safeParse(generated.profile).success, true);
  passed += 1;

  // 3) 诊断、评分或排名词进入输出时被内容校验拦截，而不是静默保存。
  let forbiddenCalls = 0;
  await assert.rejects(
    generateGrowthProfile(
      { childName: child.name, childGender: child.gender, observations: [confirmed] },
      async () => {
        forbiddenCalls += 1;
        return reply(JSON.stringify({ ...PROFILE, summary: '不能进行诊断、评分或排名。' }));
      },
    ),
    (error: Error) => error.message.includes('不允许的定性词'),
  );
  assert.equal(forbiddenCalls, 2);
  passed += 1;

  // 4) source_observation_ids 由服务端生成，raw_text / ai_draft / confirmed_content 不被改写。
  const rawSnapshot = JSON.stringify({
    raw_text: confirmed.raw_text,
    ai_draft: confirmed.ai_draft,
    confirmed_content: confirmed.confirmed_content,
  });
  let savedSourceIds: string[] = [];
  const saved = await updateGrowthProfileAfterConfirmation(child, mixedObservations, {
    invoke: async () => reply(JSON.stringify(PROFILE)),
    save: async (_childId, profile) => {
      savedSourceIds = profile.source_observation_ids;
      return { ...child, growth_profile: profile };
    },
  });
  assert.deepEqual(saved.source_observation_ids, ['confirmed-1']);
  assert.deepEqual(savedSourceIds, ['confirmed-1']);
  assert.equal(
    JSON.stringify({
      raw_text: confirmed.raw_text,
      ai_draft: confirmed.ai_draft,
      confirmed_content: confirmed.confirmed_content,
    }),
    rawSnapshot,
  );
  passed += 1;

  // 5) profile 保存失败只返回 failed，已经确认的观察仍保持 confirmed。
  const failedUpdate = await updateGrowthProfileSafely(child, [confirmed], {
    invoke: async () => reply(JSON.stringify(PROFILE)),
    save: async () => {
      throw new Error('offline save failure');
    },
  });
  assert.equal(failedUpdate.status, 'failed');
  assert.equal(confirmed.status, 'confirmed');
  passed += 1;

  // 6) 没有保存 profile 时，页面 fallback 只读取 confirmed 观察。
  const fallback = buildGrowthProfileFallback(mixedObservations);
  assert.ok(fallback);
  assert.ok(fallback.summary.includes('幼儿'));
  assert.ok(!fallback.summary.includes('未确认原文'));
  passed += 1;

  // 7) SQL 脚本包含幂等升级与演示 profile 清空。
  const upgradeSql = readFileSync(new URL('../scripts/upgrade-growth-profile.sql', import.meta.url), 'utf8');
  const resetSql = readFileSync(new URL('../scripts/demo-reset.sql', import.meta.url), 'utf8');
  assert.ok(upgradeSql.includes('ADD COLUMN IF NOT EXISTS growth_profile jsonb'));
  assert.ok(resetSql.includes('growth_profile = null'));
  passed += 1;

  // 8) 未登录写请求仍为 401。
  const previousPasscode = process.env.TEACHER_PASSCODE;
  try {
    process.env.TEACHER_PASSCODE = 'offline-test-passcode';
    assert.equal(requireTeacher(new Request('http://localhost/api/observations'))?.status, 401);
  } finally {
    if (previousPasscode === undefined) delete process.env.TEACHER_PASSCODE;
    else process.env.TEACHER_PASSCODE = previousPasscode;
  }
  passed += 1;

  // 9) 未配置教师口令仍为 503。
  const previousMissingCheckPasscode = process.env.TEACHER_PASSCODE;
  try {
    delete process.env.TEACHER_PASSCODE;
    assert.equal(requireTeacher(new Request('http://localhost/api/observations'))?.status, 503);
  } finally {
    if (previousMissingCheckPasscode === undefined) delete process.env.TEACHER_PASSCODE;
    else process.env.TEACHER_PASSCODE = previousMissingCheckPasscode;
  }
  passed += 1;

  console.log(JSON.stringify({ passed, total: 9 }));
}

void main();
