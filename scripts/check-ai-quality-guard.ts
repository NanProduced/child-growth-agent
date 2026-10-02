import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 评测器停止机制与账本的离线检查（不发送任何真实请求）。
 * 每个场景在独立临时目录使用独立账本，绝不触碰 logs/ai-quality 的真实预算。
 */

const SCRIPT = fileURLToPath(import.meta.url);

type ScenarioName =
  | 'ledger-missing'
  | 'ledger-corrupt-json'
  | 'ledger-corrupt-fields'
  | 'budget-one-retry'
  | 'fatal-first'
  | 'timeout-twice'
  | 'fail-record'
  | 'long-first-output';

type Scenario = {
  name: ScenarioName;
  cases: string;
  ledger:
    | { kind: 'missing' }
    | { kind: 'raw'; body: string }
    | { kind: 'json'; body: Record<string, unknown> };
  expectStop?: 'budget' | 'fatal' | 'timeout';
  expectedExit: number;
  invokedCalls: number;
  verify: (records: Record<string, unknown>[], workDir: string) => void;
};

function findRecord(
  records: Record<string, unknown>[],
  caseId: string,
  version = 'candidate',
): Record<string, unknown> {
  const record = records.find((item) => item.caseId === caseId && item.version === version);
  assert.ok(record, `缺少记录 ${caseId}`);
  return record;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'ledger-missing',
    cases: 'FU1',
    ledger: { kind: 'missing' },
    expectedExit: 5,
    invokedCalls: 0,
    verify: (records) => {
      assert.equal(records.length, 0, '账本缺失时不得产生请求记录');
    },
  },
  {
    name: 'ledger-corrupt-json',
    cases: 'FU1',
    ledger: { kind: 'raw', body: '{broken json' },
    expectedExit: 5,
    invokedCalls: 0,
    verify: (records) => assert.equal(records.length, 0),
  },
  {
    name: 'ledger-corrupt-fields',
    cases: 'FU1',
    ledger: { kind: 'json', body: { version: 1, total: 40, used: -1 } },
    expectedExit: 5,
    invokedCalls: 0,
    verify: (records) => assert.equal(records.length, 0),
  },
  {
    name: 'budget-one-retry',
    cases: 'FU1,FU2',
    ledger: { kind: 'json', body: { version: 1, total: 40, used: 39 } },
    expectedExit: 3,
    invokedCalls: 1,
    verify: (records) => {
      const fu1 = findRecord(records, 'FU1');
      assert.equal(fu1.status, 'budget');
      const attempts = fu1.attempts as Record<string, unknown>[];
      assert.equal(attempts.length, 1, '预算只剩一次时第二次请求不得发出');
      assert.equal(attempts[0].ok, true, '第一次输出必须完整保留');
      assert.equal(typeof attempts[0].content, 'string');
      assert.ok(Number(attempts[0].ms) > 0, '失败任务必须保留实际耗时');
      const fu2 = findRecord(records, 'FU2');
      assert.equal(fu2.status, 'NOT_RUN');
    },
  },
  {
    name: 'fatal-first',
    cases: 'FU1,FU2',
    ledger: { kind: 'json', body: { version: 1, total: 40, used: 0 } },
    expectedExit: 2,
    invokedCalls: 1,
    verify: (records) => {
      const fu1 = findRecord(records, 'FU1');
      assert.equal(fu1.status, 'fatal');
      assert.equal((fu1.attempts as unknown[]).length, 1, '认证失败后不得再发第二次请求');
      const fu2 = findRecord(records, 'FU2');
      assert.equal(fu2.status, 'NOT_RUN');
    },
  },
  {
    name: 'timeout-twice',
    cases: 'FU1,FU2',
    ledger: { kind: 'json', body: { version: 1, total: 40, used: 0 } },
    expectedExit: 4,
    invokedCalls: 2,
    verify: (records) => {
      const fu1 = findRecord(records, 'FU1');
      assert.equal(fu1.status, 'timeout');
      assert.equal((fu1.attempts as unknown[]).length, 2, '两次实际超时后必须停止');
      const fu2 = findRecord(records, 'FU2');
      assert.equal(fu2.status, 'NOT_RUN', '两次超时后不得进入下一任务');
    },
  },
  {
    name: 'fail-record',
    cases: 'FU1',
    ledger: { kind: 'json', body: { version: 1, total: 40, used: 0 } },
    expectedExit: 0,
    invokedCalls: 2,
    verify: (records, workDir) => {
      const fu1 = findRecord(records, 'FU1');
      assert.equal(fu1.status, 'error');
      const attempts = fu1.attempts as Record<string, unknown>[];
      assert.equal(attempts.length, 2);
      assert.ok(Number(fu1.ms) > 0, '失败任务不得写 0 耗时');
      assert.ok(String(fu1.error).includes('失败'), '失败任务应保留错误信息');
      assert.equal(attempts[0].usage, null, 'usage 不可用必须为 null，不能填 0');
      assert.equal(typeof attempts[0].messagesHash, 'string');
      assert.ok(existsSync(workDir), '稳定目录必须保留');
      const files = readdirSync(workDir).filter((name) => name.startsWith('real-'));
      assert.ok(files.length > 0, '结果文件必须落在稳定目录');
    },
  },
  {
    name: 'long-first-output',
    cases: 'O1',
    ledger: { kind: 'json', body: { version: 1, total: 40, used: 0 } },
    expectedExit: 0,
    invokedCalls: 1,
    verify: (records) => {
      const o1 = findRecord(records, 'O1');
      assert.equal(o1.status, 'ok');
      const attempts = o1.attempts as Record<string, unknown>[];
      const content = String(attempts[0].content ?? '');
      assert.ok(content.length > 2000, '首次输出超过 2000 字符也必须完整保留');
      const output = o1.output as Record<string, unknown>;
      assert.equal(output.domain, '健康');
    },
  },
];

