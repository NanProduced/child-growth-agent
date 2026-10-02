import 'dotenv/config';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as baseline from '../src/lib/ai-baseline';
import * as candidate from '../src/lib/ai';
import {
  AI_QUALITY_CASES,
  AI_QUALITY_RUBRIC_VERSION,
  type AutoCheck,
  type EvalCase,
} from './ai-quality-cases';
import { getLlmModel, getLlmProvider, invokeLlm } from '../src/lib/llm';
import type { LlmMessage, LlmOptions, LlmResult } from '../src/lib/llm';

/**
 * AI-R2 内容质量评测：
 * - 默认离线：校验 15 个案例定义、评审标准版本与两个真实 Prompt 版本的差异；
 * - --real：用本地 .env 的 StepFun 串行跑案例（新旧对照），预算跨进程累计、稳定落盘。
 * 产物与账本在 logs/ai-quality/（已 gitignore，构建不会清理）；
 * 不出现在屏幕的完整输出、usage 与消息哈希均逐条写入结果文件。
 * 不打印密钥、请求头、完整配置或隐藏推理内容；不连接托管数据库。
 */

const BUDGET_TOTAL = 40;
const DEFAULT_WORK_DIR = join(process.cwd(), 'logs', 'ai-quality');
const VERSIONS = [
  { id: 'baseline-07d5224', module: baseline },
  { id: 'candidate', module: candidate },
] as const;

type StopReason = 'budget' | 'fatal' | 'timeout' | null;

type BudgetLedger = {
  version: 1;
  total: number;
  used: number;
  updatedAt: string;
  recovery?: {
    used: number;
    source: string;
    verified: false;
    recoveredAt: string;
  };
};

type AttemptRecord = {
  index: number;
  ms: number;
  ok: boolean;
  content?: string;
  usage?: unknown;
  error?: string;
  messagesHash: string;
};

class EvaluationStoppedError extends Error {
  constructor(reason: Exclude<StopReason, null>) {
    super(`评测已停止（${reason}）`);
    this.name = 'EvaluationStoppedError';
  }
}

function resolveWorkDir(argv: string[]): string {
  const cli = argv.find((arg) => arg.startsWith('--work-dir='))?.slice('--work-dir='.length).trim();
  const env = process.env.AI_QUALITY_WORK_DIR?.trim();
  return cli || env || DEFAULT_WORK_DIR;
}

function ledgerFile(workDir: string): string {
  return join(workDir, 'budget.json');
}

type LedgerResult =
  | { ok: true; ledger: BudgetLedger }
  | { ok: false; reason: string };

function readLedger(workDir: string): LedgerResult {
  const file = ledgerFile(workDir);
  if (!existsSync(file)) return { ok: false, reason: '账本不存在' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, reason: '账本不是合法 JSON' };
  }
  const record = parsed as Record<string, unknown>;
  if (record.total !== BUDGET_TOTAL) {
    return { ok: false, reason: `total 非法：${String(record.total)}` };
  }
  const used = record.used;
  if (typeof used !== 'number' || !Number.isInteger(used) || used < 0 || used > BUDGET_TOTAL) {
    return { ok: false, reason: `used 非法：${String(used)}` };
  }
  return { ok: true, ledger: parsed as BudgetLedger };
}

function writeLedger(workDir: string, ledger: BudgetLedger): void {
  mkdirSync(workDir, { recursive: true });
  writeFileSync(ledgerFile(workDir), JSON.stringify(ledger, null, 2));
}

/**
 * 显式恢复账本：仅当现有账本缺失或损坏时允许，且必须注明来源；
 * 不自动创建新审批轮次，不扩大预算。
 */
function recoverBudget(workDir: string, argv: string[]): void {
  const existing = readLedger(workDir);
  if (existing.ok) {
    throw new Error('账本已存在且合法，拒绝覆盖；如需修订请先人工核对');
  }
  const usedRaw = argv.find((arg) => arg.startsWith('--recover-budget='))?.slice('--recover-budget='.length);
  const source = argv.find((arg) => arg.startsWith('--recover-source='))?.slice('--recover-source='.length);
  const used = Number(usedRaw);
  if (!Number.isInteger(used) || used < 0 || used > BUDGET_TOTAL) {
    throw new Error(`恢复值非法：${String(usedRaw)}（需为 0..${BUDGET_TOTAL} 的整数）`);
  }
  if (!source?.trim()) throw new Error('恢复必须提供 --recover-source=<来源说明>');
  const ledger: BudgetLedger = {
    version: 1,
    total: BUDGET_TOTAL,
    used,
    updatedAt: new Date().toISOString(),
    recovery: {
      used,
      source: source.trim(),
      verified: false,
      recoveredAt: new Date().toISOString(),
    },
  };
  writeLedger(workDir, ledger);
  console.log(
    JSON.stringify({ recovered: used, total: BUDGET_TOTAL, remaining: BUDGET_TOTAL - used, source: source.trim(), verified: false }),
  );
}

