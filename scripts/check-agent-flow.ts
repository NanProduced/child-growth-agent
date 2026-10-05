import assert from 'node:assert/strict';

import { requireTeacher } from '../src/lib/auth';
import {
  SYSTEM_PROMPT,
  buildFollowUpMessages,
  buildOrganizeMessages,
  buildTeacherEditReviewMessages,
  judgeFollowUp,
  organizeObservation,
  reviewTeacherEdit,
} from '../src/lib/ai';
import { formatFollowUpRounds, followUpRounds } from '../src/lib/follow-up';
import {
  appendFollowUpAction,
  nextFollowUpContext,
  observationWriteGuard,
  shouldProceedToDraft,
} from '../src/lib/observation-agent';
import {
  normalizeTeacherEditContent,
  sameTeacherEditContent,
  teacherEditSubmissionAction,
} from '../src/lib/teacher-edit-review';
import type { LlmResult } from '../src/lib/llm';
import type { Observation, TeacherEditReview } from '../src/lib/types';
import {
  findDevelopmentForbiddenTerm,
  followUpDecisionSchema,
  teacherEditReviewSchema,
} from '../src/lib/validation';

const PARAMS = {
  childName: '测试幼儿',
  childGender: '女',
  childBirthDate: '2022-01-01',
  observedAt: '2026-09-01',
  context: '建构区',
  rawText: '测试幼儿在建构区把三块长积木并排搭成小桥，桥上放了一个小汽车，桥没有倒。',
};

const VALID_DRAFT = {
  domain: '科学',
  sub_domain: '科学探究',
  objective_description: '幼儿在搭建中尝试让结构保持稳定。',
  highlights: ['把三块长积木并排搭成小桥。'],
  support_suggestions: ['提供不同长度的积木供幼儿继续探索。'],
  highlight_quote: '桥没有倒。',
};

const EDITED_CONTENT = {
  ...VALID_DRAFT,
  objective_description: '教师将发展表现描述调整为更贴近这次观察中的具体搭建行为。',
};

function reply(content: string): LlmResult {
  return { content, provider: 'stepfun', model: 'step-5-preview' };
}

function decision(value: 'ask' | 'proceed'): string {
  return JSON.stringify({
    decision: value,
    question: value === 'ask' ? '幼儿当时说了什么？' : '',
    reason: value === 'ask' ? '需要保留幼儿原话，帮助判断表达与思考过程。' : '现有行为事实已足以整理。',
  });
}

