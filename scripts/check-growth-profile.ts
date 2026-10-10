import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { requireTeacher } from '../src/lib/auth';
import {
  buildGrowthProfileMessages,
  generateGrowthProfile,
} from '../src/lib/ai';
import {
  StaleEvidenceError,
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
  SchoolClass,
} from '../src/lib/types';
import { growthProfileSchema } from '../src/lib/validation';

const TEST_CLASS: SchoolClass = {
  id: 'class-1',
  name: '向日葵班',
  stage: 'middle',
  school_year: '2026-2027',
  is_active: true,
  is_demo: true,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: null,
};

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
    class_id: TEST_CLASS.id,
    observed_class: TEST_CLASS,
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
  class_name: TEST_CLASS.name,
  class_id: TEST_CLASS.id,
  current_class: TEST_CLASS,
  class_stage: TEST_CLASS.stage,
  class_school_year: TEST_CLASS.school_year,
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
    childBirthDate: child.birth_date,
    observations: mixedObservations,
  });
  const userMessage = messages[1].content;
  assert.ok(userMessage.includes('confirmed-1'));
  assert.ok(userMessage.includes('已确认原文 confirmed-1'));
  assert.ok(userMessage.includes('"age_months":56'));
  assert.ok(userMessage.includes('"stage":"middle"'));
  assert.ok(!userMessage.includes('draft-1'));
  assert.ok(!userMessage.includes('needs-input-1'));
  assert.ok(!userMessage.includes('ai-organized-1'));
  assert.ok(!userMessage.includes('AI 草稿 confirmed-1'));
  passed += 1;

  // 2) 合法 profile 输出通过最终 Zod schema，且使用增长档案 response type。
  let responseType = '';
  const generated = await generateGrowthProfile(
    {
      childName: child.name,
      childGender: child.gender,
      childBirthDate: child.birth_date,
      observations: mixedObservations,
    },
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
      {
        childName: child.name,
        childGender: child.gender,
        childBirthDate: child.birth_date,
        observations: [confirmed],
      },
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
    reloadObservations: async () => mixedObservations,
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
    reloadObservations: async () => [confirmed],
    save: async () => {
      throw new Error('offline save failure');
    },
  });
  assert.equal(failedUpdate.status, 'failed');
  assert.equal(confirmed.status, 'confirmed');
  passed += 1;

  // 5b) 小结更新不携带 activity_support 字段，已有活动支持不会被清掉
  const existingSupport = {
    suggestions: [
      {
        title: '桥墩换一换',
        purpose: '支持幼儿继续观察支撑位置。',
        steps: ['准备长短不同的积木。', '邀请幼儿换一种支撑方式再试一次。'],
        materials: ['长短不同的积木'],
        observe: '继续观察幼儿是否会比较不同支撑方式。',
        adaptation: '如果桥面容易倒，先减少材料数量。',
        evidence: ['科学：把两块积木并排放在下面当桥墩。'],
      },
      {
        title: '说说为什么',
        purpose: '支持幼儿把调整和结果联系起来。',
        steps: ['请幼儿指出这次调整的地方。', '邀请幼儿再试一次。'],
        materials: [],
        observe: '继续观察幼儿是否能用语言说明调整前后的不同。',
        adaptation: '如果幼儿不想表达，教师用复述代替追问。',
        evidence: ['科学：这次桥不会塌了。'],
      },
    ],
    source_observation_ids: ['confirmed-1'],
    ai_model: 'offline-activity-model',
    generated_at: '2026-09-26T00:00:00.000Z',
  };
  const storedProfile = {
    ...PROFILE,
    source_observation_ids: ['confirmed-1'],
    ai_model: 'offline-profile-model',
    updated_at: '2026-09-25T11:00:00.000Z',
    activity_support: existingSupport,
  };
  const childWithSupport = { ...child, growth_profile: storedProfile };
  let savedFields: Record<string, unknown> = {};
  const withSupport = await updateGrowthProfileAfterConfirmation(childWithSupport, [confirmed], {
    invoke: async () => reply(JSON.stringify(PROFILE)),
    reloadObservations: async () => [confirmed],
    save: async (_childId, profile) => {
      savedFields = { ...profile };
      return {
        ...childWithSupport,
        growth_profile: { ...profile, activity_support: existingSupport },
      };
    },
  });
  assert.equal('activity_support' in savedFields, false, '小结保存不得携带 activity_support');
  assert.deepEqual(withSupport.activity_support?.source_observation_ids, ['confirmed-1']);
  passed += 1;

  // 5c) 生成期间新增已确认观察：拒绝写入旧小结并返回可重试状态
  const lateConfirmed = observation('confirmed-2', 'confirmed', CONFIRMED_CONTENT);
  let staleSaveCalls = 0;
  const staleUpdate = await updateGrowthProfileSafely(child, [confirmed], {
    invoke: async () => reply(JSON.stringify(PROFILE)),
    reloadObservations: async () => [confirmed, lateConfirmed],
    save: async () => {
      staleSaveCalls += 1;
      return child;
    },
  });
  assert.equal(staleUpdate.status, 'failed');
  assert.ok(staleUpdate.message?.includes('新的已确认观察'));
  assert.equal(staleSaveCalls, 0);
  passed += 1;

  // 5d) 保存层收到原子条件：期望的已确认观察 id 快照
  let atomicExpectedIds: string[] = [];
  await updateGrowthProfileAfterConfirmation(child, [confirmed], {
    invoke: async () => reply(JSON.stringify(PROFILE)),
    reloadObservations: async () => [confirmed],
    save: async (_childId, profile, expectedIds) => {
      atomicExpectedIds = expectedIds;
      return { ...child, growth_profile: profile };
    },
  });
  assert.deepEqual(atomicExpectedIds, ['confirmed-1']);
  passed += 1;

  // 5e) 复查通过后、写入前发生新的确认：保存层原子条件失败 → 可重试状态，不覆盖新结果
  const atomicFail = await updateGrowthProfileSafely(child, [confirmed], {
    invoke: async () => reply(JSON.stringify(PROFILE)),
    reloadObservations: async () => [confirmed],
    save: async () => {
      throw new StaleEvidenceError('生成期间已有新的已确认观察，请重新生成。');
    },
  });
  assert.equal(atomicFail.status, 'failed');
  assert.ok(atomicFail.message?.includes('重新生成'));
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

  // A current profile still needs an explicit teacher-only regeneration control.
  const childPage = readFileSync(new URL('../src/app/children/[id]/page.tsx', import.meta.url), 'utf8');
  const retryComponent = readFileSync(new URL('../src/components/growth-profile-retry.tsx', import.meta.url), 'utf8');
  assert.ok(childPage.includes('isCurrent={profileIsCurrent}'));
  assert.ok(retryComponent.includes('重新整理成长小结'));
  passed += 1;

  // 8) 未登录写请求仍为 401。
  const previousTrustedOrigins = process.env.AUTH_TRUSTED_ORIGINS;
  try {
    process.env.AUTH_TRUSTED_ORIGINS = 'http://127.0.0.1';
    assert.equal(requireTeacher(new Request('http://localhost/api/observations'))?.status, 401);
  } finally {
    if (previousTrustedOrigins === undefined) delete process.env.AUTH_TRUSTED_ORIGINS;
    else process.env.AUTH_TRUSTED_ORIGINS = previousTrustedOrigins;
  }
  passed += 1;

  // 9) 未配置可信来源仍为 503。
  const previousMissingCheckTrustedOrigins = process.env.AUTH_TRUSTED_ORIGINS;
  try {
    delete process.env.AUTH_TRUSTED_ORIGINS;
    assert.equal(requireTeacher(new Request('http://localhost/api/observations'))?.status, 503);
  } finally {
    if (previousMissingCheckTrustedOrigins === undefined) delete process.env.AUTH_TRUSTED_ORIGINS;
    else process.env.AUTH_TRUSTED_ORIGINS = previousMissingCheckTrustedOrigins;
  }
  passed += 1;

  console.log(JSON.stringify({ passed, total: 14 }));
}

void main();