function stripQuotedSegments(text: string): string {
  return text.replace(/[“「『][^”」』]*[”」』]/g, '');
}

/** 忽略否定式包裹的出现（“不要求她必须开口”不是要求强迫） */
function containsTerm(text: string, term: string, ignoreNegated: boolean): boolean {
  let index = text.indexOf(term);
  while (index >= 0) {
    if (!ignoreNegated) return true;
    const before = text.slice(Math.max(0, index - 10), index);
    const negated = /(不|没|无|别|勿|避免|无需|不必)[^。；，,\s]{0,4}$/.test(before);
    if (!negated) return true;
    index = text.indexOf(term, index + term.length);
  }
  return false;
}

function evaluateChecks(
  checks: AutoCheck[],
  output: Record<string, unknown>,
  text: string,
): { passed: number; results: Array<{ check: AutoCheck; ok: boolean }> } {
  const results = checks.map((check) => {
    let ok = false;
    if (check.type === 'decision') {
      ok = output.decision === check.value;
    } else if (check.type === 'requiresAny') {
      ok = check.terms.some((term) => text.includes(term));
    } else if (check.type === 'forbidsAny') {
      const target = check.stripQuoted ? stripQuotedSegments(text) : text;
      ok = check.terms.every((term) => !containsTerm(target, term, check.ignoreNegated === true));
    } else if (check.type === 'countBetween') {
      const value = output[check.field];
      ok = Array.isArray(value) && value.length >= check.min && value.length <= check.max;
    } else if (check.type === 'eitherDecision') {
      const decision = String(output.decision ?? '');
      if (check.values.includes(decision)) {
        const requirement = check.requirements[decision] ?? {};
        const requiresOk =
          !requirement.requiresAny || requirement.requiresAny.some((term) => text.includes(term));
        const forbidsOk =
          !requirement.forbidsAny ||
          requirement.forbidsAny.every((term) => !containsTerm(text, term, false));
        ok = requiresOk && forbidsOk;
      }
    }
    return { check, ok };
  });
  return { passed: results.filter((item) => item.ok).length, results };
}

function outputText(caseTask: EvalCase['task'], output: Record<string, unknown>): string {
  if (caseTask === 'follow_up') {
    return `${String(output.decision)} ${String(output.question ?? '')} ${String(output.reason ?? '')}`;
  }
  return JSON.stringify(output);
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
  assert.ok(AI_QUALITY_RUBRIC_VERSION.length > 0, '必须声明评审标准版本');
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

function runOffline(workDir: string): void {
  if (workDir === DEFAULT_WORK_DIR) {
    assert.ok(
      workDir.includes('logs') && !workDir.includes('.next'),
      '默认评测目录必须在 logs/ 下，构建不会清理',
    );
  }
  const casesPassed = validateCases();
  const versionsPassed = validateVersions();
  console.log(`ok eval-cases (${casesPassed})`);
  console.log(`ok eval-versions (${versionsPassed})`);
  console.log(JSON.stringify({ passed: casesPassed + versionsPassed, total: casesPassed + versionsPassed }));
}

function classifyError(message: string): 'fatal' | 'timeout' | 'error' {
  if (/HTTP\s*(401|403|429)|认证|鉴权|未授权|额度|quota|unauthorized|forbidden/i.test(message)) {
    return 'fatal';
  }
  if (/超时|timeout/i.test(message)) return 'timeout';
  return 'error';
}

function gitInfo(): { head: string; dirty: boolean } {
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: process.cwd() })
      .toString()
      .trim();
    const dirty =
      execFileSync('git', ['status', '--porcelain'], { cwd: process.cwd() }).toString().trim().length >
      0;
    return { head, dirty };
  } catch {
    return { head: 'unknown', dirty: true };
  }
}

function promptBundleHash(): string {
  const hash = createHash('sha256');
  for (const file of ['src/lib/ai.ts', 'src/lib/ai-baseline.ts', 'scripts/ai-quality-cases.ts']) {
    hash.update(readFileSync(join(process.cwd(), file)));
  }
  return hash.digest('hex').slice(0, 16);
}

function hashMessages(messages: LlmMessage[]): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex').slice(0, 16);
}

/** 只取任务函数：新旧模块的 Prompt 常量字面量不同，不参与结构比较 */
type TaskModule = Pick<
  typeof candidate,
  | 'judgeFollowUp'
  | 'organizeObservation'
  | 'reviewTeacherEdit'
  | 'generateGrowthProfile'
  | 'generateActivitySupport'
