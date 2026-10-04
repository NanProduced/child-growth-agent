import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

import { TEACHER_COOKIE } from '../src/lib/auth';
import {
  assertCleanupComplete,
  inspectOwnedContainer,
  nativeCommand,
  removeOwnedContainer,
  runCleanupSteps,
  sleep,
  startIsolatedPostgres,
  stopTrackedChildTree,
  trackChildProcess,
  type CleanupReport,
  type CleanupStep,
  type CommandRunner,
  type ProcessProbe,
  type TrackedChild,
} from './harness-safety';

/**
 * check-classes.ts 资源安全装置的专属安全反例。
 *
 * 覆盖四类反例：预先存在的旧固定名容器被保留、外部 URL 哨兵被忽略、
 * 启动 / 初始化 / 断言失败后的自有资源清理、他人容器不受影响。
 * 危险路径一律先用注入的 CommandRunner 验证规则，再用真实子进程运行验证端到端行为；
 * 本检查本身不修改 helper，也不触碰班级业务。
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'check-classes.ts'), 'utf8');
// 不 import ./check-classes：它顶层 void main()，import 即会在本进程跑完整套 15 项真实检查
const OWNERSHIP_LABEL = CHECK_SOURCE.match(/const OWNERSHIP_LABEL = '([^']+)'/)?.[1] ?? '';
const HELPER_FILE = path.join(REPO_ROOT, 'scripts', 'harness-safety.ts');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const EXPECTED_HELPER_BLOB = '6702f2ddf3b436e79f8c92ae8756c33f611a8503';
const LEGACY_NAME = 'cga-classes-check';
const LEGACY_LABEL = 'child-growth-agent.check-classes.legacy';
const EXTERNAL_URL_ENV = 'CLASSES_TEST_DATABASE_URL';
const FAULT_ENV = 'CHECK_CLASSES_FAULT';
const FAKE_RUN_ID = 'test-safe1-fake-run';

interface Finding {
  name: string;
  ok: boolean;
  detail: string;
}

const findings: Finding[] = [];

function redact(text: string): string {
  return text
    .replace(/postgresql?:\/\/[^\s'"`)]+/gi, '<redacted-connection-string>')
    .replace(new RegExp(`${TEACHER_COOKIE}=[^;"\\s]+`, 'g'), '<redacted-cookie>');
}

function record(name: string, ok: boolean, detail: string): void {
  const safe = redact(detail);
  findings.push({ name, ok, detail: safe });
  const line = JSON.stringify({ name, ok, detail: safe });
  if (ok) console.log(line);
  else console.error(line);
}

async function counterexample(name: string, run: () => string | Promise<string>): Promise<void> {
  try {
    record(name, true, await run());
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  }
}

/* ------------------------------ 伪 docker（注入 CommandRunner，零真实破坏） ------------------------------ */

interface FakeContainer {
  id: string;
  name: string;
  labels: Record<string, string>;
  exists: boolean;
}

interface FakeDocker {
  run: CommandRunner;
  containers: FakeContainer[];
  commands: string[][];
}

function createFakeDocker(seed: FakeContainer[], portLine: string): FakeDocker {
  const containers: FakeContainer[] = seed.map((item) => ({ ...item, labels: { ...item.labels } }));
  const commands: string[][] = [];
  let created = 0;
  const run: CommandRunner = (file, args) => {
    commands.push([file, ...args]);
    if (file !== 'docker') {
      return { status: 127, stdout: '', stderr: `unsupported binary: ${file}`, error: `unsupported binary: ${file}` };
    }
    const [sub, ...rest] = args;
    switch (sub) {
      case 'version':
        return { status: 0, stdout: '29.5.3', stderr: '' };
      case 'run': {
        const nameAt = rest.indexOf('--name');
        const labelAt = rest.indexOf('--label');
        const rawLabel = labelAt >= 0 ? (rest[labelAt + 1] ?? '') : '';
        const eq = rawLabel.indexOf('=');
        created += 1;
        const id = created.toString(16).padStart(64, '0');
        containers.push({
          id,
          name: nameAt >= 0 ? (rest[nameAt + 1] ?? '') : '',
          labels: eq >= 0 ? { [rawLabel.slice(0, eq)]: rawLabel.slice(eq + 1) } : {},
          exists: true,
        });
        return { status: 0, stdout: id, stderr: '' };
      }
      case 'inspect': {
        const target = rest[rest.length - 1] ?? '';
        const found = containers.find((c) => c.exists && (c.id === target || c.name === target));
        if (!found) return { status: 1, stdout: '', stderr: `Error: No such object: ${target}` };
        return {
          status: 0,
          stdout: JSON.stringify({ Id: found.id, Config: { Labels: found.labels } }),
          stderr: '',
        };
      }
      case 'port':
        return { status: 0, stdout: portLine, stderr: '' };
      case 'rm': {
        const target = rest.find((arg) => arg !== '-f') ?? '';
        const found = containers.find((c) => c.exists && (c.id === target || c.name === target));
        if (!found) return { status: 1, stdout: '', stderr: `Error: No such container: ${target}` };
        found.exists = false;
        return { status: 0, stdout: found.id, stderr: '' };
      }
      default:
        return { status: 1, stdout: '', stderr: `unsupported subcommand: ${sub}` };
    }
  };
  return { run, containers, commands };
}

