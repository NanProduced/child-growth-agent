import { config } from 'dotenv';

config({ path: '.env', quiet: true });

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : '未知错误';
  const apiKey = process.env.STEPFUN_API_KEY?.trim() || '';
  return (apiKey ? message.split(apiKey).join('[redacted]') : message).slice(0, 240);
}

async function main(): Promise<void> {
  const configuredProvider = process.env.LLM_PROVIDER?.trim().toLowerCase() || 'coze';
  const configuredModel =
    configuredProvider === 'stepfun'
      ? process.env.STEPFUN_MODEL?.trim() || 'step-5-preview'
      : 'doubao-seed-2-0-lite-260215';

  try {
    const { getLlmProvider, invokeLlm } = await import('../src/lib/llm');
    const { SYSTEM_PROMPT } = await import('../src/lib/ai');
    const { observationDraftSchema } = await import('../src/lib/validation');
    const provider = getLlmProvider();
    const result = await invokeLlm([
      {
        role: 'system',
        content: SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: [
          '幼儿：小雨（女，月龄约 48 个月）',
          '观察日期：2026-09-29',
          '观察情境：建构区',
          '教师原始观察记录（不可增删事实）：',
          '小雨在建构区用三块长积木搭桥。桥面第一次塌下后，她把两块积木并排放在下面支撑，第二次成功后邀请旁边的小朋友一起放小车。',
          '',
          '请整理为观察分析卡片，只输出 JSON 对象。',
        ].join('\n'),
      },
    ]);

    if (provider !== 'stepfun') throw new Error(`provider=${provider}，不是 stepfun`);
    if (result.provider !== 'stepfun') throw new Error(`返回 provider=${result.provider}`);
    if (result.model !== configuredModel || result.model !== 'step-5-preview') {
      throw new Error(`返回 model=${result.model}`);
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(result.content) as unknown;
    } catch {
      throw new Error('模型内容不是有效 JSON');
    }
    const parsed = observationDraftSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new Error(`模型内容未通过 observationDraftSchema：${parsed.error.issues[0]?.message ?? '校验失败'}`);
    }

    console.log(
      JSON.stringify({
        provider: result.provider,
        model: result.model,
        success: true,
        usage: result.usage ?? null,
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        provider: configuredProvider,
        model: configuredModel,
        success: false,
        usage: null,
        error: safeError(error),
      }),
    );
    process.exitCode = 1;
  }
}

void main();
