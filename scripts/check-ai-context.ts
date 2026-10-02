import assert from 'node:assert/strict';

import {
  SYSTEM_PROMPT,
  buildActivitySupportMessages,
  buildFollowUpMessages,
  buildGrowthProfileMessages,
  buildOrganizeMessages,
} from '../src/lib/ai';
import {
  SYSTEM_PROMPT as BASELINE_SYSTEM_PROMPT,
  buildOrganizeMessages as baselineBuildOrganizeMessages,
} from '../src/lib/ai-baseline';
import {
  EDUCATION_PRINCIPLES,
  EDUCATION_PRINCIPLES_BLOCK,
  EDUCATION_PRINCIPLES_SOURCES,
  EDUCATION_PRINCIPLES_VERIFIED_AT,
} from '../src/lib/education-principles';
import { isoDateInShanghai, parseIsoDateStrict } from '../src/lib/format';
import { buildGrowthProfileFallback } from '../src/lib/growth-profile';
import type { Observation, ObservationDraft } from '../src/lib/types';

/** 上下文、时间顺序与 fallback 的离线检查；不调用模型、不写数据库。 */

function content(label: string): ObservationDraft {
  return {
    domain: '健康',
    sub_domain: '生活自理',
    objective_description: label,
    highlights: [`${label} 的亮点`],
    support_suggestions: ['继续提供机会。'],
    highlight_quote: '自己走到阴凉处喝水',
  };
}

function observation(overrides: Partial<Observation>): Observation {
  return {
    id: 'obs-1',
    child_id: 'child-1',
    class_id: 'class-1',
    observed_class: {
      id: 'class-1',
      name: '彩虹班',
      stage: 'small',
      school_year: '2026-2027',
      is_active: true,
      is_demo: true,
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: null,
    },
    observed_at: '2026-09-22',
    context: '户外活动',
    raw_text: '早操后，诺诺自己走到阴凉处坐下喝水，说「我不热了，还想玩」。',
    status: 'confirmed',
    agent_context: null,
    ai_draft: null,
    ai_model: 'offline-model',
    ai_organized_at: '2026-09-22T10:00:00.000Z',
    confirmed_content: content('活动后自己走到阴凉处喝水。'),
    confirmed_at: '2026-09-22T11:00:00.000Z',
    is_demo: true,
    created_at: '2026-09-22T09:00:00.000Z',
    updated_at: null,
    ...overrides,
  };
}

const userMessage = (messages: { role: string; content: string }[]): string =>
  messages[messages.length - 1].content;

