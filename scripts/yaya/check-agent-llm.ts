/**
 * AGENT1-CORE 模型兼容性回归（离线，不读 .env、不发真实请求）。
 *
 * 证明：
 * 1. 原 6 类 strict json_schema 逐字节哈希回归（修改任一 schema 立即 RED）；
 * 2. 旧文本调用 invokeLlm 行为不变（默认 observation_draft、messages 直传）；
 * 3. invokeChatLlm：文本消息、应用自有 strict schema、usage=null、取消传播；
 * 4. Step 5 Preview 图片字节正确发送；未接入的旧模型零 fetch，不静默换 provider；
 * 5. buildCozeChatMessages 只映射 base64 data URI，不产生/传递 URL；
 * 6. 全部 fetch 由替身截获：真实 provider 请求 0。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import type { ContentPart } from 'coze-coding-dev-sdk';

import {
  buildCozeChatMessages,
  invokeChatLlm,
  invokeLlm,
  LlmAbortedError,
  LlmUnsupportedCapabilityError,
} from '../../src/lib/llm';
import type { LlmChatMessage, LlmResponseType } from '../../src/lib/llm';
import { YAYA_ACTION_WIRE_FORMAT } from '../../src/lib/yaya/agent/types';

type Captured = {
  url: string;
  body: Record<string, unknown>;
  signal: AbortSignal | undefined;
};

const originalFetch = globalThis.fetch;
const originalProvider = process.env.LLM_PROVIDER;
const originalApiKey = process.env.STEPFUN_API_KEY;
const originalModel = process.env.STEPFUN_MODEL;

function installFetch(
  responder?: (captured: Captured) => Response | Promise<Response>,
): { calls: Captured[]; restore: () => void } {
  const calls: Captured[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const captured: Captured = {
      url,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      signal: init?.signal ?? undefined,
    };
    calls.push(captured);
    capturedUrls.push(url);
    return responder ? responder(captured) : chatResponse('{}');
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function chatResponse(content: string, usage?: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      ...(usage === undefined ? {} : { usage }),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const SIX_RESPONSE_TYPES: readonly LlmResponseType[] = [
  'follow_up_decision',
  'observation_draft',
  'teacher_edit_review',
  'growth_profile',
  'activity_support',
  'guide_evidence_suggestion',
];

/** 冻结于 11f87ab 基线的 6 类 response_format（sha256 of JSON.stringify） */
const EXPECTED_STRICT_SCHEMA_HASHES: Record<LlmResponseType, string> = {
  follow_up_decision: 'afc88a4ec76de2336f22c369f173425a0d7688b99219ed1069c89be3926acf47',
  observation_draft: '894df05c85bc722d10fdae95038402acefa276328310da0bcee489b7cb6c1488',
  teacher_edit_review: '0a1ac8668977fc5b32ad471a17d99143c0f0cbc228bf9713556934c9fc8e35a9',
  growth_profile: '57296c5f446501a6a3fe887c0bcf87f1d661ff494f67c516ec69afd72ec818bf',
  activity_support: '6b64319785f79bb373d9bef60390b7cf1aabfc07ab3b41aace8c6cf0f15dc83c',
  guide_evidence_suggestion: '4442b0f46fba7a56854a1b8752f21487049b43a6b57e65b60201b92b578c5572',
};

let passed = 0;
const failures: string[] = [];
const capturedUrls: string[] = [];

