import 'dotenv/config';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as baseline from '../src/lib/ai-baseline';
import * as candidate from '../src/lib/ai';
import { AI_QUALITY_CASES, type AutoCheck, type EvalCase } from './ai-quality-cases';
import { getLlmModel, getLlmProvider, invokeLlm } from '../src/lib/llm';
import type { LlmMessage, LlmOptions, LlmResult } from '../src/lib/llm';

/**
 * AI-R2 内容质量评测：
 * - 默认离线：校验 15 个案例定义、两个真实版本的 Prompt 差异；
 * - --real：用本地 .env 的 StepFun 串行跑 15 案例 × 新旧两版（预算 ≤ 40 次请求），
 *   结果逐条落盘，遇到认证/额度/模型不可用或连续两次超时立即停止。
 * 不打印密钥、请求头或隐藏推理内容；不连接托管数据库。
 */

const VERSIONS = [
  { id: 'baseline-07d5224', module: baseline },
  { id: 'candidate', module: candidate },
] as const;

const BUDGET_TOTAL = 40;
const WORK_DIR = join(process.cwd(), '.next', 'ai-quality-eval');
const BUDGET_FILE = join(WORK_DIR, 'budget.json');

function ensureWorkDir(): void {
  mkdirSync(WORK_DIR, { recursive: true });
}

function readBudget(): number {
  if (!existsSync(BUDGET_FILE)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(BUDGET_FILE, 'utf8')) as { used?: number };
    return Number.isFinite(parsed.used) ? Number(parsed.used) : 0;
  } catch {
    return 0;
  }
}

function writeBudget(used: number): void {
  ensureWorkDir();
  writeFileSync(BUDGET_FILE, JSON.stringify({ used, updatedAt: new Date().toISOString() }));
}

function outputText(caseTask: EvalCase['task'], output: Record<string, unknown>): string {
  if (caseTask === 'follow_up') {
    return `${String(output.decision)} ${String(output.question ?? '')} ${String(output.reason ?? '')}`;
  }
  return JSON.stringify(output);
}

function evaluateChecks(checks: AutoCheck[], output: Record<string, unknown>, text: string): {
  passed: number;
  results: Array<{ check: AutoCheck; ok: boolean }>;
} {
  const results = checks.map((check) => {
    let ok = false;
    if (check.type === 'decision') {
      ok = output.decision === check.value;
    } else if (check.type === 'requiresAny') {
      ok = check.terms.some((term) => text.includes(term));
    } else if (check.type === 'forbidsAny') {
      ok = check.terms.every((term) => !text.includes(term));
    } else if (check.type === 'countBetween') {
      const value = output[check.field];
      ok = Array.isArray(value) && value.length >= check.min && value.length <= check.max;
    }
    return { check, ok };
  });
  return { passed: results.filter((item) => item.ok).length, results };
}

function validateCases(): number {
  assert.equal(AI_QUALITY_CASES.length, 15, '案例总数必须为 15');
  const byTask = (task: EvalCase['task']) => AI_QUALITY_CASES.filter((item) => item.task === task);
  assert.equal(byTask('follow_up').length, 3, '追问案例必须为 3 个');
  assert.equal(byTask('organize').length, 5, '整理案例必须为 5 个');
  assert.equal(byTask('review').length, 2, '修改复核案例必须为 2 个');
  assert.equal(byTask('growth').length, 3, '成长小结案例必须为 3 个');
  assert.equal(byTask('activity').length, 2, '活动支持案例必须为 2 个');
  const stages = new Set(AI_QUALITY_CASES.map((item) => item.stage));
  assert.deepEqual([...stages].sort(), ['large', 'middle', 'small'], '需覆盖小/中/大班');
  const organizeTitles = byTask('organize').map((item) => item.title).join('|');
  for (const domain of ['健康', '语言', '社会', '科学', '艺术']) {
    assert.ok(organizeTitles.includes(domain), `整理案例需覆盖${domain}领域`);
  }
  for (const item of AI_QUALITY_CASES) {
    assert.ok(item.expectation.trim().length > 0, `${item.id} 缺少预期行为`);
    assert.ok(item.forbiddenInference.trim().length > 0, `${item.id} 缺少禁止推断`);
    assert.ok(item.autoChecks.length > 0, `${item.id} 缺少自动检查`);
  }
  return 6;
}

