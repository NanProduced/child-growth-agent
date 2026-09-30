import assert from 'node:assert/strict';

import {
  buildOrganizeMessages,
  organizeObservation,
} from '../src/lib/ai';
import {
  DEFAULT_STEPFUN_TIMEOUT_MS,
  getStepFunTimeoutMs,
} from '../src/lib/llm';

const PARAMS = {
  childName: '测试幼儿',
  childGender: '女',
  childBirthDate: '2022-01-01',
  observedAt: '2026-09-30',
  context: '建构区',
  rawText: '测试幼儿把两块积木并排放在桥面下方，推动小车通过并说这样不会塌。',
};

const VALID_DRAFT = {
  domain: '科学',
  sub_domain: '科学观察',
  objective_description: '幼儿通过调整支撑位置观察桥面变化。',
  highlights: ['把两块积木并排放在桥面下方。'],
  support_suggestions: ['提供不同形状的积木继续观察。'],
  highlight_quote: '这样不会塌。',
};

function response(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(VALID_DRAFT) } }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function pendingFetch(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    const signal = init?.signal;
    const timer = setTimeout(() => reject(new Error('test timeout guard')), 10_000);
    const rejectOnAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('timed out', 'TimeoutError'));
    };
    if (!signal) {
      clearTimeout(timer);
      reject(new Error('test fetch missing AbortSignal'));
      return;
    }
    if (signal.aborted) rejectOnAbort();
    else signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
}

async function main(): Promise<void> {
  const originalProvider = process.env.LLM_PROVIDER;
  const originalApiKey = process.env.STEPFUN_API_KEY;
  const originalTimeout = process.env.STEPFUN_TIMEOUT_MS;
  const originalFetch = globalThis.fetch;
  let passed = 0;

  try {
    process.env.LLM_PROVIDER = 'stepfun';
    process.env.STEPFUN_API_KEY = 'offline-test-key';
    process.env.STEPFUN_TIMEOUT_MS = '1000';

    assert.equal(getStepFunTimeoutMs(), 1000);
    for (const value of ['', '0', '999', '120001', 'not-a-number', '1.5']) {
      process.env.STEPFUN_TIMEOUT_MS = value;
      assert.equal(getStepFunTimeoutMs(), DEFAULT_STEPFUN_TIMEOUT_MS);
    }
    process.env.STEPFUN_TIMEOUT_MS = '1000';
    passed += 1;

    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls += 1;
      if (calls === 1) return pendingFetch(init);
      return response();
    };
    const retried = await organizeObservation(PARAMS);
    assert.equal(retried.draft.domain, '科学');
    assert.equal(calls, 2);
    passed += 1;

    calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls += 1;
      return pendingFetch(init);
    };
    const startedAt = Date.now();
    await assert.rejects(
      organizeObservation({ ...PARAMS, rawText: `${PARAMS.rawText} 第二次超时` }),
      (error: Error) =>
        error.message.includes('AI 整理失败') && error.message.includes('StepFun 请求超时'),
    );
    assert.equal(calls, 2);
    assert.ok(Date.now() - startedAt < 5000, '两次超时后应快速结束');
    passed += 1;

    console.log(JSON.stringify({ passed, total: 3 }));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = originalProvider;
    if (originalApiKey === undefined) delete process.env.STEPFUN_API_KEY;
    else process.env.STEPFUN_API_KEY = originalApiKey;
    if (originalTimeout === undefined) delete process.env.STEPFUN_TIMEOUT_MS;
    else process.env.STEPFUN_TIMEOUT_MS = originalTimeout;
  }
}

void main();