async function main(): Promise<void> {
  // 1) 信息足够时直接 proceed。
  const first = await judgeFollowUp(PARAMS, async () => reply(decision('proceed')));
  assert.equal(first.decision.decision, 'proceed');

  // 2) 首次 ask，教师回答后再次判断并 proceed。
  const firstAsk = await judgeFollowUp(PARAMS, async () => reply(decision('ask')));
  let context = nextFollowUpContext(null, firstAsk.decision);
  assert.equal(context.follow_up?.round, 1);
  context = appendFollowUpAction(context, 'answer', '他说桥不会倒。', '2026-09-01T01:00:00.000Z');
  const afterAnswer = await judgeFollowUp({ ...PARAMS, agentContext: context }, async () =>
    reply(decision('proceed')),
  );
  assert.equal(afterAnswer.decision.decision, 'proceed');

  // 2b) 第一轮的问题、必要性与回答成对保存
  const firstFollowUp = context.follow_up;
  assert.ok(firstFollowUp);
  const firstRounds = followUpRounds(firstFollowUp);
  assert.equal(firstRounds.length, 1);
  assert.equal(firstRounds[0].round, 1);
  assert.equal(firstRounds[0].question, '幼儿当时说了什么？');
  assert.ok(firstRounds[0].reason.includes('保留幼儿原话'));
  assert.equal(firstRounds[0].answer?.action, 'answer');
  assert.equal(firstRounds[0].answer?.content, '他说桥不会倒。');

  // 3) skip 后直接进入整理；4) stop 后也不再追问。
  assert.equal(shouldProceedToDraft(appendFollowUpAction(context, 'skip', '')), true);
  const stopped = appendFollowUpAction(context, 'stop', '');
  assert.equal(stopped.follow_up?.stopped, true);
  assert.equal(shouldProceedToDraft(stopped), true);

  // 5) 第二轮回答后不允许第三轮。
  const secondQuestion = nextFollowUpContext(context, {
    decision: 'ask',
    question: '当时教师怎样支持？',
    reason: '需要知道支持行为，才能让后续建议贴合情境。',
  });
  const secondAnswer = appendFollowUpAction(secondQuestion, 'answer', '我提醒他把积木放平。');
  assert.equal(secondAnswer.follow_up?.round, 2);
  assert.equal(shouldProceedToDraft(secondAnswer), true);

  // 5b) 第二轮后第一轮问答仍完整存在，两轮问题不互相覆盖
  const secondFollowUp = secondAnswer.follow_up;
  assert.ok(secondFollowUp);
  const secondRounds = followUpRounds(secondFollowUp);
  assert.equal(secondRounds.length, 2);
  assert.equal(secondRounds[0].question, '幼儿当时说了什么？');
  assert.equal(secondRounds[0].answer?.content, '他说桥不会倒。');
  assert.equal(secondRounds[1].question, '当时教师怎样支持？');
  assert.equal(secondRounds[1].answer?.content, '我提醒他把积木放平。');

  // 5c) 旧上下文（没有 rounds）不报错、不补造问题：无法确定问题的回答标为历史补充
  const legacyFollowUp = {
    round: 2,
    question: '当时教师怎样支持？',
    reason: '需要知道支持行为。',
    answers: [
      { action: 'answer' as const, content: '他说桥不会倒。', created_at: '2026-09-01T01:00:00.000Z' },
      { action: 'answer' as const, content: '我提醒他把积木放平。', created_at: '2026-09-01T02:00:00.000Z' },
    ],
    stopped: false,
  };
  const legacyRounds = followUpRounds(legacyFollowUp);
  assert.equal(legacyRounds[0].question, '', '旧回答不推测问题');
  assert.equal(legacyRounds[1].question, '当时教师怎样支持？');
  const legacyText = formatFollowUpRounds(legacyFollowUp);
  assert.ok(legacyText.includes('历史补充（原追问问题未保存）：他说桥不会倒。'));
  assert.ok(legacyText.includes('第2轮问题：当时教师怎样支持？'));
  assert.ok(legacyText.includes('教师回应：我提醒他把积木放平。'));

  // 5d) 问答成对进入整理 Prompt：模型能看到问题与回答的对应关系
  const pairedContext = nextFollowUpContext(null, {
    decision: 'ask',
    question: '主动完成还是教师提醒后完成？',
    reason: '需要知道完成方式，才能判断支持建议。',
  });
  const paired = appendFollowUpAction(pairedContext, 'answer', '提醒后');
  const pairedMessages = buildOrganizeMessages({ ...PARAMS, agentContext: paired });
  const pairedPrompt = pairedMessages[pairedMessages.length - 1].content;
  assert.ok(pairedPrompt.includes('第1轮问题：主动完成还是教师提醒后完成？'));
  assert.ok(pairedPrompt.includes('教师回应：提醒后'));

  // 5e) 回答保存后处理失败，重试修改回答：新回答成为该轮有效上下文，旧回答不再有效
  let retryContext = nextFollowUpContext(null, {
    decision: 'ask',
    question: '是独立完成还是教师帮忙？',
    reason: '需要知道完成方式。',
  });
  retryContext = appendFollowUpAction(retryContext, 'answer', '是独立完成。');
  retryContext = appendFollowUpAction(retryContext, 'answer', '实际是教师帮忙完成。');
  const retryFollowUp = retryContext.follow_up;
  assert.ok(retryFollowUp);
  assert.equal(retryFollowUp.round, 1, '重试不得增加追问轮次');
  const retryRounds = followUpRounds(retryFollowUp);
  assert.equal(retryRounds.length, 1);
  assert.equal(retryRounds[0].answer?.content, '实际是教师帮忙完成。');
  assert.equal(retryFollowUp.answers.length, 1, '同一轮重试不重复累积回答');
  const retryText = formatFollowUpRounds(retryFollowUp);
  assert.ok(retryText.includes('教师回应：实际是教师帮忙完成。'));
  assert.ok(!retryText.includes('是独立完成。'), '旧回答不能仍被当作当前有效依据');

  // 5f) 同一回答重复提交：轮次与有效问答不重复
  const repeated = appendFollowUpAction(
    appendFollowUpAction(retryContext, 'answer', '实际是教师帮忙完成。'),
    'answer',
    '实际是教师帮忙完成。',
  );
  assert.equal(repeated.follow_up?.round, 1);
  assert.equal(repeated.follow_up?.answers.length, 1);

  // 5g) 第一轮修改回答后进入第二轮：两轮配对正确
  const secondRound = nextFollowUpContext(retryContext, {
    decision: 'ask',
    question: '教师当时怎么帮忙的？',
    reason: '需要支持行为。',
  });
  const secondRoundAnswered = appendFollowUpAction(secondRound, 'answer', '我提醒他换一种支撑方式。');
  const secondRoundFollowUp = secondRoundAnswered.follow_up;
  assert.ok(secondRoundFollowUp);
  const secondRoundRounds = followUpRounds(secondRoundFollowUp);
  assert.equal(secondRoundRounds[0].answer?.content, '实际是教师帮忙完成。');
  assert.equal(secondRoundRounds[1].question, '教师当时怎么帮忙的？');
  assert.equal(secondRoundRounds[1].answer?.content, '我提醒他换一种支撑方式。');

  // 5h) skip/stop 重试不重新开启追问
  const skipContext = appendFollowUpAction(
    nextFollowUpContext(null, { decision: 'ask', question: '还需要补充吗？', reason: '需要事实。' }),
    'skip',
    '',
  );
  const skipRetry = appendFollowUpAction(skipContext, 'skip', '');
  assert.equal(shouldProceedToDraft(skipRetry), true);
  assert.equal(skipRetry.follow_up?.answers.length, 1);
  const stopContext = appendFollowUpAction(
    nextFollowUpContext(null, { decision: 'ask', question: '还需要补充吗？', reason: '需要事实。' }),
    'stop',
    '',
  );
  const stopRetry = appendFollowUpAction(stopContext, 'answer', '补一句。');
  assert.equal(stopRetry.follow_up?.stopped, true, 'stop 后重试不重新开启追问');
  assert.equal(shouldProceedToDraft(stopRetry), true);

  // 5i) 迟到异步写入必须携带服务端状态/上下文/原草稿快照
  const guardObservation = {
    id: 'obs-1',
    child_id: 'child-1',
    class_id: 'class-1',
    observed_class: null,
    observed_at: PARAMS.observedAt,
    context: PARAMS.context,
    raw_text: PARAMS.rawText,
    status: 'needs_input',
    agent_context: paired,
    ai_draft: null,
    ai_model: null,
    ai_organized_at: null,
    confirmed_content: null,
    confirmed_at: null,
    is_demo: true,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: null,
  } satisfies Observation;
  assert.deepEqual(observationWriteGuard(guardObservation), {
    expectedStatus: 'needs_input',
    expectedAgentContext: paired,
    expectedAiDraft: null,
  });

  // 6) 非法 Agent JSON 被 Zod 拦截，不静默修正。
  let invalidCalls = 0;
  await assert.rejects(
    judgeFollowUp(PARAMS, async () => {
      invalidCalls += 1;
      return reply('{"decision":"ask","question":"","reason":""}');
    }),
    (error: Error) => error.message.includes('schema 校验失败'),
  );
  assert.equal(invalidCalls, 2);
  assert.equal(followUpDecisionSchema.safeParse({ decision: 'later', question: '', reason: '' }).success, false);

  // 7) 网络错误会用同一输入重试一次。
  let networkCalls = 0;
  const retried = await judgeFollowUp(PARAMS, async () => {
    networkCalls += 1;
    if (networkCalls === 1) throw new Error('网络暂时不可用');
    return reply(decision('proceed'));
  });
  assert.equal(retried.decision.decision, 'proceed');
  assert.equal(networkCalls, 2);

  // 8) raw_text 贯穿消息与整理过程保持原值。
  const rawText = PARAMS.rawText;
  await organizeObservation(PARAMS, async () => reply(JSON.stringify(VALID_DRAFT)));
  assert.equal(PARAMS.rawText, rawText);
  assert.ok(buildOrganizeMessages(PARAMS).some((message) => message.content.includes(rawText)));
  assert.ok(buildFollowUpMessages({ ...PARAMS, agentContext: context }).some((message) => message.content.includes(rawText)));

  // P1-C：服务端规范化教师修改，teacher_note 不参与修改检测。
  assert.equal(teacherEditSubmissionAction(VALID_DRAFT, normalizeTeacherEditContent(VALID_DRAFT), undefined), 'confirm');
  assert.equal(teacherEditSubmissionAction(VALID_DRAFT, EDITED_CONTENT, undefined), 'review');
  assert.equal(
    sameTeacherEditContent(
      { ...EDITED_CONTENT, sub_domain: ' 科学探究 ', highlights: [...EDITED_CONTENT.highlights].reverse() },
      EDITED_CONTENT,
    ),
    true,
  );
  assert.equal(teacherEditSubmissionAction(VALID_DRAFT, VALID_DRAFT, undefined), 'confirm');

  // 最终确认内容也必须经过发展性内容守门；raw_text 不走此校验。
  assert.equal(findDevelopmentForbiddenTerm({ ...VALID_DRAFT, objective_description: '需要评分。' }), '评分');
  assert.equal(findDevelopmentForbiddenTerm({ ...VALID_DRAFT, objective_description: '幼儿把积木放在桥墩上。' }), undefined);

  // 普通情绪措辞不误拦，诊断性结论与能力定性仍拦截
  assert.equal(findDevelopmentForbiddenTerm('幼儿入园时有些焦虑，教师安抚后情绪平稳。'), undefined);
  assert.equal(findDevelopmentForbiddenTerm('幼儿可能存在焦虑症。'), '焦虑症');
  assert.equal(findDevelopmentForbiddenTerm('建议对幼儿进行诊断。'), '诊断');
  assert.equal(findDevelopmentForbiddenTerm('幼儿发展迟缓。'), '能力定性');

  // 整理 Prompt 与校验口径一致：允许有观察依据的普通情绪描述，仍禁止诊断/障碍/评分/能力定性
  assert.ok(SYSTEM_PROMPT.includes('普通情绪'), '整理 Prompt 应说明普通情绪描述的边界');
  assert.ok(SYSTEM_PROMPT.includes('入园'), '整理 Prompt 应给出普通情绪的示例口径');
  assert.ok(
    SYSTEM_PROMPT.includes('诊断') && SYSTEM_PROMPT.includes('障碍判断'),
    '整理 Prompt 应禁止诊断与障碍判断',
  );
  assert.ok(!SYSTEM_PROMPT.includes('焦虑、智商'), '整理 Prompt 不应再把普通“焦虑”列为禁止词');
  assert.ok(
    !SYSTEM_PROMPT.includes('焦虑症'),
    '整理 Prompt 不再重复具体诊断词，具体拦截由校验负责（避免两边口径漂移）',
  );

  const reviewReply = JSON.stringify({
    decision: 'accept',
    summary: '我已理解教师对观察描述的修改。',
    change_summary: ['将发展表现描述调整为更贴近具体搭建行为'],
    fact_check: 'supported',
    question: '',
  });
  let reviewCalls = 0;
  const reviewed = await reviewTeacherEdit(
    {
      rawText: rawText,
      originalDraft: VALID_DRAFT,
      content: normalizeTeacherEditContent(EDITED_CONTENT),
      teacherNote: '教师认为原描述过于笼统。',
    },
    async (messages) => {
      reviewCalls += 1;
      assert.ok(messages.some((message) => message.content.includes(rawText)));
      assert.ok(messages.some((message) => message.content.includes(JSON.stringify(VALID_DRAFT))));
      assert.ok(messages.some((message) => message.content.includes(JSON.stringify(normalizeTeacherEditContent(EDITED_CONTENT)))));
      assert.ok(messages.some((message) => message.content.includes('教师认为原描述过于笼统')));
      return reply(reviewReply);
    },
  );
  assert.equal(reviewed.review.decision, 'accept');
  assert.equal(reviewCalls, 1);
  assert.equal(teacherEditReviewSchema.safeParse(reviewed.review).success, true);

  const acceptedReview: TeacherEditReview = {
    ...reviewed.review,
    content_snapshot: normalizeTeacherEditContent(EDITED_CONTENT),
    note_snapshot: '',
    reviewed_at: '2026-09-01T02:00:00.000Z',
  };
  assert.equal(teacherEditSubmissionAction(VALID_DRAFT, EDITED_CONTENT, acceptedReview), 'confirm');
  assert.equal(
    teacherEditSubmissionAction(
      VALID_DRAFT,
      EDITED_CONTENT,
      { ...acceptedReview, decision: 'clarify', question: '请说明这处修改对应的具体行为。' },
    ),
    'clarify',
  );
  assert.equal(
    teacherEditSubmissionAction(VALID_DRAFT, { ...EDITED_CONTENT, domain: '语言' }, acceptedReview),
    'review',
  );
  assert.equal(
    teacherEditSubmissionAction(VALID_DRAFT, VALID_DRAFT, acceptedReview),
    'confirm',
  );

  let reviewRetryCalls = 0;
  await assert.rejects(
    reviewTeacherEdit(
      { rawText, originalDraft: VALID_DRAFT, content: normalizeTeacherEditContent(EDITED_CONTENT) },
      async () => {
        reviewRetryCalls += 1;
        throw new Error('审核网络失败');
      },
    ),
    (error: Error) => error.message.includes('Agent 修改审核失败'),
  );
  assert.equal(reviewRetryCalls, 2);

  let invalidReviewCalls = 0;
  await assert.rejects(
    reviewTeacherEdit(
      { rawText, originalDraft: VALID_DRAFT, content: normalizeTeacherEditContent(EDITED_CONTENT) },
      async () => {
        invalidReviewCalls += 1;
        return reply(
          JSON.stringify({
            decision: 'accept',
            summary: '不应接受',
            change_summary: [],
            fact_check: 'unsupported',
            question: '',
          }),
        );
      },
    ),
    (error: Error) => error.message.includes('Agent 修改审核失败'),
  );
  assert.equal(invalidReviewCalls, 2);

  // 9) 未登录写接口 401；10) 未配置可信来源 503。
  const previousTrustedOrigins = process.env.AUTH_TRUSTED_ORIGINS;
  try {
    delete process.env.AUTH_TRUSTED_ORIGINS;
    assert.equal(requireTeacher(new Request('http://localhost/api/observations'))?.status, 503);
    process.env.AUTH_TRUSTED_ORIGINS = 'http://127.0.0.1';
    assert.equal(requireTeacher(new Request('http://localhost/api/observations'))?.status, 401);
  } finally {
    if (previousTrustedOrigins === undefined) delete process.env.AUTH_TRUSTED_ORIGINS;
    else process.env.AUTH_TRUSTED_ORIGINS = previousTrustedOrigins;
  }

  console.log(JSON.stringify({ passed: 30, total: 30 }));
}

void main();