async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    passed += 1;
  } catch (error: unknown) {
    failures.push(name);
    console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  process.env.LLM_PROVIDER = 'stepfun';
  process.env.STEPFUN_API_KEY = 'offline-test-key';
  process.env.STEPFUN_MODEL = 'step-5-preview';

  try {
    await check('llm/six-strict-schemas-unchanged', async () => {
      const computed: Record<string, string> = {};
      for (const responseType of SIX_RESPONSE_TYPES) {
        const { calls, restore } = installFetch(() => chatResponse('{}'));
        try {
          await invokeLlm([{ role: 'user', content: 'schema 回归' }], { responseType });
        } finally {
          restore();
        }
        assert.equal(calls.length, 1, `${responseType}: 应只调用一次`);
        const captured = calls[0];
        const format = captured.body.response_format as Record<string, unknown>;
        const jsonSchema = format.json_schema as Record<string, unknown>;
        assert.equal(format.type, 'json_schema', responseType);
        assert.equal(jsonSchema.strict, true, responseType);
        assert.equal(jsonSchema.name, responseType, responseType);
        assert.equal(
          (jsonSchema.schema as Record<string, unknown>).additionalProperties,
          false,
          responseType,
        );
        computed[responseType] = createHash('sha256').update(JSON.stringify(format)).digest('hex');
      }
      assert.deepEqual(
        computed,
        EXPECTED_STRICT_SCHEMA_HASHES,
        `6 类 strict schema 已变化：${JSON.stringify(computed)}`,
      );
    });

    await check('llm/text-call-defaults-unchanged', async () => {
      const { calls, restore } = installFetch(() => chatResponse('{}'));
      try {
        const messages = [
          { role: 'system' as const, content: 's' },
          { role: 'user' as const, content: 'u' },
        ];
        await invokeLlm(messages, {});
        assert.deepEqual(calls[0].body.messages, messages);
        assert.equal(
          ((calls[0].body.response_format as Record<string, unknown>).json_schema as Record<string, unknown>)
            .name,
          'observation_draft',
        );
        assert.equal(calls[0].body.temperature, 0.3);
      } finally {
        restore();
      }
    });

    await check('llm/chat-custom-format-and-usage-null', async () => {
      const controller = new AbortController();
      const { calls, restore } = installFetch(() => chatResponse('{"action":"answer"}'));
      try {
        const messages: LlmChatMessage[] = [
          { role: 'system', content: '系统' },
          { role: 'user', content: '你好' },
        ];
        const result = await invokeChatLlm(messages, {
          responseFormat: YAYA_ACTION_WIRE_FORMAT,
          signal: controller.signal,
        });
        assert.equal(result.usage, null, '未知 usage 必须是 null');
        assert.equal(result.provider, 'stepfun');
        const format = calls[0].body.response_format as Record<string, unknown>;
        assert.equal((format.json_schema as Record<string, unknown>).name, 'yaya_agent_action');
        assert.equal((format.json_schema as Record<string, unknown>).strict, true);
        assert.deepEqual(calls[0].body.messages, [
          { role: 'system', content: '系统' },
          { role: 'user', content: '你好' },
        ]);
        assert.ok(calls[0].signal instanceof AbortSignal, '必须把取消信号传给 fetch');
      } finally {
        restore();
      }
    });

    await check('llm/chat-usage-present', async () => {
      const { calls, restore } = installFetch(() =>
        chatResponse('ok', { input_tokens: 5, output_tokens: 7, total_tokens: 12 }),
      );
      try {
        const result = await invokeChatLlm([{ role: 'user', content: '统计' }], {});
        assert.equal('response_format' in calls[0].body, false, '无格式化要求时不下发 response_format');
        assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 7, totalTokens: 12 });
      } finally {
        restore();
      }
    });

    await check('llm/stepfun-images-unsupported-zero-fetch', async () => {
      process.env.STEPFUN_MODEL = 'step-3.5-flash';
      const { calls, restore } = installFetch(() => chatResponse('不应到达'));
      try {
        await assert.rejects(
          invokeChatLlm([
            {
              role: 'user',
              content: '看看这张图',
              images: [{ media_type: 'image/png', data_base64: 'QUJD' }],
            },
          ]),
          (error: unknown) =>
            error instanceof LlmUnsupportedCapabilityError &&
            error.code === 'unsupported_capability',
        );
        assert.equal(calls.length, 0, 'unsupported 不允许先发请求或静默换 provider');
      } finally {
        process.env.STEPFUN_MODEL = 'step-5-preview';
        restore();
      }
    });

    await check('llm/step5-image-only-strict-schema-and-history', async () => {
      const { calls, restore } = installFetch(() => chatResponse('{"action":"answer"}', { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }));
      try {
        const result = await invokeChatLlm([
          { role: 'user', content: '', images: [{ media_type: 'image/png', data_base64: 'QUJD' }] },
          { role: 'assistant', content: '上一轮回答' },
          { role: 'user', content: '比较两图', images: [{ media_type: 'image/jpeg', data_base64: 'REVG' }, { media_type: 'image/webp', data_base64: 'R0hJ' }] },
        ], { responseFormat: YAYA_ACTION_WIRE_FORMAT });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].body.model, 'step-5-preview');
        const messages = calls[0].body.messages as Array<{ content: string | ContentPart[] }>;
        assert.equal((messages[0].content as ContentPart[])[0].image_url?.url, 'data:image/png;base64,QUJD');
        assert.equal(messages[1].content, '上一轮回答');
        assert.equal((messages[2].content as ContentPart[]).length, 3);
        assert.equal(((calls[0].body.response_format as Record<string, unknown>).json_schema as Record<string, unknown>).strict, true);
        assert.equal(result.provider, 'stepfun');
        assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 8, totalTokens: 20 });
      } finally { restore(); }
    });

    await check('llm/step5-image-error-does-not-fallback', async () => {
      const { calls, restore } = installFetch(() => new Response(JSON.stringify({ error: { message: 'vision unavailable' } }), { status: 400 }));
      try {
        await assert.rejects(invokeChatLlm([{ role: 'user', content: '', images: [{ media_type: 'image/png', data_base64: 'QUJD' }] }]));
        assert.equal(calls.length, 1);
        assert.ok(calls[0].url.startsWith('https://api.stepfun.com/'));
      } finally { restore(); }
    });

    await check('llm/coze-vision-mapping-bytes-only', () => {
      const mapped = buildCozeChatMessages([
        {
          role: 'user',
          content: '描述图片',
          images: [{ media_type: 'image/jpeg', data_base64: 'QUJD' }],
        },
        { role: 'assistant', content: '纯文本' },
      ]);
      assert.equal(mapped.length, 2);
      assert.equal(typeof mapped[1].content, 'string');
      const parts = mapped[0].content as ContentPart[];
      assert.equal(parts.length, 2);
      assert.equal(parts[0].type, 'image_url');
      assert.equal(parts[0].image_url?.url, 'data:image/jpeg;base64,QUJD');
      assert.ok(!String(parts[0].image_url?.url).startsWith('http'));
      assert.equal(parts[1].type, 'text');
      assert.equal(parts[1].text, '描述图片');
    });

    await check('llm/cancellation-propagation', async () => {
      const controller = new AbortController();
      const { calls, restore } = installFetch(
        (captured) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = captured.signal;
            if (!signal) {
              reject(new Error('fetch 缺少 AbortSignal'));
              return;
            }
            const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }),
      );
      try {
        const pending = invokeChatLlm([{ role: 'user', content: '取消我' }], {
          signal: controller.signal,
        });
        setTimeout(() => controller.abort(), 10);
        await assert.rejects(pending, (error: unknown) => error instanceof LlmAbortedError);
        assert.equal(calls.length, 1, '取消前应已实际发起一次请求');
      } finally {
        restore();
      }
    });

    assert.ok(
      capturedUrls.every((url) => url.startsWith('https://api.stepfun.com/')),
      `出现非预期出口：${capturedUrls.filter((url) => !url.startsWith('https://api.stepfun.com/')).join(',')}`,
    );

    console.log(
      JSON.stringify({
        passed,
        total: passed + failures.length,
        failures,
        real_provider_requests: 0,
        captured_destinations: [...new Set(capturedUrls)],
      }),
    );
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    globalThis.fetch = originalFetch;
    if (originalProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = originalProvider;
    if (originalApiKey === undefined) delete process.env.STEPFUN_API_KEY;
    else process.env.STEPFUN_API_KEY = originalApiKey;
    if (originalModel === undefined) delete process.env.STEPFUN_MODEL;
    else process.env.STEPFUN_MODEL = originalModel;
  }
}

void main();