async function runChild(scenario: Scenario, workDir: string): Promise<{ status: number; stdout: string; stderr: string; invoked: number }> {
  const args = [
    '--experimental-test-module-mocks',
    '--no-warnings',
    '--import',
    'tsx',
    SCRIPT,
    `--scenario=${scenario.name}`,
    `--work-dir=${workDir}`,
    `--cases=${scenario.cases}`,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, AI_QUALITY_SKIP_AUTO: '0' },
  });
  const marker = join(workDir, 'invoked.marker');
  const invoked = existsSync(marker)
    ? readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).length
    : 0;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    invoked,
  };
}

async function runScenarioChild(scenario: Scenario, workDir: string): Promise<void> {
  process.env.AI_QUALITY_SKIP_AUTO = '1';
  process.env.AI_QUALITY_WORK_DIR = workDir;
  process.env.STEPFUN_API_KEY = 'mock-key';
  const argCases = process.argv.find((arg) => arg.startsWith('--cases='))?.slice('--cases='.length) ?? 'FU1';

  const marker = join(workDir, 'invoked.marker');
  const recordInvocation = () => {
    mkdirSync(workDir, { recursive: true });
    writeFileSync(marker, `${Date.now()}\n`, { flag: 'a' });
  };

  const longDraft = {
    domain: '健康',
    sub_domain: '生活自理',
    objective_description: '健康活动后的具体表现记录。'.repeat(80).slice(0, 950),
    highlights: [
      '自己走到阴凉处坐下喝水。'.repeat(30).slice(0, 290),
      '向教师表达继续活动的意愿。'.repeat(30).slice(0, 290),
      '休息后回到同伴中继续活动。'.repeat(30).slice(0, 290),
    ],
    support_suggestions: [
      '在活动间隙提示饮水位置。'.repeat(30).slice(0, 290),
      '用具体语言回应幼儿的身体感受。'.repeat(30).slice(0, 290),
      '继续提供阴凉休息区。'.repeat(30).slice(0, 290),
    ],
    highlight_quote: '我不热了，还想玩',
  };

  const { mock } = await import('node:test');
  const mockModule = mock as unknown as {
    module: (specifier: string, options: { exports: Record<string, unknown> }) => void;
  };
  mockModule.module('@/lib/llm', {
    exports: {
      COZE_ORGANIZE_MODEL: 'mock-model',
      getLlmProvider: () => 'stepfun',
      getLlmModel: () => 'mock-model',
      invokeLlm: async () => {
        recordInvocation();
        // 模拟真实请求的最小耗时，保证耗时字段不是固定零值
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (scenario.name === 'fatal-first') {
          throw new Error('StepFun 请求失败：HTTP 401 Unauthorized');
        }
        if (scenario.name === 'timeout-twice') {
          throw new Error('StepFun 请求超时（60000ms），请稍后重试');
        }
        if (scenario.name === 'long-first-output') {
          return { content: JSON.stringify(longDraft), provider: 'stepfun', model: 'mock-model' };
        }
        return { content: 'not-json', provider: 'stepfun', model: 'mock-model' };
      },
    },
  });

  const workDirArg = process.argv.find((arg) => arg.startsWith('--work-dir='))?.slice('--work-dir='.length);
  process.argv = [
    'node',
    'check-ai-quality',
    '--real',
    `--work-dir=${workDirArg ?? workDir}`,
    `--cases=${argCases}`,
    '--versions=candidate',
  ];
  const runner = await import('./check-ai-quality');
  try {
    await runner.main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 5;
  }
}

async function main(): Promise<void> {
  const scenarioArg = process.argv.find((arg) => arg.startsWith('--scenario='))?.slice('--scenario='.length);
  if (scenarioArg) {
    const workDirArg = process.argv.find((arg) => arg.startsWith('--work-dir='))?.slice('--work-dir='.length) ?? '';
    const scenario = SCENARIOS.find((item) => item.name === scenarioArg);
    assert.ok(scenario, `未知场景 ${scenarioArg}`);
    await runScenarioChild(scenario, workDirArg);
    return;
  }

  let passed = 0;
  for (const scenario of SCENARIOS) {
    const workDir = mkdtempSync(join(tmpdir(), `aiq-${scenario.name}-`));
    if (scenario.ledger.kind === 'raw') {
      writeFileSync(join(workDir, 'budget.json'), scenario.ledger.body);
    } else if (scenario.ledger.kind === 'json') {
      writeFileSync(join(workDir, 'budget.json'), JSON.stringify(scenario.ledger.body));
    }
    try {
      const child = await runChild(scenario, workDir);
      const records = readdirSync(workDir)
        .filter((name) => name.startsWith('real-') && name.endsWith('.jsonl'))
        .flatMap((name) =>
          readFileSync(join(workDir, name), 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>),
        );
      assert.equal(child.invoked, scenario.invokedCalls, `${scenario.name}: 实际请求次数应为 ${scenario.invokedCalls}`);
      assert.equal(child.status, scenario.expectedExit, `${scenario.name}: 退出码应为 ${scenario.expectedExit}`);
      scenario.verify(records, workDir);
      console.log(`ok ${scenario.name}`);
      passed += 1;
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify({ passed, total: SCENARIOS.length }));
}

void main();
