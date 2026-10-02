import assert from 'node:assert/strict';

import { buildTeacherEditReviewMessages, reviewTeacherEdit } from '../src/lib/ai';
import {
  clarificationSnapshot,
  normalizeTeacherEditContent,
  normalizeTeacherNote,
  sameClarificationSnapshot,
  sameTeacherEditNote,
  teacherEditSubmissionAction,
} from '../src/lib/teacher-edit-review';
import type { LlmResult } from '../src/lib/llm';
import type {
  ObservationDraft,
  TeacherEditClarification,
  TeacherEditReview,
} from '../src/lib/types';
import { teacherEditReviewSchema } from '../src/lib/validation';

const RAW =
  '今天娃娃家里，糖糖抱着布娃娃，先给它盖好小毯子，再拿玩具体温计放在娃娃额头上看了一会儿。';

const DRAFT: ObservationDraft = {
  domain: '社会',
  sub_domain: '角色游戏',
  objective_description: '幼儿在角色游戏中照顾娃娃。',
  highlights: ['给娃娃盖好小毯子。'],
  support_suggestions: ['继续提供角色游戏材料。'],
  highlight_quote: '先给它盖好小毯子',
};

const EDITED = {
  ...DRAFT,
  objective_description: '幼儿在角色游戏中主动照顾娃娃并模仿测量体温。',
};

const CLARIFICATION: TeacherEditClarification = {
  question: '“测量体温”这处补充来自哪里？',
  answer: '教师当时看到糖糖把玩具体温计放在娃娃额头上，原文只写了看了一会儿。',
  created_at: '2026-09-30T00:00:00.000Z',
};

const EXTRA_CLARIFICATION: TeacherEditClarification = {
  question: '还有其他依据吗？',
  answer: '没有了。',
  created_at: '2026-09-30T01:00:00.000Z',
};

function reviewWith(overrides: Partial<TeacherEditReview>): TeacherEditReview {
  return {
    decision: 'accept',
    summary: '修改有依据。',
    change_summary: ['补充了测量体温的行为'],
    fact_check: 'supported',
    question: '',
    content_snapshot: normalizeTeacherEditContent(EDITED),
    clarification_snapshot: [],
    note_snapshot: '',
    reviewed_at: '2026-09-30T00:00:00.000Z',
    ...overrides,
  };
}

function reply(content: string): LlmResult {
  return { content, provider: 'stepfun', model: 'offline-review-model' };
}