>;

type TaskRecord = {
  caseId: string;
  task: EvalCase['task'];
  stage: EvalCase['stage'];
  version: string;
  status: 'ok' | 'error' | 'fatal' | 'timeout' | 'budget' | 'NOT_RUN';
  attempts: AttemptRecord[];
  retryFeedback: string | null;
  ms: number;
  output?: Record<string, unknown>;
  checksPassed?: number;
  checksTotal?: number;
  checksFailed?: AutoCheck[];
  error?: string;
};

type RunContext = {
  takeBudget: () => void;
  registerStop: (reason: Exclude<StopReason, null>) => void;
  registerTimeout: () => void;
  registerSuccess: () => void;
  getStopReason: () => StopReason;
};

async function runCase(
  evalCase: EvalCase,
  versionId: string,
  module: TaskModule,
  context: RunContext,
): Promise<TaskRecord> {
  const attempts: AttemptRecord[] = [];
  let retryFeedback: string | null = null;
  const startedAt = Date.now();

  const countedInvoke = async (messages: LlmMessage[], options: LlmOptions = {}): Promise<LlmResult> => {
    if (attempts.length > 0) {
      const last = messages[messages.length - 1]?.content ?? '';
      if (last.startsWith('上一次输出未通过校验：')) {
        retryFeedback = last.slice(0, 300);
      }
    }
    context.takeBudget();
    const attemptStarted = Date.now();
    const messagesHash = hashMessages(messages);
    try {
      const result = await invokeLlm(messages, options);
      context.registerSuccess();
      attempts.push({
        index: attempts.length + 1,
        ms: Date.now() - attemptStarted,
        ok: true,
        content: result.content,
        usage: result.usage ?? null,
        messagesHash,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind = classifyError(message);
      if (kind === 'fatal') context.registerStop('fatal');
      if (kind === 'timeout') context.registerTimeout();
      attempts.push({
        index: attempts.length + 1,
        ms: Date.now() - attemptStarted,
        ok: false,
        usage: null,
        error: message.slice(0, 400),
        messagesHash,
      });
      throw error;
    }
  };

  try {
    let output: Record<string, unknown>;
    if (evalCase.input.kind === 'follow_up') {
      const result = await module.judgeFollowUp(evalCase.input.params, countedInvoke);
      output = result.decision as unknown as Record<string, unknown>;
    } else if (evalCase.input.kind === 'organize') {
      const result = await module.organizeObservation(evalCase.input.params, countedInvoke);
      output = result.draft as unknown as Record<string, unknown>;
    } else if (evalCase.input.kind === 'review') {
      const result = await module.reviewTeacherEdit(evalCase.input.params, countedInvoke);
      output = result.review as unknown as Record<string, unknown>;
    } else if (evalCase.input.kind === 'growth') {
      const result = await module.generateGrowthProfile(evalCase.input.params, countedInvoke);
      output = result.profile as unknown as Record<string, unknown>;
    } else {
      const result = await module.generateActivitySupport(evalCase.input.params, countedInvoke);
      output = result.activitySupport as unknown as Record<string, unknown>;
    }
    const text = outputText(evalCase.task, output);
    const checks = evaluateChecks(evalCase.autoChecks, output, text);
    return {
      caseId: evalCase.id,
      task: evalCase.task,
      stage: evalCase.stage,
      version: versionId,
      status: 'ok',
      attempts,
      retryFeedback,
      ms: Date.now() - startedAt,
      output,
      checksPassed: checks.passed,
      checksTotal: checks.results.length,
      checksFailed: checks.results.filter((item) => !item.ok).map((item) => item.check),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = context.getStopReason() ?? classifyError(message);
    return {
      caseId: evalCase.id,
      task: evalCase.task,
      stage: evalCase.stage,
      version: versionId,
      status: status === 'error' ? 'error' : status,
      attempts,
      retryFeedback,
      ms: Date.now() - startedAt,
      error: message.slice(0, 400),
    };
  }
}

async function runReal(workDir: string): Promise<void> {
  const provider = getLlmProvider();
  if (provider !== 'stepfun') {
    throw new Error(`真实评测需要本地 .env 的 LLM_PROVIDER=stepfun，当前为 ${provider}；未发送任何请求`);
  }
  if (!process.env.STEPFUN_API_KEY?.trim()) {
    throw new Error('真实评测需要本地 .env 配置 STEPFUN_API_KEY；未发送任何请求');
  }
  const ledgerResult = readLedger(workDir);
  if (!ledgerResult.ok) {
    throw new Error(
      `评测账本不可用（${ledgerResult.reason}）；拒绝发送请求。` +
        `如确需恢复历史消耗：--recover-budget <已用次数> --recover-source "<来源>"`,
    );
  }
  const ledger = ledgerResult.ledger;
  mkdirSync(workDir, { recursive: true });

  let stopReason: StopReason = null;
  let consecutiveTimeouts = 0;
  const context: RunContext = {
    takeBudget: () => {
      if (stopReason) throw new EvaluationStoppedError(stopReason);
      if (ledger.used >= ledger.total) {
        stopReason = 'budget';
        throw new EvaluationStoppedError('budget');
      }
      ledger.used += 1;
      ledger.updatedAt = new Date().toISOString();
      writeLedger(workDir, ledger);
    },
    registerStop: (reason) => {
      stopReason = stopReason ?? reason;
    },
    registerTimeout: () => {
      consecutiveTimeouts += 1;
      if (consecutiveTimeouts >= 2) stopReason = stopReason ?? 'timeout';
    },
    registerSuccess: () => {
      consecutiveTimeouts = 0;
    },
    getStopReason: () => stopReason,
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

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = `run-${stamp}`;
  const resultsFile = join(workDir, `real-${stamp}.jsonl`);
  const latestFile = join(workDir, 'real-latest.json');
  const codeVersion = { ...gitInfo(), promptBundleHash: promptBundleHash() };
  const runMeta = {
    runId,
    startedAt: new Date().toISOString(),
    provider,
    model: getLlmModel(provider),
    temperature: 0.3,
    budgetTotal: ledger.total,
    budgetUsedBeforeRun: ledger.used,
    codeVersion,
    rubricVersion: AI_QUALITY_RUBRIC_VERSION,
  };

  const records: TaskRecord[] = [];
  const executed = new Set<string>();
  const persist = (record: TaskRecord) => {
    records.push(record);
    appendFileSync(resultsFile, `${JSON.stringify({ ...runMeta, ...record })}\n`);
  };

  outer: for (const evalCase of selectedCases) {
    for (const version of selectedVersions) {
      const key = `${evalCase.id}|${version.id}`;
      if (stopReason) break outer;
      const record = await runCase(evalCase, version.id, version.module, context);
      executed.add(key);
      persist(record);
      if (record.status === 'ok') {
        const flag = record.checksPassed === record.checksTotal ? 'checks-ok' : 'checks-fail';
        console.log(
          `[${version.id}] ${evalCase.id} ok req=${record.attempts.length} ms=${record.ms} ${flag} ${record.checksPassed}/${record.checksTotal}`,
        );
      } else {
        console.log(`[${version.id}] ${evalCase.id} ${record.status} req=${record.attempts.length} ms=${record.ms}: ${record.error ?? ''}`);
      }
      if (context.getStopReason()) break outer;
    }
  }

  for (const evalCase of selectedCases) {
    for (const version of selectedVersions) {
      const key = `${evalCase.id}|${version.id}`;
      if (executed.has(key)) continue;
      persist({
        caseId: evalCase.id,
        task: evalCase.task,
        stage: evalCase.stage,
        version: version.id,
        status: 'NOT_RUN',
        attempts: [],
        retryFeedback: null,
        ms: 0,
        error: stopReason ? `主动停止：${stopReason}` : '未执行',
      });
    }
  }

  const finalStop = context.getStopReason();
  const summary = {
    ...runMeta,
    finishedAt: new Date().toISOString(),
    budgetUsedAfterRun: ledger.used,
    remainingBudget: ledger.total - ledger.used,
    stopReason: finalStop,
    total: records.length,
    ok: records.filter((item) => item.status === 'ok').length,
    notRun: records.filter((item) => item.status === 'NOT_RUN').length,
    contentError: records.filter((item) => item.status === 'error').length,
    byVersion: selectedVersions.map((version) => ({
      version: version.id,
      ok: records.filter((item) => item.version === version.id && item.status === 'ok').length,
      notRun: records.filter((item) => item.version === version.id && item.status === 'NOT_RUN').length,
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
  if (finalStop === 'fatal') process.exitCode = 2;
  else if (finalStop === 'budget') process.exitCode = 3;
  else if (finalStop === 'timeout') process.exitCode = 4;
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const workDir = resolveWorkDir(argv);
  if (argv.some((arg) => arg.startsWith('--recover-budget='))) {
    recoverBudget(workDir, argv);
    return;
  }
  if (argv.includes('--real')) {
    await runReal(workDir);
    return;
  }
  runOffline(workDir);
}

if (process.env.AI_QUALITY_SKIP_AUTO !== '1') {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 5;
  });
}