function validateVersions(): number {
  assert.notEqual(baseline.SYSTEM_PROMPT, candidate.SYSTEM_PROMPT, '整理 Prompt 必须存在版本差异');
  assert.notEqual(
    baseline.FOLLOW_UP_SYSTEM_PROMPT,
    candidate.FOLLOW_UP_SYSTEM_PROMPT,
    '追问 Prompt 必须存在版本差异',
  );
  assert.notEqual(
    baseline.TEACHER_EDIT_REVIEW_SYSTEM_PROMPT,
    candidate.TEACHER_EDIT_REVIEW_SYSTEM_PROMPT,
    '修改复核 Prompt 必须存在版本差异',
  );
  assert.notEqual(
    baseline.GROWTH_PROFILE_SYSTEM_PROMPT,
    candidate.GROWTH_PROFILE_SYSTEM_PROMPT,
    '成长小结 Prompt 必须存在版本差异',
  );
  assert.notEqual(
    baseline.ACTIVITY_SUPPORT_SYSTEM_PROMPT,
    candidate.ACTIVITY_SUPPORT_SYSTEM_PROMPT,
    '活动支持 Prompt 必须存在版本差异',
  );
  return 5;
}

class BudgetExhaustedError extends Error {
  constructor() {
    super('评测请求预算已用尽');
    this.name = 'BudgetExhaustedError';
  }
}

type AttemptRecord = {
  ms: number;
  ok: boolean;
  content?: string;
  usage?: unknown;
};

/** 只取任务函数：新旧模块的 Prompt 常量字面量不同，不参与结构比较 */
type TaskModule = Pick<
  typeof candidate,
  | 'judgeFollowUp'
  | 'organizeObservation'
  | 'reviewTeacherEdit'
  | 'generateGrowthProfile'
  | 'generateActivitySupport'
>;

async function runCase(
  evalCase: EvalCase,
  versionId: string,
  module: TaskModule,
  takeBudget: () => number,
): Promise<Record<string, unknown>> {
  const attempts: AttemptRecord[] = [];
  let retryFeedback: string | null = null;
  const countedInvoke = async (messages: LlmMessage[], options: LlmOptions = {}): Promise<LlmResult> => {
    if (attempts.length > 0) {
      const last = messages[messages.length - 1]?.content ?? '';
      if (last.startsWith('上一次输出未通过校验：')) {
        retryFeedback = last.slice(0, 300);
      }
    }
    takeBudget();
    const started = Date.now();
    try {
      const result = await invokeLlm(messages, options);
      attempts.push({
        ms: Date.now() - started,
        ok: true,
        content: result.content.slice(0, 2000),
        usage: result.usage ?? null,
      });
      return result;
    } catch (error) {
      attempts.push({ ms: Date.now() - started, ok: false });
      throw error;
    }
  };

  const startedAt = Date.now();
  let output: Record<string, unknown>;
  let model = '';
  if (evalCase.input.kind === 'follow_up') {
    const result = await module.judgeFollowUp(evalCase.input.params, countedInvoke);
    output = result.decision as unknown as Record<string, unknown>;
    model = result.model;
  } else if (evalCase.input.kind === 'organize') {
    const result = await module.organizeObservation(evalCase.input.params, countedInvoke);
    output = result.draft as unknown as Record<string, unknown>;
    model = result.model;
  } else if (evalCase.input.kind === 'review') {
    const result = await module.reviewTeacherEdit(evalCase.input.params, countedInvoke);
    output = result.review as unknown as Record<string, unknown>;
    model = result.model;
  } else if (evalCase.input.kind === 'growth') {
    const result = await module.generateGrowthProfile(evalCase.input.params, countedInvoke);
    output = result.profile as unknown as Record<string, unknown>;
    model = result.model;
  } else {
    const result = await module.generateActivitySupport(evalCase.input.params, countedInvoke);
    output = result.activitySupport as unknown as Record<string, unknown>;
    model = result.model;
  }

  const text = outputText(evalCase.task, output);
  const checks = evaluateChecks(evalCase.autoChecks, output, text);
  return {
    caseId: evalCase.id,
    task: evalCase.task,
    stage: evalCase.stage,
    version: versionId,
    status: 'ok',
    model,
    attempts: attempts.length,
    firstOutput: attempts[0]?.content ?? null,
    finalUsage: attempts[attempts.length - 1]?.usage ?? null,
    retryFeedback,
    ms: Date.now() - startedAt,
    output,
    checksPassed: checks.passed,
    checksTotal: checks.results.length,
    checksFailed: checks.results.filter((item) => !item.ok).map((item) => item.check),
  };
}

function classifyError(message: string): 'fatal' | 'timeout' | 'error' {
  if (/HTTP\s*(401|403|429)|认证|鉴权|未授权|额度|quota|unauthorized|forbidden/i.test(message)) {
    return 'fatal';
  }
  if (/超时|timeout/i.test(message)) return 'timeout';
  return 'error';
}