async function main(): Promise<void> {
  let passed = 0;

  // 1) 整理：观察发生时月龄、当前日期、背景备注分区
  {
    const params = {
      childName: '诺诺',
      childGender: '男',
      childBirthDate: '2022-08-01',
      observedAt: '2026-09-22',
      context: '户外活动',
      rawText: '早操后，诺诺自己走到阴凉处坐下喝水，说「我不热了，还想玩」。',
      childNote: '体质偏弱，家长提醒活动后及时喝水',
      currentDate: '2026-10-02',
    };
    const before = JSON.stringify(params);
    const message = userMessage(buildOrganizeMessages(params));
    assert.ok(message.includes('49 个月'), '整理应使用观察发生时月龄（49 个月）');
    assert.ok(message.includes('当前日期：2026-10-02'), '整理应显式传入当前日期');
    assert.ok(message.includes('【教师提供的背景】'), '背景备注必须独立分区');
    assert.ok(message.includes('体质偏弱'), '背景备注按需传入');
    assert.ok(message.includes('【原始观察 raw_text】'), '原始观察必须独立分区');
    assert.ok(message.includes('【教师补充问答】'), '教师问答必须独立分区');
    assert.equal(JSON.stringify(params), before, '输入不得被修改');
    passed += 1;
  }

  // 2) 月龄未知不伪装成 0 个月
  {
    const message = userMessage(
      buildOrganizeMessages({
        childName: '诺诺',
        childGender: '男',
        childBirthDate: '不是日期',
        observedAt: '2026-09-22',
        context: null,
        rawText: '早操后，诺诺自己走到阴凉处坐下喝水。',
        currentDate: '2026-10-02',
      }),
    );
    assert.ok(message.includes('月龄未知'), '无效出生日期应标为月龄未知');
    assert.ok(!message.includes('0 个月'), '未知月龄不得伪装成 0 个月');
    passed += 1;
  }

  // 3) 追问消息带观察发生时月龄、当前日期与背景分区
  {
    const message = userMessage(
      buildFollowUpMessages({
        childName: '果果',
        childGender: '女',
        childBirthDate: '2021-06-10',
        observedAt: '2026-09-25',
        context: '建构区',
        rawText: '区域活动时，果果用两块长积木搭桥，桥倒了三次。',
        childNote: '喜欢搭建',
        currentDate: '2026-10-02',
      }),
    );
    assert.ok(message.includes('63 个月'), '追问应使用观察发生时月龄');
    assert.ok(message.includes('当前日期：2026-10-02'));
    assert.ok(message.includes('【教师提供的背景】'));
    passed += 1;
  }

  // 4) 成长小结：逐条日期/月龄/班级，未知月龄为 null
  {
    const valid = observation({});
    const unknown = observation({
      id: 'obs-2',
      observed_at: '2026-09-25',
      confirmed_content: content('第二条确认记录。'),
    });
    const messages = buildGrowthProfileMessages({
      childName: '诺诺',
      childGender: '男',
      childBirthDate: '2022-08-01',
      observations: [valid],
      currentDate: '2026-10-02',
      childNote: '喜欢户外',
    });
    const message = userMessage(messages);
    assert.ok(message.includes('"age_months":49'), '成长小结应含每条观察的当时月龄');
    assert.ok(message.includes('"observed_at":"2026-09-22"'), '成长小结应含观察日期');
    assert.ok(message.includes('"name":"彩虹班"'), '成长小结应含发生时班级');
    assert.ok(message.includes('当前日期：2026-10-02'));
    assert.ok(message.includes('【教师提供的背景】'));

    const unknownMessage = userMessage(
      buildGrowthProfileMessages({
        childName: '诺诺',
        childGender: '男',
        childBirthDate: '',
        observations: [unknown],
        currentDate: '2026-10-02',
      }),
    );
    assert.ok(unknownMessage.includes('"age_months":null'), '无效出生日期应输出 null 月龄');
    assert.ok(unknownMessage.includes('不得推断'), 'unknown 月龄应有明确说明');
    const before = JSON.stringify([valid, unknown]);
    buildGrowthProfileMessages({
      childName: '诺诺',
      childGender: '男',
      childBirthDate: '2022-08-01',
      observations: [valid, unknown],
      currentDate: '2026-10-02',
    });
    assert.equal(JSON.stringify([valid, unknown]), before, '观察输入与原文不得被修改');
    passed += 1;
  }

  // 5) 活动支持：区分历史观察月龄与当前支持月龄
  {
    const message = userMessage(
      buildActivitySupportMessages({
        childName: '诺诺',
        childGender: '男',
        childBirthDate: '2022-08-01',
        classStage: 'small',
        className: '彩虹班',
        observations: [observation({})],
        currentDate: '2026-10-02',
        childNote: '喜欢户外',
      }),
    );
    assert.ok(message.includes('当前支持月龄：50 个月'), '活动应含当前支持月龄');
    assert.ok(message.includes('"age_months":49'), '活动证据应保留观察发生时月龄');
    assert.ok(message.includes('当前日期：2026-10-02'));
    assert.ok(message.includes('【教师提供的背景】'));
    const unknownMessage = userMessage(
      buildActivitySupportMessages({
        childName: '诺诺',
        childGender: '男',
        childBirthDate: '坏日期',
        observations: [observation({})],
        currentDate: '2026-10-02',
      }),
    );
    assert.ok(unknownMessage.includes('当前支持月龄：月龄未知'), '当前年龄未知时明确标注');
    assert.ok(unknownMessage.includes('"age_months":null'), '历史月龄未知时输出 null');
    passed += 1;
  }

  // 6) 保守 fallback：不把最新表现复制成“变化”，不暗示趋势
  {
    const single = buildGrowthProfileFallback([observation({})]);
    assert.ok(single);
    assert.ok(single.recent_change.includes('还不能判断变化'), '单条 fallback 必须说明不能判断变化');
    assert.notEqual(single.recent_change, single.summary, 'fallback 不得把最新表现复制成变化');
    assert.ok(!/进步|退步|稳定|持续/.test(JSON.stringify(single)), 'fallback 不得暗示趋势');

    const multiple = buildGrowthProfileFallback([
      observation({}),
      observation({
        id: 'obs-2',
        observed_at: '2026-09-25',
        confirmed_content: content('第二条确认记录。'),
      }),
    ]);
    assert.ok(multiple);
    assert.ok(multiple.recent_change.includes('没有生成可比较'), '多条 fallback 应说明尚无可比较小结');
    passed += 1;
  }

  // 7) 教育原则：来源、核验日期与条目
  {
    assert.equal(EDUCATION_PRINCIPLES_VERIFIED_AT, '2026-10-02');
    assert.equal(EDUCATION_PRINCIPLES_SOURCES.length, 2);
    for (const source of EDUCATION_PRINCIPLES_SOURCES) {
      assert.ok(source.url.includes('moe.gov.cn'), '来源必须是教育部官网');
    }
    assert.ok(EDUCATION_PRINCIPLES.length >= 8, '原则摘要至少覆盖 8 条');
    assert.ok(EDUCATION_PRINCIPLES_BLOCK.includes('不是幼儿表现的证据'));
    assert.ok(SYSTEM_PROMPT.includes('教育参考原则'), '整理 Prompt 应引用原则摘要');
    passed += 1;
  }

  // 8) 基线完整性：07d5224 基线仍可直接用于对照，且与新版本输入组装不同
  {
    assert.ok(BASELINE_SYSTEM_PROMPT.includes('禁止医疗与心理诊断词汇'), '基线应是 07d5224 的旧 Prompt');
    assert.notEqual(BASELINE_SYSTEM_PROMPT, SYSTEM_PROMPT, '新旧 Prompt 必须是两个真实版本');
    const sharedParams = {
      childName: '诺诺',
      childGender: '男',
      childBirthDate: '2022-08-01',
      observedAt: '2026-09-22',
      context: '户外活动',
      rawText: '早操后，诺诺自己走到阴凉处坐下喝水。',
      childNote: '喜欢户外',
      currentDate: '2026-10-02',
    };
    const baselineMessage = userMessage(baselineBuildOrganizeMessages(sharedParams));
    assert.ok(!baselineMessage.includes('【教师提供的背景】'), '基线不包含背景分区');
    assert.ok(!baselineMessage.includes('当前日期：'), '基线不包含当前日期');
    assert.ok(
      baselineMessage.includes('月龄约 49 个月'),
      '基线保留旧月龄写法，证明对照为真实旧版本',
    );
    passed += 1;
  }

  // 9) 严格日历日期：无效日期不得被 Date 自动进位
  {
    const rolled = userMessage(
      buildOrganizeMessages({
        childName: '诺诺',
        childGender: '男',
        childBirthDate: '2022-02-30',
        observedAt: '2026-09-22',
        context: null,
        rawText: '早操后，诺诺自己走到阴凉处坐下喝水。',
        currentDate: '2026-10-02',
      }),
    );
    assert.ok(rolled.includes('月龄未知'), '2022-02-30 必须判为月龄未知，不能进位成 3 月 1 日');
    const noLeap = userMessage(
      buildOrganizeMessages({
        childName: '诺诺',
        childGender: '男',
        childBirthDate: '2025-02-29',
        observedAt: '2026-09-22',
        context: null,
        rawText: '早操后，诺诺自己走到阴凉处坐下喝水。',
        currentDate: '2026-10-02',
      }),
    );
    assert.ok(noLeap.includes('月龄未知'), '2025-02-29 必须判为月龄未知');
    const badMonth = userMessage(
      buildOrganizeMessages({
        childName: '诺诺',
        childGender: '男',
        childBirthDate: '2022-13-01',
        observedAt: '2026-09-22',
        context: null,
        rawText: '早操后，诺诺自己走到阴凉处坐下喝水。',
        currentDate: '2026-10-02',
      }),
    );
    assert.ok(badMonth.includes('月龄未知'), '无效月份必须判为月龄未知');
    const leap = userMessage(
      buildOrganizeMessages({
        childName: '诺诺',
        childGender: '男',
        childBirthDate: '2024-02-29',
        observedAt: '2026-09-22',
        context: null,
        rawText: '早操后，诺诺自己走到阴凉处坐下喝水。',
        currentDate: '2026-10-02',
      }),
    );
    assert.ok(leap.includes('30 个月'), '合法闰日必须能计算月龄');
    const future = userMessage(
      buildOrganizeMessages({
        childName: '诺诺',
        childGender: '男',
        childBirthDate: '2026-10-01',
        observedAt: '2026-09-22',
        context: null,
        rawText: '早操后，诺诺自己走到阴凉处坐下喝水。',
        currentDate: '2026-10-02',
      }),
    );
    assert.ok(future.includes('月龄未知'), '出生日期晚于观察日期必须判为未知，不能为 0');
    assert.equal(parseIsoDateStrict('2024-02-29')?.getUTCDate(), 29);
    assert.equal(parseIsoDateStrict('2022-02-30'), null);
    passed += 1;
  }

  // 10) 默认当前日期按 Asia/Shanghai 计算
  {
    assert.equal(
      isoDateInShanghai(new Date('2026-10-01T17:00:00Z')),
      '2026-10-02',
      'UTC 17:00 已是北京时间次日，默认日期不得输出 2026-10-01',
    );
    assert.equal(isoDateInShanghai(new Date('2026-10-01T15:59:00Z')), '2026-10-01');
    passed += 1;
  }

  // 11) 成长小结证据按 observed_at 排序，且不修改输入
  {
    const laterFirst = [
      observation({
        id: 'sort-2',
        observed_at: '2026-09-28',
        confirmed_content: content('较晚观察。'),
      }),
      observation({
        id: 'sort-1',
        observed_at: '2026-09-10',
        confirmed_content: content('较早观察。'),
      }),
    ];
    const before = JSON.stringify(laterFirst);
    const message = userMessage(
      buildGrowthProfileMessages({
        childName: '果果',
        childGender: '女',
        childBirthDate: '2021-06-10',
        observations: laterFirst,
        currentDate: '2026-10-02',
      }),
    );
    const earlierIndex = message.indexOf('"observed_at":"2026-09-10"');
    const laterIndex = message.indexOf('"observed_at":"2026-09-28"');
    assert.ok(earlierIndex >= 0 && laterIndex >= 0, '消息应包含两条观察日期');
    assert.ok(earlierIndex < laterIndex, '证据必须按 observed_at 升序排列');
    assert.equal(JSON.stringify(laterFirst), before, '排序不得修改输入数组');
    passed += 1;
  }

  // 12) fallback 的最近记录按真实观察日期，而非录入顺序
  {
    const backfilled = observation({
      id: 'fallback-old-but-late-created',
      observed_at: '2026-08-15',
      created_at: '2026-09-30T09:00:00.000Z',
      confirmed_content: content('八月补录的旧观察。'),
    });
    const recent = observation({
      id: 'fallback-recent',
      observed_at: '2026-09-25',
      created_at: '2026-09-26T09:00:00.000Z',
      confirmed_content: content('九月最新的观察。'),
    });
    const fallback = buildGrowthProfileFallback([backfilled, recent]);
    assert.ok(fallback);
    assert.ok(
      fallback.recent_change.includes('九月最新的观察'),
      'fallback 必须选择真实观察日期最新的记录',
    );
    assert.ok(!fallback.recent_change.includes('八月补录的旧观察'));
    passed += 1;
  }

  // 13) 同日多条与不可靠日期：不声称确定“最近一次”或事件先后
  {
    const sameDay = buildGrowthProfileFallback([
      observation({
        id: 'same-day-1',
        observed_at: '2026-09-25',
        confirmed_content: content('同日上午的记录。'),
      }),
      observation({
        id: 'same-day-2',
        observed_at: '2026-09-25',
        confirmed_content: content('同日午后的记录。'),
      }),
    ]);
    assert.ok(sameDay);
    assert.ok(
      sameDay.recent_change.includes('同一天') && sameDay.recent_change.includes('暂不推断'),
      '同日多条不得推断事件先后',
    );
    assert.ok(!sameDay.recent_change.includes('最近一次记录是'));

    const unreliable = buildGrowthProfileFallback([
      observation({
        id: 'bad-date-1',
        observed_at: '2022-02-30',
        confirmed_content: content('日期不可靠的记录。'),
      }),
      observation({
        id: 'bad-date-2',
        observed_at: '2026-09-25',
        confirmed_content: content('日期可靠的记录。'),
      }),
    ]);
    assert.ok(unreliable);
    assert.ok(
      !unreliable.recent_change.includes('最近一次记录是'),
      '存在不可靠日期时不得声称已确定最近一次',
    );
    passed += 1;
  }

  // 14) 必要追问：一次动作词不等于必然放行，缺失支持条件也不能默默忽略
  {
    const followUpPrompt = (
      await import('../src/lib/ai')
    ).FOLLOW_UP_SYSTEM_PROMPT;
    assert.ok(
      followUpPrompt.includes('缺失信息') && followUpPrompt.includes('影响'),
      '追问 Prompt 必须说明缺失信息影响什么，而非只看有无动作词',
    );
    assert.ok(
      followUpPrompt.includes('不能只写“信息不完整”') ||
        followUpPrompt.includes('不能只写信息不完整'),
      '追问 Prompt 必须要求 reason 具体',
    );
    passed += 1;
  }

  console.log(JSON.stringify({ passed, total: 14 }));
}

void main();
