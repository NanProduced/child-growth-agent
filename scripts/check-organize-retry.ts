import assert from 'node:assert/strict';

import { organizeObservation } from '../src/lib/ai';
import type { LlmMessage, LlmResult } from '../src/lib/llm';
import { isQuoteInRawText } from '../src/lib/validation';

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
  highlight_quote: '把三块长积木并排搭成小桥',
};

function reply(content: string): LlmResult {
  return { content, provider: 'stepfun', model: 'step-5-preview' };
}

async function main(): Promise<void> {
  // 1) 首次非法 domain、第二次合法：重试一次成功，且第二条请求携带明确校验失败原因
  {
    const calls: LlmMessage[][] = [];
    let attempt = 0;
    const result = await organizeObservation(PARAMS, async (messages) => {
      calls.push(structuredClone(messages));
      attempt += 1;
      return attempt === 1
        ? reply(JSON.stringify({ ...VALID_DRAFT, domain: '社会与情感' }))
        : reply(JSON.stringify(VALID_DRAFT));
    });
    assert.equal(result.draft.domain, '科学');
    assert.equal(calls.length, 2);
    const retryMessage = calls[1][calls[1].length - 1].content;
    assert.ok(retryMessage.includes('schema 校验失败'), '重试请求应说明校验失败');
    assert.ok(
      retryMessage.includes('发展领域须为：健康、语言、社会、科学、艺术'),
      '重试请求应携带非法 domain 的具体原因',
    );
  }

  // 2) 非法 domain 永不映射：两次均非法时抛错，不返回草稿
  {
    await assert.rejects(
      organizeObservation(PARAMS, async () => reply(JSON.stringify({ ...VALID_DRAFT, domain: '认知与探究' }))),
      (error: Error) => error.message.includes('AI 整理失败，请重试') && error.message.includes('domain'),
    );
  }

  // 3) 非 JSON 输出：重试一次仍失败时抛清晰错误，且重试请求携带原因
  {
    let calls = 0;
    await assert.rejects(
      organizeObservation(PARAMS, async () => {
        calls += 1;
        return reply('抱歉，我无法整理。');
      }),
      (error: Error) => error.message.includes('输出不是可解析的 JSON'),
    );
    assert.equal(calls, 2);
  }

  // 4) 接口/网络错误：同参数重试一次后仍失败则抛错
  {
    let calls = 0;
    await assert.rejects(
      organizeObservation(PARAMS, async () => {
        calls += 1;
        throw new Error('StepFun 请求失败：fetch failed');
      }),
      (error: Error) => error.message.includes('fetch failed'),
    );
    assert.equal(calls, 2);
  }

  // 5) 首次成功：只调用一次
  {
    let calls = 0;
    const result = await organizeObservation(PARAMS, async () => {
      calls += 1;
      return reply(JSON.stringify(VALID_DRAFT));
    });
    assert.equal(result.draft.domain, '科学');
    assert.equal(calls, 1);
  }

  // 6) 原文不存在的引文被拒绝，重试时给出具体原因；修正后成功
  {
    const calls: LlmMessage[][] = [];
    let attempt = 0;
    const result = await organizeObservation(PARAMS, async (messages) => {
      calls.push(structuredClone(messages));
      attempt += 1;
      return attempt === 1
        ? reply(JSON.stringify({ ...VALID_DRAFT, highlight_quote: '这句话不在原文里。' }))
        : reply(JSON.stringify(VALID_DRAFT));
    });
    assert.equal(result.draft.highlight_quote, VALID_DRAFT.highlight_quote);
    assert.equal(calls.length, 2);
    const retryMessage = calls[1][calls[1].length - 1].content;
    assert.ok(retryMessage.includes('highlight_quote'), '重试请求应说明引文不在原文中');
  }

  // 7) 两次都引用不存在的原文：最终失败，不返回草稿
  {
    let calls = 0;
    await assert.rejects(
      organizeObservation(PARAMS, async () => {
        calls += 1;
        return reply(JSON.stringify({ ...VALID_DRAFT, highlight_quote: '编造的引文。' }));
      }),
      (error: Error) =>
        error.message.includes('AI 整理失败') && error.message.includes('highlight_quote'),
    );
    assert.equal(calls, 2);
  }

  // 8) 诊断性草稿不能保存或展示；普通情绪描述可以通过
  {
    await assert.rejects(
      organizeObservation(PARAMS, async () =>
        reply(JSON.stringify({ ...VALID_DRAFT, objective_description: '幼儿可能存在焦虑症。' })),
      ),
      (error: Error) => error.message.includes('不允许的定性词'),
    );
    let calls = 0;
    const emotional = await organizeObservation(PARAMS, async () => {
      calls += 1;
      return reply(
        JSON.stringify({
          ...VALID_DRAFT,
          objective_description: '幼儿入园时有些焦虑，教师安抚后情绪平稳。',
        }),
      );
    });
    assert.ok(emotional.draft.objective_description.includes('焦虑'));
    assert.equal(calls, 1, '普通情绪描述不应触发重试');
  }

  // 9) 引文格式处理有限：仅允许一层成对引号与空白差异，其余必须逐字一致
  {
    assert.equal(isQuoteInRawText(PARAMS.rawText, '「桥没有倒。」'), true);
    assert.equal(isQuoteInRawText(PARAMS.rawText, '桥没有倒'), true);
    assert.equal(isQuoteInRawText(PARAMS.rawText, '桥 没有倒'), true);
    assert.equal(isQuoteInRawText(PARAMS.rawText, '桥没有倒吗'), false);
  }

  console.log(JSON.stringify({ passed: 9, total: 9 }));
}

void main();