function alive(fake: FakeDocker, id: string): boolean {
  return fake.containers.find((c) => c.id === id)?.exists === true;
}

/* ------------------------------ 真实 docker 与子进程 ------------------------------ */

interface LegacyContainer {
  id: string;
  created: boolean;
  runId: string | null;
}

function listContainerIds(label?: string): string[] {
  const args = ['ps', '-aq'];
  if (label) args.push('--filter', `label=${label}`);
  const result = nativeCommand('docker', args);
  if (result.status !== 0) {
    throw new Error(`docker ps 失败：${result.stderr || result.stdout || result.error || `exit=${result.status}`}`);
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function ensureLegacyContainer(): Promise<LegacyContainer> {
  const existing = inspectOwnedContainer(LEGACY_NAME, LEGACY_LABEL, nativeCommand);
  if (existing.state === 'unverifiable') {
    throw new Error(`无法核实旧固定名容器：${existing.detail}`);
  }
  if (existing.state === 'verified') return { id: existing.id, created: false, runId: null };

  const runId = `legacy-${process.pid}-${Date.now().toString(36)}`;
  const created = nativeCommand('docker', [
    'run',
    '-d',
    '--name',
    LEGACY_NAME,
    '--label',
    `${LEGACY_LABEL}=${runId}`,
    '-e',
    'POSTGRES_PASSWORD=postgres',
    'postgres:16-alpine',
  ]);
  if (created.status !== 0) {
    throw new Error(`准备旧固定名容器失败：${created.stderr || created.stdout || created.error}`);
  }
  const after = inspectOwnedContainer(LEGACY_NAME, LEGACY_LABEL, nativeCommand);
  if (after.state !== 'verified') throw new Error('旧固定名容器创建后无法核实身份');
  return { id: after.id, created: true, runId };
}

interface ForeignRun {
  id: string;
  name: string;
  runId: string;
}

/**
 * 测试装置自建“同一所有权标签、不同 RUN_ID”的合法容器，用于验证本轮残留判定不会误伤它。
 * 所有权记录在测试装置侧（runId），收尾只由创建者按 ID + 对应标签删除。
 */
async function ensureSameLabelForeignContainer(): Promise<ForeignRun> {
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const name = `cga-classes-check-foreign-${suffix}`;
  const runId = `foreign-${suffix}`;
  const created = nativeCommand('docker', [
    'run',
    '-d',
    '--name',
    name,
    '--label',
    `${OWNERSHIP_LABEL}=${runId}`,
    '-e',
    'POSTGRES_PASSWORD=postgres',
    'postgres:16-alpine',
  ]);
  if (created.status !== 0) {
    throw new Error(`准备同标签异 RUN 容器失败：${created.stderr || created.stdout || created.error}`);
  }
  const inspected = inspectOwnedContainer(name, OWNERSHIP_LABEL, nativeCommand);
  if (inspected.state !== 'verified' || inspected.label !== runId) {
    const cleanup = removeOwnedContainer(inspected.state === 'verified' ? inspected.id : null, {
      fallbackName: name,
      runId,
      labelKey: OWNERSHIP_LABEL,
    });
    throw new Error(
      `同标签异 RUN 容器创建后无法核实身份（${inspected.state}）；清理结果：${cleanup.ok ? 'ok' : cleanup.detail}`,
    );
  }
  return { id: inspected.id, name, runId };
}

function assertSameLabelForeignAlive(foreign: ForeignRun | null): void {
  if (!foreign) return;
  const state = inspectOwnedContainer(foreign.id, OWNERSHIP_LABEL, nativeCommand);
  assert.equal(
    state.state,
    'verified',
    `同标签异 RUN_ID 容器被误动：${state.state}${
      state.state === 'unverifiable' ? `（${state.detail}）` : ''
    }`,
  );
}

interface Sentinel {
  url: string;
  connections: () => number;
  close: () => Promise<void>;
}

async function startSentinel(): Promise<Sentinel> {
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `postgresql://sentinel:sentinel@127.0.0.1:${address.port}/sentinel_db`,
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

interface CheckReport {
  result: string;
  phase?: string;
  message?: string;
  passed: number;
  total: number;
  container: string | null;
  cleanupIssues?: string[];
}

interface HarnessResourceReport {
  resource: 'classes-harness';
  run_id: string;
  container_name: string;
  container_id: string;
  label_key: string;
  phase: string;
}

/** 解析子任务输出的最小结构化资源报告；只认本轮装置自己的报告行 */
function parseHarnessResources(output: string): HarnessResourceReport[] {
  const reports: HarnessResourceReport[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{"resource":"classes-harness"')) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<HarnessResourceReport>;
      if (
        parsed.resource === 'classes-harness' &&
        typeof parsed.run_id === 'string' &&
        typeof parsed.container_name === 'string' &&
        typeof parsed.container_id === 'string' &&
        typeof parsed.label_key === 'string' &&
        typeof parsed.phase === 'string'
      ) {
        reports.push(parsed as HarnessResourceReport);
      }
    } catch {
      // 非资源报告行忽略
    }
  }
  return reports;
}

interface ChildRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 超时路径的进程树终止与核验结果；未超时为 null */
  treeStop: CleanupReport | null;
  resources: HarnessResourceReport[];
}

/**
 * 运行子任务：用获批 helper 记录进程身份；超时时终止并核验进程树，
 * 返回结构化结果供父检查做资源补偿与失败判定（不以 child.kill() 冒充已终止）。
 */
async function runCheckChild(
  extraEnv: Record<string, string>,
  options: { timeoutMs?: number } = {},
): Promise<ChildRun> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  // 不回退到 .env / 平台注入的数据库
  delete env.DATABASE_URL;
  delete env.PGDATABASE_URL;
  const child = spawn(process.execPath, [TSX_CLI, 'scripts/check-classes.ts'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const tracked = trackChildProcess(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  const spawnFailure = new Promise<never>((_, reject) => {
    child.on('error', reject);
  });
  let timer: NodeJS.Timeout | null = null;
  let timedOut = false;
  let treeStop: CleanupReport | null = null;
  try {
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const outcome = await Promise.race([
      closed.then(() => 'closed' as const),
      spawnFailure,
      timeout,
    ]);
    if (outcome === 'timeout') {
      timedOut = true;
      // 超时不能只杀根进程：终止后必须核实本轮进程树退出与后代残留
      treeStop = await stopTrackedChildTree(tracked);
      await Promise.race([closed, sleep(15_000)]);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  const { code, signal } = await Promise.race([
    closed,
    sleep(1_000).then(() => ({ code: null, signal: null })),
  ]);
  return {
    status: code,
    signal,
    stdout,
    stderr,
    timedOut,
    treeStop,
    resources: parseHarnessResources(`${stdout}\n${stderr}`),
  };
}

/** 超时判定：只有“已核实进程树退出”才算完成；未核实或后代残留必须失败 */
function assertTimeoutOutcome(run: ChildRun): void {
  if (!run.timedOut) return;
  assert.ok(run.treeStop, '超时后必须执行进程树终止与核验');
  assert.equal(
    run.treeStop.ok,
    true,
    `超时后进程树未核实退出或存在残留，不得报告已终止：${run.treeStop.detail}`,
  );
  assert.match(
    run.treeStop.detail,
    /已核实|已退出/,
    '终止报告必须包含核验结果，而非仅“已发送终止请求”',
  );
}

/** 残留判定只针对本轮登记资源：按登记容器 ID + 对应所有权标签核实 */
function assertRegisteredResourceAbsent(
  resource: HarnessResourceReport,
  run: CommandRunner = nativeCommand,
): void {
  const state = inspectOwnedContainer(resource.container_id, resource.label_key, run);
  assert.equal(
    state.state,
    'absent',
    `本轮登记容器 ${resource.container_id} 未被清理：${state.state}${
      state.state === 'unverifiable' ? `（${state.detail}）` : ''
    }`,
  );
}

/** 父检查补偿清理：只按已核实 ID + 所有权；失败/无法核实进入清理问题（阻断 PASS） */
function compensateRegisteredResources(
  run: ChildRun,
  noteIssue: (label: string, detail: string) => void,
  runner: CommandRunner = nativeCommand,
): Promise<void> {
  const steps: CleanupStep[] = run.resources.map((resource) => ({
    label: `compensate-${resource.container_id.slice(0, 12)}`,
    run: (): CleanupReport => {
      const removal = removeOwnedContainer(resource.container_id, {
        fallbackName: resource.container_name,
        runId: resource.run_id,
        labelKey: resource.label_key,
        run: runner,
      });
      if (!removal.ok) return removal;
      const state = inspectOwnedContainer(resource.container_id, resource.label_key, runner);
      if (state.state !== 'absent') {
        return {
          ok: false,
          detail: `补偿清理后容器 ${resource.container_id} 仍为 ${state.state}`,
        };
      }
      return { ok: true, detail: removal.detail };
    },
  }));
  return runCleanupSteps(steps, noteIssue);
}

function parseReport(output: string, result: 'PASS' | 'FAIL'): CheckReport {
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`{"result":"${result}"`));
  assert.ok(line, `输出中没有 ${result} 结果行`);
  return JSON.parse(line) as CheckReport;
}

function assertNoSecretLeak(output: string): void {
  assert.ok(!/postgresql?:\/\//i.test(output), '输出泄露了连接串');
  assert.ok(!output.includes(`${TEACHER_COOKIE}=`), '输出泄露了会话 Cookie');
}

function assertForeignContainersAlive(preexisting: string[]): void {
  for (const id of preexisting) {
    const state = inspectOwnedContainer(id, LEGACY_LABEL, nativeCommand);
    assert.equal(
      state.state,
      'verified',
      `既有容器 ${id} 状态=${state.state}${state.state === 'unverifiable' ? `（${state.detail}）` : ''}`
    );
  }
}

/* ------------------------------ 主流程 ------------------------------ */

async function main(): Promise<void> {
  let legacy: LegacyContainer | null = null;
  let foreign: ForeignRun | null = null;
  const preexisting: string[] = [];

  await counterexample('helper-blob-unmodified', () => {
    const blob = fs.readFileSync(HELPER_FILE);
    const digest = createHash('sha1').update(`blob ${blob.length}\0`).update(blob).digest('hex');
    assert.equal(digest, EXPECTED_HELPER_BLOB, 'scripts/harness-safety.ts 与引入的 blob 不一致');
    return `blob=${digest}`;
  });

  await counterexample('source-external-url-pattern-removed', () => {
    assert.ok(!CHECK_SOURCE.includes('CLASSES_TEST_DATABASE_URL'), '仍存在外部 URL 模式');
    assert.ok(!/postgresql?:\/\//i.test(CHECK_SOURCE), '源码内仍有连接串字面量');
    assert.ok(CHECK_SOURCE.includes('delete process.env.PGDATABASE_URL'), '未切断平台数据库回退');
    assert.ok(CHECK_SOURCE.includes('process.env.DATABASE_URL = database.url'), '未绑定到本轮已核验目标');
    return '外部 URL 模式与平台库回退均已移除';
  });

  await counterexample('source-no-direct-docker-no-model-call', () => {
    assert.ok(!CHECK_SOURCE.includes('spawnSync'), '仍直接调用子进程');
    assert.ok(!CHECK_SOURCE.includes('node:child_process'), '仍直接引入 child_process');
    assert.ok(CHECK_SOURCE.includes("from './harness-safety'"), '未复用安全 helper');
    assert.ok(!/src\/lib\/(ai|llm|observation-agent)['"]/.test(CHECK_SOURCE), '引入了模型调用模块');
    assert.ok(!/STEPFUN|LLM_PROVIDER|api[_-]?key/i.test(CHECK_SOURCE), '出现了模型出口配置');
    assert.ok(
      OWNERSHIP_LABEL.startsWith('child-growth-agent.check-classes.'),
      `未从 check-classes 源码解析到所有权标签（得到 '${OWNERSHIP_LABEL}'）`
    );
    assert.ok(
      CHECK_SOURCE.indexOf('assertCleanupComplete(cleanupIssues)') <
        CHECK_SOURCE.indexOf("result: 'PASS'"),
      'PASS 输出先于清理闸门'
    );
    return 'docker 与模型出口全部经由安全装置';
  });

  await counterexample('legacy-fixed-name-container-preserved', () => {
    const legacyId = 'b'.repeat(64);
    const fake = createFakeDocker(
      [{ id: legacyId, name: LEGACY_NAME, labels: {}, exists: true }],
      '127.0.0.1:32768'
    );
    const report = removeOwnedContainer(null, {
      fallbackName: LEGACY_NAME,
      runId: FAKE_RUN_ID,
      labelKey: OWNERSHIP_LABEL,
      run: fake.run,
    });
    assert.equal(report.ok, false, '按旧固定名清理必须被拒绝');
    assert.match(report.detail, /拒绝删除/);
    assert.ok(alive(fake, legacyId), '预先存在的旧固定名容器必须保留');
    assert.equal(
      fake.commands.some((command) => command[1] === 'rm'),
      false,
      '拒绝路径不得发出删除命令'
    );
    return `旧固定名容器保留，未发出 rm：${report.detail}`;
  });

  await counterexample('foreign-containers-untouched', () => {
    const ownId = 'c'.repeat(64);
    const others: FakeContainer[] = [
      { id: 'd'.repeat(64), name: 'other-project-a', labels: {}, exists: true },
      { id: 'e'.repeat(64), name: 'other-project-b', labels: { [OWNERSHIP_LABEL]: 'someone-else' }, exists: true },
    ];
    const fake = createFakeDocker(
      [
        { id: ownId, name: 'cga-classes-check-fake', labels: { [OWNERSHIP_LABEL]: FAKE_RUN_ID }, exists: true },
        ...others,
      ],
      '127.0.0.1:32768'
    );
    const report = removeOwnedContainer(ownId, {
      fallbackName: 'cga-classes-check-fake',
      runId: FAKE_RUN_ID,
      labelKey: OWNERSHIP_LABEL,
      run: fake.run,
    });
    assert.equal(report.ok, true, `本轮容器清理应成功：${report.detail}`);
    assert.equal(alive(fake, ownId), false, '本轮容器应被清理');
    for (const other of others) {
      assert.ok(alive(fake, other.id), `他人容器 ${other.name} 不受影响`);
    }
    return '仅删除本轮 ID+标签容器，他人容器原样保留';
  });

  await counterexample('startup-failure-cleans-own-container-only', async () => {
    const foreignId = 'f'.repeat(64);
    const fake = createFakeDocker(
      [{ id: foreignId, name: 'other-project', labels: {}, exists: true }],
      '0.0.0.0:32768'
    );
    await assert.rejects(
      () =>
        startIsolatedPostgres({
          runId: FAKE_RUN_ID,
          containerName: 'cga-classes-check-fake',
          dbName: 'cga_check_fake',
          labelKey: OWNERSHIP_LABEL,
          run: fake.run,
        }),
      /回环地址/
    );
    const owned = fake.containers.find((c) => c.name === 'cga-classes-check-fake');
    assert.ok(owned, '本轮容器应当已经创建');
    assert.equal(alive(fake, owned.id), false, '启动/核验失败后本轮容器必须被清理');
    assert.ok(
      fake.commands.some((command) => command[1] === 'rm' && command[3] === owned.id),
      '删除必须按本轮容器 ID 发出'
    );
    assert.ok(alive(fake, foreignId), '他人容器不受影响');
    return `非回环映射被拒绝并清理本轮容器 ${owned.id.slice(0, 12)}…`;
  });

  await counterexample('cleanup-steps-independent-failure-blocks-pass', async () => {
    const executed: string[] = [];
    const issues: string[] = [];
    await runCleanupSteps(
      [
        { label: 'step-a', run: () => { executed.push('a'); throw new Error('清理A失败'); } },
        { label: 'step-b', run: () => { executed.push('b'); return { ok: false, detail: '清理B未完成' }; } },
        { label: 'step-c', run: () => { executed.push('c'); } },
      ],
      (label, detail) => issues.push(`${label}: ${detail}`)
    );
    assert.deepEqual(executed, ['a', 'b', 'c'], '清理步骤必须独立执行，单步失败不得中断后续步骤');
    assert.equal(issues.length, 2, '失败步骤必须被记录');
    assert.throws(() => assertCleanupComplete(issues), /清理失败/, '清理失败必须阻断 PASS');
    return '单步失败仍执行全部步骤，清理失败抛错阻断 PASS';
  });

  await counterexample('same-label-foreign-run-not-residue', () => {
    const ownId = '1'.repeat(64);
    const foreignId = '2'.repeat(64);
    const foreignRun = 'someone-else-run';
    const fake = createFakeDocker(
      [
        { id: ownId, name: 'cga-classes-check-own', labels: { [OWNERSHIP_LABEL]: FAKE_RUN_ID }, exists: true },
        { id: foreignId, name: 'cga-classes-check-other', labels: { [OWNERSHIP_LABEL]: foreignRun }, exists: true },
      ],
      '127.0.0.1:32768'
    );
    const removal = removeOwnedContainer(ownId, {
      fallbackName: 'cga-classes-check-own',
      runId: FAKE_RUN_ID,
      labelKey: OWNERSHIP_LABEL,
      run: fake.run,
    });
    assert.equal(removal.ok, true, removal.detail);
    assert.equal(alive(fake, ownId), false, '本轮容器应被清理');
    assert.equal(alive(fake, foreignId), true, '同标签异 RUN_ID 容器必须保留');
    // 残留判定按本轮登记 ID：同标签异 RUN 容器不参与
    assertRegisteredResourceAbsent(
      {
        resource: 'classes-harness',
        run_id: FAKE_RUN_ID,
        container_name: 'cga-classes-check-own',
        container_id: ownId,
        label_key: OWNERSHIP_LABEL,
        phase: 'database-start',
      },
      fake.run
    );
    return '本轮按登记 ID 判定清理成功；同标签异 RUN_ID 容器保持不变';
  });

  await counterexample('timeout-descendant-survivor-reports-failure', async () => {
    const alivePids = new Set([9000, 9001]);
    const createdTimes = new Map([
      [9000, 'T0'],
      [9001, 'T1'],
    ]);
    const probe: ProcessProbe = {
      creationTime: (pid) => (alivePids.has(pid) ? createdTimes.get(pid) ?? null : null),
      isAlive: (pid) => alivePids.has(pid),
      parentMap: () => new Map([[9001, 9000]]),
    };
    const tracked = {
      pid: 9000,
      proc: {} as unknown as ChildProcess,
      startedAt: 'T0',
      spawnError: null,
      exit: null,
      logFile: null,
    } as TrackedChild;
    const treeStop = await stopTrackedChildTree(tracked, {
      probe,
      kill: () => {
        alivePids.delete(9000);
        return { status: 1, stdout: '', stderr: 'simulated taskkill failure' };
      },
    });
    assert.equal(treeStop.ok, false, '根消失但已知后代存活必须非成功');
    assert.match(treeStop.detail, /9001/, '必须列出待人工核实的后代 PID');
    assert.throws(
      () =>
        assertTimeoutOutcome({
          status: null,
          signal: null,
          stdout: '',
          stderr: '',
          timedOut: true,
          treeStop,
          resources: [],
        }),
      /未核实|残留|不得/,
      '超时结果必须把非成功终止传播为失败'
    );
    return treeStop.detail;
  });

  await counterexample('timeout-compensation-rm-failure-blocks-pass', () => {
    const containerId = '3'.repeat(64);
    const failingRun: CommandRunner = (file, args) => {
      if (file !== 'docker') {
        return { status: 127, stdout: '', stderr: 'unsupported', error: 'unsupported' };
      }
      const [sub] = args;
      if (sub === 'inspect') {
        return {
          status: 0,
          stdout: JSON.stringify({
            Id: containerId,
            Config: { Labels: { [OWNERSHIP_LABEL]: FAKE_RUN_ID } },
          }),
          stderr: '',
        };
      }
      if (sub === 'rm') {
        return { status: 1, stdout: '', stderr: 'Error response from daemon: removal denied' };
      }
      return { status: 1, stdout: '', stderr: `unsupported subcommand: ${sub}` };
    };
    const removal = removeOwnedContainer(containerId, {
      fallbackName: 'cga-classes-check-x',
      runId: FAKE_RUN_ID,
      labelKey: OWNERSHIP_LABEL,
      run: failingRun,
    });
    assert.equal(removal.ok, false, '清理失败不得报告成功');
    assert.match(removal.detail, /removal denied|删除/);
    return removal.detail;
  });

  await counterexample('timeout-compensation-unverifiable-keeps-reference', () => {
    const containerId = '4'.repeat(64);
    let rmIssued = false;
    const daemonDownRun: CommandRunner = (file, args) => {
      if (file !== 'docker') {
        return { status: 127, stdout: '', stderr: 'unsupported', error: 'unsupported' };
      }
      if (args[0] === 'rm') {
        rmIssued = true;
        return { status: 1, stdout: '', stderr: 'should not be called' };
      }
      return { status: 1, stdout: '', stderr: 'error during connect: docker daemon unavailable' };
    };
    const removal = removeOwnedContainer(containerId, {
      fallbackName: 'cga-classes-check-x',
      runId: FAKE_RUN_ID,
      labelKey: OWNERSHIP_LABEL,
      run: daemonDownRun,
    });
    assert.equal(removal.ok, false, '无法核实不得报告成功');
    assert.match(removal.detail, /无法核实/);
    assert.ok(removal.detail.includes(containerId), '必须保留资源引用');
    assert.equal(rmIssued, false, '无法核实时不删除身份不明资源');
    return removal.detail;
  });

  await counterexample('timeout-compensation-idempotent-on-clean-resource', async () => {
    const fake = createFakeDocker([], '127.0.0.1:32768');
    const run: ChildRun = {
      status: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      treeStop: null,
      resources: [
        {
          resource: 'classes-harness',
          run_id: FAKE_RUN_ID,
          container_name: 'cga-classes-check-x',
          container_id: '5'.repeat(64),
          label_key: OWNERSHIP_LABEL,
          phase: 'database-start',
        },
      ],
    };
    const issues: string[] = [];
    await compensateRegisteredResources(run, (label, detail) => issues.push(`${label}: ${detail}`), fake.run);
    assert.deepEqual(issues, [], '已清理资源上的补偿必须幂等成功');
    return '正常结束/已清理资源的补偿路径保持成功且无删除动作';
  });

  let dockerOk = false;
  await counterexample('docker-daemon-available', () => {
    const probe = nativeCommand('docker', ['version']);
    assert.equal(probe.status, 0, `docker 不可用：${probe.stderr || probe.stdout || probe.error}`);
    dockerOk = true;
    return 'docker daemon 可用，进入真实反例';
  });

  if (dockerOk) {
    try {
      preexisting.push(...listContainerIds());
      legacy = await ensureLegacyContainer();
      foreign = await ensureSameLabelForeignContainer();
    } catch (error) {
      record('real-counterexample-setup', false, error instanceof Error ? error.message : String(error));
      dockerOk = false;
    }
  }

  const legacyTarget: LegacyContainer | null = dockerOk ? legacy : null;
  const foreignTarget: ForeignRun | null = dockerOk ? foreign : null;

  try {
    if (legacyTarget) {
      await counterexample('real-init-failure-ignores-external-url-and-cleans-up', async () => {
        const sentinel = await startSentinel();
        let run: ChildRun;
        try {
          run = await runCheckChild({ [EXTERNAL_URL_ENV]: sentinel.url, [FAULT_ENV]: 'init' });
        } finally {
          await sentinel.close();
        }
        const output = `${run.stdout}\n${run.stderr}`;
        assert.notEqual(run.status, 0, '初始化失败必须以非零退出码结束');
        assert.equal(run.timedOut, false, '初始化失败不应触发超时路径');
        assert.ok(!run.stdout.includes('"result":"PASS"'), '初始化失败不得报告 PASS');
        const report = parseReport(run.stderr, 'FAIL');
        assert.equal(report.phase, 'database-init', '失败报告缺少明确阶段');
        assert.equal(report.passed, 3);
        assert.equal(report.total, 15);
        assert.ok(
          report.container !== null && /^[0-9a-f]{64}$/i.test(report.container),
          '失败报告须携带本轮已核验容器 ID'
        );
        assert.deepEqual(report.cleanupIssues, [], '本轮清理必须成功');
        assert.equal(sentinel.connections(), 0, '外部 URL 哨兵被连接，说明仍在使用外部库');
        // 残留判定只针对本轮登记资源（不再检查整个标签命名空间）
        assert.equal(run.resources.length, 1, '必须收到本轮最小结构化资源报告');
        assert.equal(run.resources[0].container_id, report.container, '资源报告与失败报告容器一致');
        assertRegisteredResourceAbsent(run.resources[0]);
        const compensationIssues: string[] = [];
        await compensateRegisteredResources(run, (label, detail) =>
          compensationIssues.push(`${label}: ${detail}`)
        );
        assert.deepEqual(compensationIssues, [], '父检查补偿清理不得产生问题');
        assertSameLabelForeignAlive(foreignTarget);
        const legacyNow = inspectOwnedContainer(LEGACY_NAME, LEGACY_LABEL, nativeCommand);
        assert.ok(legacyNow.state === 'verified', `旧固定名容器状态=${legacyNow.state}`);
        assert.equal(legacyNow.id, legacyTarget.id, '旧固定名容器被删除或重建');
        assertNoSecretLeak(output);
        return `phase=${report.phase} passed=${report.passed} 登记容器已清理 哨兵连接=0 旧固定名与同标签异RUN容器保留`;
      });

      await counterexample('real-assert-failure-cleans-up-and-keeps-others', async () => {
        const run = await runCheckChild({ [FAULT_ENV]: 'assert' });
        const output = `${run.stdout}\n${run.stderr}`;
        assert.notEqual(run.status, 0, '断言失败必须以非零退出码结束');
        assert.equal(run.timedOut, false, '断言失败不应触发超时路径');
        assert.ok(!run.stdout.includes('"result":"PASS"'), '断言失败不得报告 PASS');
        const report = parseReport(run.stderr, 'FAIL');
        assert.equal(report.phase, 'checks', '失败报告缺少明确阶段');
        assert.equal(report.passed, 4);
        assert.equal(report.total, 15);
        assert.ok(
          report.container !== null && /^[0-9a-f]{64}$/i.test(report.container),
          '失败报告须携带本轮已核验容器 ID'
        );
        assert.deepEqual(report.cleanupIssues, [], '本轮清理必须成功');
        assert.equal(run.resources.length, 1, '必须收到本轮最小结构化资源报告');
        assert.equal(run.resources[0].container_id, report.container, '资源报告与失败报告容器一致');
        assertRegisteredResourceAbsent(run.resources[0]);
        const compensationIssues: string[] = [];
        await compensateRegisteredResources(run, (label, detail) =>
          compensationIssues.push(`${label}: ${detail}`)
        );
        assert.deepEqual(compensationIssues, [], '父检查补偿清理不得产生问题');
        assertSameLabelForeignAlive(foreignTarget);
        const legacyNow = inspectOwnedContainer(LEGACY_NAME, LEGACY_LABEL, nativeCommand);
        assert.ok(legacyNow.state === 'verified', `旧固定名容器状态=${legacyNow.state}`);
        assert.equal(legacyNow.id, legacyTarget.id, '旧固定名容器被删除或重建');
        assertForeignContainersAlive(preexisting);
        assertNoSecretLeak(output);
        return `phase=${report.phase} passed=${report.passed} 登记容器已清理 他人容器 ${preexisting.length} 个与同标签异RUN容器全部保留`;
      });

      await counterexample('timeout-hang-after-container-compensates', async () => {
        const run = await runCheckChild(
          { [FAULT_ENV]: 'hang-after-container' },
          { timeoutMs: 45_000 }
        );
        assert.equal(run.timedOut, true, '容器登记后挂起必须在短超时内触发终止');
        assert.ok(run.treeStop, '超时必须执行进程树终止与核验');
        assert.equal(run.treeStop.ok, true, `进程树终止必须核实退出：${run.treeStop.detail}`);
        assert.match(
          run.treeStop.detail,
          /已核实|已退出/,
          '必须区分“已发送终止请求”与“已核实进程树退出”'
        );
        assert.ok(!run.stdout.includes('"result":"PASS"'), '挂起子任务不得报告 PASS');
        assert.equal(run.resources.length, 1, '必须收到最小结构化资源报告');
        const resource = run.resources[0];
        assert.match(resource.container_id, /^[0-9a-f]{64}$/i, '资源报告必须携带已核验容器 ID');
        assert.equal(resource.phase, 'database-start');
        assert.equal(resource.label_key, OWNERSHIP_LABEL);
        assert.ok(resource.run_id.length > 0, '资源报告必须携带 RUN_ID');
        assert.ok(
          resource.container_name.startsWith('cga-classes-check-'),
          `资源报告容器名异常：${resource.container_name}`
        );
        // 父进程补偿清理：只按已核实 ID + 所有权，不按端口/名称强杀
        const compensationIssues: string[] = [];
        await compensateRegisteredResources(run, (label, detail) =>
          compensationIssues.push(`${label}: ${detail}`)
        );
        assert.deepEqual(compensationIssues, [], '超时后补偿清理必须成功');
        assertRegisteredResourceAbsent(resource);
        assertSameLabelForeignAlive(foreignTarget);
        const legacyNow = inspectOwnedContainer(LEGACY_NAME, LEGACY_LABEL, nativeCommand);
        assert.equal(legacyNow.state, 'verified', '旧固定名容器保持');
        assertNoSecretLeak(`${run.stdout}\n${run.stderr}`);
        return `短超时触发；${run.treeStop.detail}；登记容器 ${resource.container_id.slice(0, 12)}… 已补偿清理`;
      });
    }
  } finally {
    if (legacyTarget?.created && legacyTarget.runId) {
      const target: LegacyContainer = legacyTarget;
      await counterexample('legacy-container-released-by-id-and-label', () => {
        const removal = removeOwnedContainer(target.id, {
          fallbackName: LEGACY_NAME,
          runId: target.runId ?? '',
          labelKey: LEGACY_LABEL,
        });
        assert.equal(removal.ok, true, removal.detail);
        const after = inspectOwnedContainer(LEGACY_NAME, LEGACY_LABEL, nativeCommand);
        assert.equal(after.state, 'absent', '本轮创建的旧名容器收尾必须删除');
        return `已按 ID+标签回收：${removal.detail}`;
      });
    }
    if (foreignTarget) {
      const target: ForeignRun = foreignTarget;
      await counterexample('same-label-foreign-container-released-by-creator', () => {
        const removal = removeOwnedContainer(target.id, {
          fallbackName: target.name,
          runId: target.runId,
          labelKey: OWNERSHIP_LABEL,
        });
        assert.equal(removal.ok, true, removal.detail);
        const after = inspectOwnedContainer(target.id, OWNERSHIP_LABEL, nativeCommand);
        assert.equal(after.state, 'absent', '测试装置创建的异 RUN 容器收尾必须删除');
        return `已按 ID + 对应标签回收：${removal.detail}`;
      });
    }
  }

  const failed = findings.filter((finding) => !finding.ok);
  if (failed.length > 0) {
    console.error(
      JSON.stringify({
        result: 'FAIL',
        passed: findings.length - failed.length,
        total: findings.length,
        failed: failed.map((finding) => finding.name),
      })
    );
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ result: 'PASS', passed: findings.length, total: findings.length }));
}

void main().catch((error: unknown) => {
  console.error(redact(error instanceof Error ? (error.stack ?? error.message) : String(error)));
  process.exitCode = 1;
});
