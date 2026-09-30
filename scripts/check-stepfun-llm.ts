import { config } from 'dotenv';

import type { LlmResult } from '../src/lib/llm';

config({ path: '.env', quiet: true });

type FailureKind = 'network_or_auth' | 'json_parse' | 'schema' | 'content_quality' | 'other';

type Failure = {
  case: string;
  type: FailureKind;
  error: string;
};

type SmokeCase = {
  name: string;
  childName: string;
  childGender: string;
  childBirthDate: string;
  observedAt: string;
  context: string;
  rawText: string;
};

const EXPECTED_PROVIDER = 'stepfun';
const EXPECTED_MODEL = 'step-5-preview';

// Prompt 明令禁止的医疗/诊断/评分词，出现即算内容质量问题
const FORBIDDEN_TERMS = [
  '自闭症',
  '多动症',
  '注意力缺陷',
  '抑郁',
  '焦虑',
  '智商',
  '智力低下',
  '诊断',
  '评分',
  '得分',
];

// 5 个合成案例，覆盖全部五大领域；全部为虚构数据
const CASES: SmokeCase[] = [
  {
    name: '科学/建构',
    childName: '小雨',
    childGender: '女',
    childBirthDate: '2022-09-15',
    observedAt: '2026-09-25',
    context: '建构区',
    rawText:
      '小雨在建构区用三块长积木搭桥。桥面第一次塌下来后，她把两块积木并排放在下面当桥墩，再放上桥面，这次桥没有塌。她请旁边的小朋友把小汽车开上桥，并说“要一个一个过，一起上桥会塌”。',
  },
  {
    name: '语言/表达',
    childName: '乐乐',
    childGender: '男',
    childBirthDate: '2022-05-02',
    observedAt: '2026-09-24',
    context: '阅读区',
    rawText:
      '乐乐在阅读区翻看《好饿的毛毛虫》，边看边给旁边的同伴讲：“它吃了好多东西，肚子疼了，后来变成蝴蝶飞走了。”看到最后一页时他指着蝴蝶对老师说：“老师你看，它变成蝴蝶啦，翅膀是彩色的。”',
  },
  {
    name: '社会/同伴交往',
    childName: '朵朵',
    childGender: '女',
    childBirthDate: '2022-03-18',
    observedAt: '2026-09-23',
    context: '户外游戏',
    rawText:
      '户外滑梯时，朵朵看到新来的小朋友站在滑梯下面不敢上去，就走过去牵他的手说：“别怕，我带你上去。”她先滑下来示范一次，再在滑梯口等他，男孩滑下来后她拍手说：“你看，一点也不怕吧！”',
  },
  {
    name: '健康/动作',
    childName: '小宇',
    childGender: '男',
    childBirthDate: '2021-12-08',
    observedAt: '2026-09-22',
    context: '户外活动',
    rawText:
      '小宇在户外连续练习双脚跳过五个间隔摆放的呼啦圈，中途碰到一个圈后停下来，又退回去重新跳。他跳完后主动把被碰歪的圈摆正，再从头跳了一次，全部跳过后举起手对老师说：“我全部跳过去了！”',
  },
  {
    name: '艺术/表现',
    childName: '果果',
    childGender: '女',
    childBirthDate: '2022-07-21',
    observedAt: '2026-09-21',
    context: '美工区',
    rawText:
      '果果在美工区用红色和黄色的皱纹纸撕成小块，一片一片贴在圆盘上，贴完对老师说：“这是我的太阳花，中间是黄色的花心，旁边是红色的花瓣。”她还给花朵下面画了绿色的茎和两片叶子。',
  },
];

function redact(value: string): string {
  const apiKey = process.env.STEPFUN_API_KEY?.trim() || '';
  return (apiKey ? value.split(apiKey).join('[redacted]') : value).slice(0, 200);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function llmFailureKind(message: string): FailureKind {
  if (/未配置|请求失败/.test(message)) return 'network_or_auth';
  return 'other';
}

async function main(): Promise<void> {
  // 本 smoke test 只验证 StepFun：仅在当前进程内覆盖 provider/model，不改应用默认值
  process.env.LLM_PROVIDER = EXPECTED_PROVIDER;
  process.env.STEPFUN_MODEL = EXPECTED_MODEL;

  const { buildOrganizeMessages } = await import('../src/lib/ai');
  const { invokeLlm } = await import('../src/lib/llm');
  const { FIVE_DOMAINS } = await import('../src/lib/types');
  const { observationDraftSchema } = await import('../src/lib/validation');

  const failures: Failure[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let hasUsage = false;
  let passed = 0;

  for (const item of CASES) {
    let result: LlmResult;
    try {
      result = await invokeLlm(
        buildOrganizeMessages({
          childName: item.childName,
          childGender: item.childGender,
          childBirthDate: item.childBirthDate,
          observedAt: item.observedAt,
          context: item.context,
          rawText: item.rawText,
        }),
        { temperature: 0.3 },
      );
    } catch (error) {
      const message = errorText(error);
      failures.push({ case: item.name, type: llmFailureKind(message), error: redact(message) });
      continue;
    }

    if (result.usage) {
      hasUsage = true;
      usage.inputTokens += result.usage.inputTokens ?? 0;
      usage.outputTokens += result.usage.outputTokens ?? 0;
      usage.totalTokens += result.usage.totalTokens ?? 0;
    }

    if (result.provider !== EXPECTED_PROVIDER) {
      failures.push({ case: item.name, type: 'other', error: `provider=${result.provider}` });
      continue;
    }
    if (result.model !== EXPECTED_MODEL) {
      failures.push({ case: item.name, type: 'other', error: `model=${redact(result.model)}` });
      continue;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(result.content) as unknown;
    } catch {
      failures.push({ case: item.name, type: 'json_parse', error: '返回内容不是合法 JSON' });
      continue;
    }

    const parsed = observationDraftSchema.safeParse(parsedJson);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.join('.') || '输出';
      let error = `${where}：${issue?.message || '校验失败'}`;
      if (where === 'domain' && typeof parsedJson === 'object' && parsedJson !== null) {
        const received = (parsedJson as { domain?: unknown }).domain;
        error += `；实际值：${JSON.stringify(received ?? null).slice(0, 80)}`;
      }
      failures.push({ case: item.name, type: 'schema', error: redact(error) });
      continue;
    }
    if (!(FIVE_DOMAINS as readonly string[]).includes(parsed.data.domain)) {
      failures.push({ case: item.name, type: 'schema', error: `非法 domain：${parsed.data.domain}` });
      continue;
    }

    const forbidden = FORBIDDEN_TERMS.find((term) => result.content.includes(term));
    if (forbidden) {
      failures.push({ case: item.name, type: 'content_quality', error: `出现禁用词「${forbidden}」` });
      continue;
    }

    passed += 1;
  }

  console.log(
    JSON.stringify(
      {
        passed,
        total: CASES.length,
        provider: EXPECTED_PROVIDER,
        model: EXPECTED_MODEL,
        usage: hasUsage ? usage : null,
        failures,
      },
      null,
      2,
    ),
  );
  if (failures.length > 0) process.exitCode = 1;
}

void main();
