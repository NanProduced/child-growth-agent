import assert from 'node:assert/strict';

import {
  buildActivitySupportMessages,
  generateActivitySupport,
} from '../src/lib/ai';
import {
  hasCurrentActivitySupport,
  updateActivitySupport,
} from '../src/lib/activity-support';
import type { LlmResult } from '../src/lib/llm';
import type {
  Child,
  GrowthProfile,
  Observation,
  ObservationDraft,
  ObservationStatus,
  SchoolClass,
} from '../src/lib/types';
import { activitySupportDraftSchema } from '../src/lib/validation';

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

const PROFILE: GrowthProfile = {
  summary: '已确认的观察显示，幼儿会在搭建过程中尝试调整材料位置。',
  recent_change: '最近一次观察中，幼儿主动增加支撑并再次尝试。',
  development_clues: ['发现桥面变化后调整支撑位置。'],
  next_support: '提供不同长度的积木，邀请幼儿说说每次调整的原因。',
  next_focus: '下一次可以继续看看幼儿是否会主动比较不同支撑方式。',
  source_observation_ids: ['confirmed-1'],
  ai_model: 'offline-profile-model',
  updated_at: '2026-09-25T11:00:00.000Z',
};

const VALID_SUPPORT = {
  suggestions: [
    {
      title: '桥墩换一换',
      purpose: '支持幼儿继续观察支撑位置和桥面稳定之间的关系。',
      steps: ['准备长短不同的积木。', '邀请幼儿换一种支撑方式再试一次。'],
      materials: ['长短不同的积木'],
      observe: '继续观察幼儿是否会主动比较不同支撑方式，并说出变化。',
      adaptation: '如果桥面容易倒，先减少材料数量，再邀请幼儿一次只改一处。',
      evidence: ['科学：把两块积木并排放在下面当桥墩。'],
    },
    {
      title: '说说为什么',
      purpose: '支持幼儿把搭建中的调整和看到的结果联系起来。',
      steps: ['请幼儿指出这次调整的地方。', '用“如果……会怎样”邀请幼儿再试一次。'],
      materials: [],
      observe: '继续观察幼儿是否能用动作或语言说明调整前后的不同。',
      adaptation: '如果幼儿暂时不想表达，先让幼儿继续搭建，教师用复述代替追问。',
      evidence: ['科学：这次桥不会塌了。'],
    },
  ],
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
const draft = observation('draft-1', 'draft', null);
const mixedObservations = [confirmed, draft];
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
  growth_profile: PROFILE,
  is_demo: true,
  created_at: '2026-09-25T09:00:00.000Z',
  updated_at: null,
};

function reply(content: string): LlmResult {
  return { content, provider: 'stepfun', model: 'offline-activity-model' };
}