async function main(): Promise<void> {
  let passed = 0;

  // 1) 原样确认不因审核状态额外增加审核
  assert.equal(
    teacherEditSubmissionAction(DRAFT, normalizeTeacherEditContent(DRAFT), reviewWith({})),
    'confirm',
  );
  passed += 1;

  // 2) 修改 AI 内容后无审核 → 必须复核
  assert.equal(
    teacherEditSubmissionAction(DRAFT, normalizeTeacherEditContent(EDITED), undefined),
    'review',
  );
  passed += 1;

  // 3) accept 绑定当前内容与澄清快照 → 允许最终确认
  const accepted = reviewWith({ decision: 'accept' });
  assert.equal(
    teacherEditSubmissionAction(DRAFT, normalizeTeacherEditContent(EDITED), accepted, []),
    'confirm',
  );
  passed += 1;

  // 4) clarify 绑定当前内容 → 仍返回 clarify，不归档
  const clarified = reviewWith({
    decision: 'clarify',
    question: '请说明这处补充的依据。',
    fact_check: 'partially_supported',
  });
  assert.equal(
    teacherEditSubmissionAction(DRAFT, normalizeTeacherEditContent(EDITED), clarified, []),
    'clarify',
  );
  passed += 1;

  // 5) 修改内容变化后旧审核立即失效
  const editedAgain = { ...EDITED, domain: '语言' };
  assert.equal(
    teacherEditSubmissionAction(DRAFT, normalizeTeacherEditContent(editedAgain), accepted, []),
    'review',
  );
  passed += 1;

  // 6) 澄清依据变化后旧审核立即失效
  const withClarification = reviewWith({
    clarification_snapshot: clarificationSnapshot([CLARIFICATION]),
  });
  assert.equal(
    teacherEditSubmissionAction(
      DRAFT,
      normalizeTeacherEditContent(EDITED),
      withClarification,
      [CLARIFICATION],
    ),
    'confirm',
  );
  assert.equal(
    teacherEditSubmissionAction(DRAFT, normalizeTeacherEditContent(EDITED), withClarification, []),
    'review',
  );
  assert.equal(
    teacherEditSubmissionAction(
      DRAFT,
      normalizeTeacherEditContent(EDITED),
      withClarification,
      [CLARIFICATION, EXTRA_CLARIFICATION],
    ),
    'review',
  );
  passed += 1;

  // 7) 旧审核没有 clarification_snapshot：空澄清列表仍兼容，不报错
  const legacy = reviewWith({});
  delete (legacy as Partial<TeacherEditReview>).clarification_snapshot;
  assert.equal(sameClarificationSnapshot(legacy, []), true);
  assert.equal(
    teacherEditSubmissionAction(DRAFT, normalizeTeacherEditContent(EDITED), legacy, []),
    'confirm',
  );
  passed += 1;

  // 8) 重复提交同一审核请求不会绕过确认规则
  assert.equal(
    teacherEditSubmissionAction(DRAFT, normalizeTeacherEditContent(EDITED), accepted, []),
    'confirm',
  );
  assert.equal(
    teacherEditSubmissionAction(DRAFT, normalizeTeacherEditContent(EDITED), clarified, []),
    'clarify',
  );
  passed += 1;

  // 9) 重新审核消息包含：原文、此前问答、原始草稿、当前修改、备注与澄清问答
  const messages = buildTeacherEditReviewMessages({
    rawText: RAW,
    originalDraft: DRAFT,
    content: normalizeTeacherEditContent(EDITED),
    teacherNote: '教师说明：补充了原文没有写全的动作。',
    agentContext: {
      follow_up: {
        round: 1,
        question: '幼儿当时说了什么？',
        reason: '需要保留幼儿原话。',
        answers: [
          {
            action: 'answer',
            content: '她说宝宝发烧了。',
            created_at: '2026-09-29T00:00:00.000Z',
          },
        ],
        rounds: [
          {
            round: 1,
            question: '幼儿当时说了什么？',
            reason: '需要保留幼儿原话。',
            answer: {
              action: 'answer',
              content: '她说宝宝发烧了。',
              created_at: '2026-09-29T00:00:00.000Z',
            },
          },
        ],
        stopped: false,
      },
    },
    clarifications: [CLARIFICATION],
  });
  const userPrompt = messages[messages.length - 1].content;
  assert.ok(userPrompt.includes(RAW));
  assert.ok(userPrompt.includes('第1轮问题：幼儿当时说了什么？'));
  assert.ok(userPrompt.includes('教师回应：她说宝宝发烧了。'));
  assert.ok(userPrompt.includes(JSON.stringify(DRAFT)));
  assert.ok(userPrompt.includes(JSON.stringify(normalizeTeacherEditContent(EDITED))));
  assert.ok(userPrompt.includes('教师说明：补充了原文没有写全的动作。'));
  assert.ok(userPrompt.includes(CLARIFICATION.question));
  assert.ok(userPrompt.includes(CLARIFICATION.answer));
  assert.ok(userPrompt.includes('教师新增事实'));
  passed += 1;

  // 10) 重新审核调用：mock 模型 accept；原文与原始草稿保持不变
  const snapshot = JSON.stringify({ raw: RAW, draft: DRAFT });
  const reviewed = await reviewTeacherEdit(
    {
      rawText: RAW,
      originalDraft: DRAFT,
      content: normalizeTeacherEditContent(EDITED),
      clarifications: [CLARIFICATION],
    },
    async () =>
      reply(
        JSON.stringify({
          decision: 'accept',
          summary: '已理解教师补充依据，修改可追溯。',
          change_summary: ['补充了测量体温的动作'],
          fact_check: 'supported',
          question: '',
        }),
      ),
  );
  assert.equal(reviewed.review.decision, 'accept');
  assert.equal(teacherEditReviewSchema.safeParse(reviewed.review).success, true);
  assert.equal(JSON.stringify({ raw: RAW, draft: DRAFT }), snapshot);
  passed += 1;

  // 11) 审核绑定教师备注：备注变化或撤回后旧 accept 失效
  const acceptedWithNote = reviewWith({ note_snapshot: normalizeTeacherNote('孩子独立完成') });
  assert.equal(
    teacherEditSubmissionAction(
      DRAFT,
      normalizeTeacherEditContent(EDITED),
      acceptedWithNote,
      [],
      '孩子独立完成',
    ),
    'confirm',
  );
  assert.equal(
    teacherEditSubmissionAction(
      DRAFT,
      normalizeTeacherEditContent(EDITED),
      acceptedWithNote,
      [],
      '其实教师帮助完成',
    ),
    'review',
    '把备注改成相反事实后必须重新审核',
  );
  assert.equal(
    teacherEditSubmissionAction(DRAFT, normalizeTeacherEditContent(EDITED), acceptedWithNote, [], ''),
    'review',
    '撤回原审核使用的备注后旧审核失效',
  );
  assert.equal(
    teacherEditSubmissionAction(
      DRAFT,
      normalizeTeacherEditContent(EDITED),
      acceptedWithNote,
      [],
      '  孩子独立完成  ',
    ),
    'confirm',
    '备注按服务端规则规范化后比较',
  );
  assert.equal(sameTeacherEditNote({ ...acceptedWithNote, note_snapshot: undefined }, '孩子独立完成'), false);
  passed += 1;

  // 12) 旧审核缺少 note_snapshot：修改内容必须重新审核一次，无崩溃、无永久阻塞
  const legacyNoteReview = reviewWith({});
  delete (legacyNoteReview as Partial<TeacherEditReview>).note_snapshot;
  assert.equal(
    teacherEditSubmissionAction(DRAFT, normalizeTeacherEditContent(EDITED), legacyNoteReview, [], ''),
    'review',
  );
  // 原样 AI 内容仅添加普通备注：保持直接确认，不增加审核
  assert.equal(
    teacherEditSubmissionAction(DRAFT, normalizeTeacherEditContent(DRAFT), legacyNoteReview, [], '记录属实'),
    'confirm',
  );
  assert.equal(
    teacherEditSubmissionAction(DRAFT, normalizeTeacherEditContent(DRAFT), acceptedWithNote, [], '补充说明'),
    'confirm',
  );
  passed += 1;

  // 13) 内容、备注、澄清均未变化：仍可最终确认
  assert.equal(
    teacherEditSubmissionAction(
      DRAFT,
      normalizeTeacherEditContent(EDITED),
      acceptedWithNote,
      [CLARIFICATION],
      '孩子独立完成',
    ),
    'review',
    '澄清快照未绑定时必须重审',
  );
  const fullReview = reviewWith({
    note_snapshot: normalizeTeacherNote('孩子独立完成'),
    clarification_snapshot: clarificationSnapshot([CLARIFICATION]),
  });
  assert.equal(
    teacherEditSubmissionAction(
      DRAFT,
      normalizeTeacherEditContent(EDITED),
      fullReview,
      [CLARIFICATION],
      '孩子独立完成',
    ),
    'confirm',
  );
  assert.equal(
    teacherEditSubmissionAction(
      DRAFT,
      normalizeTeacherEditContent(EDITED),
      fullReview,
      [CLARIFICATION],
      '孩子独立完成',
    ),
    'confirm',
    '重复提交同一审核请求不会绕过确认规则，也不会被误判为失效',
  );
  passed += 1;

  console.log(JSON.stringify({ passed, total: 13 }));
}

void main();