async function runReal(): Promise<void> {
  const provider = getLlmProvider();
  if (provider !== 'stepfun') {
    throw new Error(`真实评测需要本地 .env 的 LLM_PROVIDER=stepfun，当前为 ${provider}；未发送任何请求`);
  }
  if (!process.env.STEPFUN_API_KEY?.trim()) {
    throw new Error('真实评测需要本地 .env 配置 STEPFUN_API_KEY；未发送任何请求');
  }
  ensureWorkDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsFile = join(WORK_DIR, `real-${stamp}.jsonl`);
  const latestFile = join(WORK_DIR, 'real-latest.json');
  let used = readBudget();
  writeBudget(used);
  const runMeta = {
    startedAt: new Date().toISOString(),
    provider,
    model: getLlmModel(provider),
    budgetTotal: BUDGET_TOTAL,
    budgetUsedBeforeRun: used,
  };
  const records: Record<string, unknown>[] = [];
  let consecutiveTimeouts = 0;
  let stopped: string | null = null;

  const takeBudget = (): number => {
    if (used >= BUDGET_TOTAL) throw new BudgetExhaustedError();
    used += 1;
    writeBudget(used);
    return used;
  };

  const caseArg = process.argv.find((arg) => arg.startsWith('--cases='))?.slice('--cases='.length);
  const versionArg = process.argv
    .find((arg) => arg.startsWith('--versions='))
    ?.slice('--versions='.length);
  const caseFilter = caseArg ? new Set(caseArg.split(',').map((item) => item.trim())) : null;
  const versionFilter = versionArg
    ? new Set(versionArg.split(',').map((item) => item.trim()))
    : null;
  const selectedCases = AI_QUALITY_CASES.filter((item) => !caseFilter || caseFilter.has(item.id));
  const selectedVersions = VERSIONS.filter((item) => !versionFilter || versionFilter.has(item.id));

  outer: for (const evalCase of selectedCases) {
    for (const version of selectedVersions) {
      try {
        const record = await runCase(evalCase, version.id, version.module, takeBudget);
        if (record.status === 'ok') consecutiveTimeouts = 0;
        records.push({ ...runMeta, ...record });
        appendFileSync(resultsFile, `${JSON.stringify({ ...runMeta, ...record })}\n`);
        const flag = record.checksPassed === record.checksTotal ? 'checks-ok' : 'checks-fail';
        console.log(
          `[${version.id}] ${evalCase.id} ok req=${record.attempts} ms=${record.ms} ${flag} ${record.checksPassed}/${record.checksTotal}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof BudgetExhaustedError) {
          stopped = 'budget';
          break outer;
        }
        const kind = classifyError(message);
        const record = {
          ...runMeta,
          caseId: evalCase.id,
          task: evalCase.task,
          version: version.id,
          status: kind === 'fatal' ? 'fatal' : kind === 'timeout' ? 'timeout' : 'error',
          error: message.slice(0, 400),
          ms: 0,
          attempts: 0,
        };
        records.push(record);
        appendFileSync(resultsFile, `${JSON.stringify(record)}\n`);
        console.log(`[${version.id}] ${evalCase.id} ${record.status}: ${record.error}`);
        if (kind === 'fatal') {
          stopped = 'fatal';
          break outer;
        }
        if (kind === 'timeout') {
          consecutiveTimeouts += 1;
          if (consecutiveTimeouts >= 2) {
            stopped = 'timeout';
            break outer;
          }
        }
      }
    }
  }

  const summary = {
    ...runMeta,
    finishedAt: new Date().toISOString(),
    budgetUsedAfterRun: used,
    stopped,
    total: records.length,
    ok: records.filter((item) => item.status === 'ok').length,
    byVersion: VERSIONS.map((version) => ({
      version: version.id,
      ok: records.filter((item) => item.version === version.id && item.status === 'ok').length,
      checksPassed: records
        .filter((item) => item.version === version.id && item.status === 'ok')
        .reduce((sum, item) => sum + Number(item.checksPassed ?? 0), 0),
      checksTotal: records
        .filter((item) => item.version === version.id && item.status === 'ok')
        .reduce((sum, item) => sum + Number(item.checksTotal ?? 0), 0),
    })),
    resultsFile,
  };
  writeFileSync(latestFile, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  if (stopped === 'fatal') process.exitCode = 2;
}

function runOffline(): void {
  const casesPassed = validateCases();
  const versionsPassed = validateVersions();
  console.log(`ok eval-cases (${casesPassed})`);
  console.log(`ok eval-versions (${versionsPassed})`);
  console.log(JSON.stringify({ passed: casesPassed + versionsPassed, total: casesPassed + versionsPassed }));
}

async function main(): Promise<void> {
  if (process.argv.includes('--real')) {
    await runReal();
    return;
  }
  runOffline();
}

void main();