async function main(): Promise<void> {
  let passed = 0;

  // 1) 发送给模型的用户证据只包含 confirmed 观察，不包含 draft 或 ai_draft。
  const messages = buildActivitySupportMessages({
    childName: child.name,
    childGender: child.gender,
    childBirthDate: child.birth_date,
    classStage: child.class_stage,
    className: child.class_name,
    observations: mixedObservations,
    growthProfile: PROFILE,
  });
  const userMessage = messages[1].content;
  assert.ok(userMessage.includes('confirmed-1'));
  assert.ok(userMessage.includes('已确认原文 confirmed-1'));
  assert.ok(userMessage.includes('"age_months":56'));
  assert.ok(userMessage.includes('当前班级上下文：middle · 向日葵班'));
  assert.ok(userMessage.includes(PROFILE.summary));
  assert.ok(!userMessage.includes('draft-1'));
  assert.ok(!userMessage.includes('未确认原文 draft-1'));
  assert.ok(!userMessage.includes('AI 草稿 confirmed-1'));
  passed += 1;

  // 2) 没有 confirmed 观察时直接拒绝，invoke 不会被调用。
  let emptyCalls = 0;
  await assert.rejects(
    generateActivitySupport(
      {
        childName: child.name,
        childGender: child.gender,
        childBirthDate: child.birth_date,
        classStage: child.class_stage,
        className: child.class_name,
        observations: [draft],
      },
      async () => {
        emptyCalls += 1;
        return reply(JSON.stringify(VALID_SUPPORT));
      },
    ),
    (error: Error) => error.message.includes('至少一条已确认观察'),
  );
  assert.equal(emptyCalls, 0);
  passed += 1;

  // 3) 合法输出通过最终 Zod 校验，并使用 activity_support response type。
  let responseType = '';
  const generated = await generateActivitySupport(
    {
      childName: child.name,
      childGender: child.gender,
      childBirthDate: child.birth_date,
      classStage: child.class_stage,
      className: child.class_name,
      observations: mixedObservations,
    },
    async (_messages, options) => {
      responseType = options?.responseType ?? '';
      return reply(JSON.stringify(VALID_SUPPORT));
    },
  );
  assert.equal(responseType, 'activity_support');
  assert.equal(activitySupportDraftSchema.safeParse(generated.activitySupport).success, true);
  assert.equal(generated.activitySupport.suggestions.length, 2);
  passed += 1;

  // 4) 诊断/评分词被最终内容检查拦截，并按现有机制重试一次。
  let forbiddenCalls = 0;
  await assert.rejects(
    generateActivitySupport(
      {
        childName: child.name,
        childGender: child.gender,
        childBirthDate: child.birth_date,
        classStage: child.class_stage,
        className: child.class_name,
        observations: [confirmed],
      },
      async () => {
        forbiddenCalls += 1;
        return reply(JSON.stringify({
          suggestions: VALID_SUPPORT.suggestions.map((suggestion, index) =>
            index === 0 ? { ...suggestion, purpose: '帮助幼儿进行评分。' } : suggestion,
          ),
        }));
      },
    ),
    (error: Error) => error.message.includes('不允许的定性词'),
  );
  assert.equal(forbiddenCalls, 2);
  passed += 1;

  // 5) 2～3 条限制由 Zod 拦截，4 条建议不会被静默截断。
  let countCalls = 0;
  await assert.rejects(
    generateActivitySupport(
      {
        childName: child.name,
        childGender: child.gender,
        childBirthDate: child.birth_date,
        classStage: child.class_stage,
        className: child.class_name,
        observations: [confirmed],
      },
      async () => {
        countCalls += 1;
        return reply(JSON.stringify({
          suggestions: [...VALID_SUPPORT.suggestions, ...VALID_SUPPORT.suggestions],
        }));
      },
    ),
    (error: Error) => error.message.includes('schema 校验失败'),
  );
  assert.equal(countCalls, 2);
  passed += 1;

  // 6) 每条建议都必须能标出输入中的观察领域。
  await assert.rejects(
    generateActivitySupport(
      {
        childName: child.name,
        childGender: child.gender,
        childBirthDate: child.birth_date,
        classStage: child.class_stage,
        className: child.class_name,
        observations: [confirmed],
      },
      async () =>
        reply(JSON.stringify({
          suggestions: VALID_SUPPORT.suggestions.map((suggestion) => ({
            ...suggestion,
            evidence: ['没有对应领域的泛化描述'],
          })),
        })),
    ),
    (error: Error) => error.message.includes('观察领域证据'),
  );
  passed += 1;

  // 7) 保存时只追加 activity_support，来源只记录 confirmed，不触碰原始观察内容。
  const rawSnapshot = JSON.stringify({
    raw_text: confirmed.raw_text,
    ai_draft: confirmed.ai_draft,
    confirmed_content: confirmed.confirmed_content,
  });
  let savedProfile: GrowthProfile = PROFILE;
  const updated = await updateActivitySupport(child, mixedObservations, {
    invoke: async () => reply(JSON.stringify(VALID_SUPPORT)),
    save: async (_childId, profile) => {
      savedProfile = profile;
      return { ...child, growth_profile: profile };
    },
  });
  assert.deepEqual(updated.activitySupport.source_observation_ids, ['confirmed-1']);
  assert.deepEqual(savedProfile.activity_support?.source_observation_ids, ['confirmed-1']);
  assert.equal(hasCurrentActivitySupport(updated.activitySupport, mixedObservations), true);
  assert.equal(
    JSON.stringify({
      raw_text: confirmed.raw_text,
      ai_draft: confirmed.ai_draft,
      confirmed_content: confirmed.confirmed_content,
    }),
    rawSnapshot,
  );
  passed += 1;

  // 8) 旧档案为空时也沿用 fallback 字段写入同一个 growth_profile JSONB，不新增表。
  const childWithoutProfile = { ...child, growth_profile: null };
  const fallbackSaved = await updateActivitySupport(childWithoutProfile, [confirmed], {
    invoke: async () => reply(JSON.stringify(VALID_SUPPORT)),
    save: async (_childId, profile) => ({ ...childWithoutProfile, growth_profile: profile }),
  });
  assert.equal(fallbackSaved.growthProfile?.summary, CONFIRMED_CONTENT.objective_description);
  assert.deepEqual(fallbackSaved.growthProfile?.activity_support?.source_observation_ids, ['confirmed-1']);
  passed += 1;

  console.log(JSON.stringify({ passed, total: 8 }));
}

void main();
