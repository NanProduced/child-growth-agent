import assert from 'node:assert/strict';

import { requireTeacher } from '../src/lib/auth';
import {
  buildFollowUpMessages,
  buildOrganizeMessages,
  judgeFollowUp,
  organizeObservation,
} from '../src/lib/ai';
import {
  appendFollowUpAction,
  nextFollowUpContext,
  shouldProceedToDraft,
} from '../src/lib/observation-agent';
import type { LlmResult } from '../src/lib/llm';
import { followUpDecisionSchema } from '../src/lib/validation';

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

  // 9) 未登录写接口 401；10) 未配置教师口令 503。
  const previousPasscode = process.env.TEACHER_PASSCODE;
  try {
    delete process.env.TEACHER_PASSCODE;
    assert.equal(requireTeacher(new Request('http://localhost/api/observations'))?.status, 503);
    process.env.TEACHER_PASSCODE = 'local-test-passcode';
    assert.equal(requireTeacher(new Request('http://localhost/api/observations'))?.status, 401);
  } finally {
    if (previousPasscode === undefined) delete process.env.TEACHER_PASSCODE;
    else process.env.TEACHER_PASSCODE = previousPasscode;
  }

  console.log(JSON.stringify({ passed: 10, total: 10 }));
}

void main();
