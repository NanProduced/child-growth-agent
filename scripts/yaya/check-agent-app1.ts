/**
 * YAYA-AGENT-APP1 正式验收：三条运行接口 + run 持久化 + 动态授权装配。
 *
 * 真实层：
 * - 一次性隔离 PostgreSQL（Docker 容器，回环地址、自有库名/标签）+ 自有本地媒体根；
 * - 真实 Next 服务（dev，127.0.0.1 随机端口）+ 真实 AUTH（登录/会话/CSRF）；
 * - 真实 DATA/MEDIA/READ1 与真实 run 持久化（scripts/upgrade-yaya-runs-v1.sql）；
 * - 模型替身是本地 HTTP 服务（StepFun 协议），真实 llm.ts 请求路径，0 真实 provider 出口。
 * 独立进程层：检查进程直接读同一隔离库/媒体根，验证跨进程查询、跨进程取消与依赖重核。
 *
 * 运行：pnpm exec tsx scripts/yaya/check-agent-app1.ts
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import sharp from 'sharp';

import { hashPassword } from '../../src/lib/accounts/password';
import type { Principal } from '../../src/lib/accounts/types';
import {
  computeCsrfToken,
  createSessionToken,
  hashSessionToken,
  SESSION_COOKIE_NAME,
} from '../../src/lib/accounts/session';
import {
  parseYayaRunWireLine,
  safeYayaStopDetail,
  validateYayaRunEventStream,
  type YayaRunWireEvent,
} from '../../src/lib/yaya/api-contract';
import {
  createYayaRunRuntimeState,
  createYayaRunRuntimeStateFromRecord,
  loadYayaRunProjectedContext,
  revalidateYayaRunContext,
} from '../../src/lib/yaya/agent/runtime/context';
import { resolveYayaRunCurrentIdentity } from '../../src/lib/yaya/agent/runtime/identity';
import { verifyYayaRunBoundaryIdentity } from '../../src/lib/yaya/agent/runtime/identity';
import {
  appendYayaRunDependencies,
  assertYayaRunActive,
  computeYayaRunRequestDigest,
  finalizeYayaRun,
  loadYayaRun,
  parseStoredDependencies,
  parseYayaRunRecord,
  registerYayaRun,
} from '../../src/lib/yaya/agent/runtime/store';
import { loadAttachmentContent } from '../../src/lib/media/content-service';
import { mediaRuntimeOrThrow } from '../../src/lib/media/runtime';
import { enrollChildInClass } from '../../src/lib/queries';
import { withTransaction } from '../../src/storage/database/pg-client';
import {
  assertCleanupComplete,
  findListeningPids,
  readLogTail,
  restoreGeneratedArtifacts,
  runCleanupSteps,
  snapshotGeneratedArtifacts,
  startIsolatedPostgres,
  stopTrackedChildTree,
  trackChildProcess,
  waitForVerifiedService,
  type IsolatedPostgres,
  type TrackedChild,
} from '../harness-safety';

const RUN = `agent-app1-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const LABEL_KEY = 'yaya.agent-app1';
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCHOOL_ID = 'single-school';

let passed = 0;
const failures: string[] = [];
function check(label: string, condition: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`ok - ${label}`);
  } else {
    failures.push(label);
    console.error(`FAIL - ${label}`);
  }
}
function stage(label: string): void {
  console.error(`[stage] ${label}`);
}

/* --------------------------------- 迁移与种子 --------------------------------- */

function readMigrationSlice(file: string, stopMarker: string): string {
  const sql = fs.readFileSync(path.join(ROOT, 'scripts', file), 'utf8');
  const index = sql.indexOf(stopMarker);
  if (index < 0) throw new Error(`迁移切片标记未找到：${file} ← ${stopMarker}`);
  return sql.slice(0, index);
}

async function runMigrations(database: Client): Promise<void> {
  await database.query(readMigrationSlice('initialize-demo-db.sql', 'INSERT INTO children'));
  await database.query(readMigrationSlice('upgrade-classes.sql', '-- 5) 演示班级'));
  await database.query(
    fs.readFileSync(path.join(ROOT, 'scripts', 'upgrade-guide-evidence-v1.sql'), 'utf8'),
  );
  await database.query(fs.readFileSync(path.join(ROOT, 'scripts', 'upgrade-auth-v1.sql'), 'utf8'));
  await database.query(fs.readFileSync(path.join(ROOT, 'scripts', 'upgrade-yaya-v1.sql'), 'utf8'));
  await database.query(fs.readFileSync(path.join(ROOT, 'scripts', 'upgrade-yaya-runs-v1.sql'), 'utf8'));
}

interface SeedFacts {
  teacherA: { id: string; username: string; password: string };
  teacherB: { id: string };
  teacherC: { id: string };
  admin: { id: string };
  classA: string;
  classB: string;
  childA: string;
  childB: string;
  observationA: string;
}

async function seed(database: Client): Promise<SeedFacts> {
  const teacherA = { id: randomUUID(), username: `app1-a-${RUN}`, password: `app1-pass-${RUN}` };
  const teacherB = { id: randomUUID() };
  const teacherC = { id: randomUUID() };
  const admin = { id: randomUUID() };
  const classA = randomUUID();
  const classB = randomUUID();
  const childA = randomUUID();
  const childB = randomUUID();
  const observationA = randomUUID();
  await database.query(
    "INSERT INTO app_accounts (id, username, display_name, password_hash, role, status) VALUES ($1,$2,'甲老师',$3,'teacher','active')",
    [teacherA.id, teacherA.username, await hashPassword(teacherA.password)],
  );
  await database.query(
    "INSERT INTO app_accounts (id, username, display_name, password_hash, role, status) VALUES ($1,$2,'乙老师','test-never-logged-in','teacher','active')",
    [teacherB.id, `app1-b-${RUN}`],
  );
  await database.query(
    "INSERT INTO app_accounts (id, username, display_name, password_hash, role, status) VALUES ($1,$2,'丙老师','test-never-logged-in','teacher','active')",
    [teacherC.id, `app1-c-${RUN}`],
  );
  await database.query(
    "INSERT INTO app_accounts (id, username, display_name, password_hash, role, status) VALUES ($1,$2,'管理员','test-never-logged-in','admin','active')",
    [admin.id, `app1-admin-${RUN}`],
  );
  await database.query(
    "INSERT INTO classes (id, name, stage, school_year, is_active) VALUES ($1,'松果班','middle','2026',true), ($2,'云杉班','middle','2026',true)",
    [classA, classB],
  );
  await database.query(
    'INSERT INTO teacher_class_assignments (account_id, class_id) VALUES ($1,$2), ($3,$4)',
    [teacherA.id, classA, teacherB.id, classB],
  );
  await database.query(
    "INSERT INTO children (id, name, gender, birth_date, class_name) VALUES ($1,'王一诺','女','2021-01-01','松果班'), ($2,'郑小舟','男','2021-02-02','云杉班')",
    [childA, childB],
  );
  await database.query(
    "INSERT INTO child_class_enrollments (child_id, class_id, start_date) VALUES ($1,$2,'2026-01-01'), ($3,$4,'2026-01-01')",
    [childA, classA, childB, classB],
  );
  await database.query(
    `INSERT INTO observations (id, child_id, class_id, observed_at, raw_text, context, status, confirmed_at)
     VALUES ($1,$2,$3,'2026-03-02','王一诺今天在积木区搭了很久的高塔，还和同伴商量怎么放稳。','建构区','confirmed',now())`,
    [observationA, childA, classA],
  );
  return {
    teacherA,
    teacherB,
    teacherC,
    admin,
    classA,
    classB,
    childA,
    childB,
    observationA,
  };
}

/* --------------------------------- 模型替身服务 --------------------------------- */

interface StubStep {
  content?: string;
  status?: number;
  hold?: Promise<void>;
  delay_ms?: number;
  /** 响应前准备（在调用方进程执行，可做真实数据库/锁交错） */
  prepare?: () => Promise<void>;
}

interface StubScenario {
  tag: string;
  steps: StubStep[];
  count: number;
  bodies: string[];
  waiters: { at: number; resolve: () => void }[];
}

interface ModelStub {
  baseUrl: string;
  register(tag: string, steps: StubStep[]): StubScenario;
  requestCount(tag: string): number;
  waitForRequest(tag: string, at: number, timeoutMs?: number): Promise<void>;
  unexpected: string[];
  total: number;
  close(): Promise<void>;
}

function actionAnswer(content: string, refs: string[] = []): string {
  return JSON.stringify({ action: 'answer', content, tool: '', params_json: '', source_refs: refs });
}
function actionRead(tool: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: 'read',
    content: '',
    tool,
    params_json: JSON.stringify(params),
    source_refs: [],
  });
}
function actionPropose(tool: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: 'propose_write',
    content: '',
    tool,
    params_json: JSON.stringify(params),
    source_refs: [],
  });
}

async function startModelStub(): Promise<ModelStub> {
  const scenarios: StubScenario[] = [];
  const unexpected: string[] = [];
  let total = 0;
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const bodyText = Buffer.concat(chunks).toString('utf8');
      total += 1;
      if (!(request.url ?? '').endsWith('/chat/completions')) {
        response.statusCode = 404;
        response.end('{}');
        return;
      }
      const scenario = scenarios.find((entry) => bodyText.includes(entry.tag));
      if (!scenario) {
        unexpected.push(bodyText.slice(0, 400));
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content: actionAnswer('未登记场景') } }] }));
        return;
      }
      const index = scenario.count;
      scenario.count += 1;
      scenario.bodies.push(bodyText);
      for (const waiter of [...scenario.waiters]) {
        if (scenario.count >= waiter.at) {
          waiter.resolve();
          scenario.waiters.splice(scenario.waiters.indexOf(waiter), 1);
        }
      }
      const step = scenario.steps[Math.min(index, scenario.steps.length - 1)] ?? {};
      if (step.prepare) await step.prepare();
      if (step.hold) await step.hold.catch(() => undefined);
      if (step.delay_ms) await new Promise((resolve) => setTimeout(resolve, step.delay_ms));
      response.setHeader('content-type', 'application/json');
      if (step.status !== undefined && step.status !== 200) {
        response.statusCode = step.status;
        response.end(JSON.stringify({ error: { message: 'stub provider failure' } }));
        return;
      }
      response.statusCode = 200;
      response.end(
        JSON.stringify({
          choices: [{ message: { content: step.content ?? actionAnswer('替身回答') } }],
        }),
      );
    })().catch((error: unknown) => {
      console.error('stub handler error:', error);
      response.statusCode = 500;
      response.end('{}');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法启动模型替身');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    register(tag, steps) {
      const scenario: StubScenario = { tag, steps, count: 0, bodies: [], waiters: [] };
      scenarios.push(scenario);
      return scenario;
    },
    requestCount(tag) {
      return scenarios.find((entry) => entry.tag === tag)?.count ?? -1;
    },
    waitForRequest(tag, at, timeoutMs = 30_000) {
      const scenario = scenarios.find((entry) => entry.tag === tag);
      if (!scenario) return Promise.reject(new Error(`未登记场景：${tag}`));
      if (scenario.count >= at) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等待 ${tag} 第 ${at} 次请求超时`)), timeoutMs);
        scenario.waiters.push({
          at,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
    },
    unexpected,
    get total() {
      return total;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/* --------------------------------- HTTP 助手 --------------------------------- */

async function login(base: string, username: string, password: string) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json', 'x-cga-auth-request': '1' },
    body: JSON.stringify({ username, password }),
  });
  const body = (await response.json()) as {
    state?: { kind?: string };
    csrf?: { token?: string };
  };
  const rawCookie = response.headers
    .getSetCookie()
    .find((entry) => entry.startsWith(`${SESSION_COOKIE_NAME}=`));
  const cookie = rawCookie === undefined ? '' : rawCookie.split(';')[0] ?? '';
  return { status: response.status, body, cookie, csrf: body.csrf?.token ?? '' };
}

async function directSession(
  database: Client,
  accountId: string,
  ttlSeconds = 86_400,
): Promise<{ cookie: string; csrf: string; token: string }> {
  const token = createSessionToken();
  await database.query(
    'INSERT INTO app_sessions (account_id, token_hash, expires_at) VALUES ($1,$2,now()+make_interval(secs => $3))',
    [accountId, token.tokenHash, ttlSeconds],
  );
  return {
    cookie: `${SESSION_COOKIE_NAME}=${token.token}`,
    csrf: computeCsrfToken(token.token),
    token: token.token,
  };
}

async function createConversation(
  httpBase: string,
  auth: { cookie: string; csrf: string },
): Promise<{ status: number; conversation_id: string; revision: number }> {
  const response = await fetch(`${httpBase}/api/yaya/conversations`, {
    method: 'POST',
    headers: { origin: httpBase, cookie: auth.cookie, 'x-csrf-token': auth.csrf },
    body: JSON.stringify({ title: `[app1] ${randomUUID().slice(0, 8)}` }),
  });
  const body = (await response.json()) as {
    conversation?: { conversation_id?: string; revision?: number };
  };
  return {
    status: response.status,
    conversation_id: body.conversation?.conversation_id ?? '',
    revision: body.conversation?.revision ?? 0,
  };
}

async function saveMessage(
  httpBase: string,
  auth: { cookie: string; csrf: string },
  conversationId: string,
  expectedRevision: number,
  text: string,
  childId: string,
): Promise<{ status: number; revision: number }> {
  const response = await fetch(
    `${httpBase}/api/yaya/conversations/${conversationId}/messages`,
    {
      method: 'POST',
      headers: { origin: httpBase, cookie: auth.cookie, 'x-csrf-token': auth.csrf },
      body: JSON.stringify({
        client_message_id: `app1-${randomUUID()}`,
        role: 'user',
        message_kind: 'text',
        expected_conversation_revision: expectedRevision,
        fragments: [
          {
            fragment_id: `f-${randomUUID().slice(0, 8)}`,
            text,
            sources: [{ kind: 'child', child_id: childId, current_class_id: null }],
            independently_readable: true,
            provenance: {
              kind: 'child_fact',
              ref_id: `observation:${childId}`,
              label: '历史消息来源',
              derived_from: null,
            },
          },
        ],
        attachment_ids: [],
      }),
    },
  );
  const body = (await response.json()) as { conversation?: { revision?: number } };
  return { status: response.status, revision: body.conversation?.revision ?? 0 };
}

interface RunBodyInput {
  conversation_id: string;
  client_request_id: string;
  user_text: string;
  attachment_ids?: string[];
  expected_conversation_revision: number;
}

function runBody(input: RunBodyInput): string {
  return JSON.stringify({
    conversation_id: input.conversation_id,
    client_request_id: input.client_request_id,
    user_text: input.user_text,
    attachment_ids: input.attachment_ids ?? [],
    expected_conversation_revision: input.expected_conversation_revision,
  });
}

function postRun(
  httpBase: string,
  auth: { cookie: string; csrf: string },
  conversationId: string,
  body: string,
): Promise<Response> {
  return fetch(`${httpBase}/api/yaya/conversations/${conversationId}/runs`, {
    method: 'POST',
    headers: { origin: httpBase, cookie: auth.cookie, 'x-csrf-token': auth.csrf },
    body,
  });
}

function lookupRun(
  httpBase: string,
  auth: { cookie: string; csrf?: string },
  conversationId: string,
  clientRequestId: string,
): Promise<Response> {
  return fetch(
    `${httpBase}/api/yaya/conversations/${conversationId}/runs?client_request_id=${encodeURIComponent(
      clientRequestId,
    )}`,
    { headers: { origin: httpBase, cookie: auth.cookie } },
  );
}

function cancelRun(
  httpBase: string,
  auth: { cookie: string; csrf: string },
  runId: string,
  body = '',
): Promise<Response> {
  return fetch(`${httpBase}/api/yaya/runs/${runId}/cancel`, {
    method: 'POST',
    headers: { origin: httpBase, cookie: auth.cookie, 'x-csrf-token': auth.csrf },
    body,
  });
}

interface NdjsonStream {
  lines: string[];
  runId: string;
  firstLine: string;
  readLine(): Promise<string | null>;
  collect(): Promise<string[]>;
}

function openNdjson(response: Response): NdjsonStream {
  assert.ok(response.body, '响应没有可读流');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const lines: string[] = [];
  let done = false;
  async function readLine(): Promise<string | null> {
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() !== '') lines.push(line);
        return line;
      }
      if (done) {
        if (buffer.trim() !== '') {
          lines.push(buffer);
          buffer = '';
        }
        return null;
      }
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
      } else {
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    }
  }
  const stream: NdjsonStream = {
    lines,
    runId: '',
    firstLine: '',
    readLine,
    async collect() {
      for (;;) {
        const line = await readLine();
        if (line === null) return [...lines];
      }
    },
  };
  return stream;
}

/**
 * 逐行读到 action_parsed（引擎发布前重核已过）或终局；返回是否看到 action_parsed。
 * `action` 限定动作：多步流里首个 action_parsed 属于 read，等到 answer 才意味着
 * 答案动作的发布前重核已过、引擎即将进入保存边界。
 */
async function readUntilActionParsed(
  stream: NdjsonStream,
  action?: Extract<YayaRunWireEvent, { type: 'action_parsed' }>['action'],
): Promise<boolean> {
  for (;;) {
    const line = await readLineWithin(stream, 30_000);
    if (line === null) return false;
    const entry = parseYayaRunWireLine(line);
    if (!entry.ok) continue;
    if (entry.value.type === 'action_parsed') {
      if (action === undefined || entry.value.action === action) return true;
      continue;
    }
    if (entry.value.type === 'run_end') return false;
  }
}

async function readLineWithin(stream: NdjsonStream, timeoutMs: number): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      stream.readLine(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`等待流事件超时（${timeoutMs}ms）`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseLines(lines: string[]): {
  allParsed: boolean;
  events: YayaRunWireEvent[];
  verdict: ReturnType<typeof validateYayaRunEventStream>;
} {
  const parsed = lines.map((line) => parseYayaRunWireLine(line));
  const allParsed = parsed.every((entry) => entry.ok);
  const events = parsed
    .map((entry) => (entry.ok ? entry.value : null))
    .filter((entry): entry is YayaRunWireEvent => entry !== null);
  return { allParsed, events, verdict: validateYayaRunEventStream(events) };
}

/* --------------------------------- 主流程 --------------------------------- */

async function pickFreePort(): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const port = 22000 + Math.floor(Math.random() * 8000);
    const listeners = findListeningPids(port);
    if (listeners.ok && listeners.pids.length === 0) return port;
    if (!listeners.ok) throw new Error(`端口探测失败：${listeners.detail}`);
  }
  throw new Error('无法找到空闲端口');
}

interface ServerHandle {
  tracked: TrackedChild;
  base: string;
  port: number;
  logFile: string;
}

async function startNext(
  label: string,
  env: NodeJS.ProcessEnv,
): Promise<ServerHandle> {
  const port = await pickFreePort();
  const base = `http://127.0.0.1:${port}`;
  const logFile = path.join(os.tmpdir(), 'opencode', `yaya-${label}-${RUN}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, '');
  const child = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)],
    {
      cwd: ROOT,
      env: { ...env, AUTH_TRUSTED_ORIGINS: base },
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const tracked = trackChildProcess(child, { logFile });
  child.stdout?.on('data', (chunk: Buffer) => fs.appendFileSync(logFile, chunk));
  child.stderr?.on('data', (chunk: Buffer) => fs.appendFileSync(logFile, chunk));
  stage(`${label}: next spawned pid=${child.pid} port=${port}`);
  await waitForVerifiedService({
    base,
    port,
    child: tracked,
    timeoutMs: 300_000,
    statusPath: '/api/auth/status',
  });
  stage(`${label}: next ready`);
  return { tracked, base, port, logFile };
}

async function main(): Promise<void> {
  const artifactSnapshot = snapshotGeneratedArtifacts(ROOT);
  const cleanupIssues: string[] = [];
  let isolated: IsolatedPostgres | null = null;
  let database: Client | null = null;
  let mediaRoot: string | null = null;
  let stub: ModelStub | null = null;
  let server1: ServerHandle | null = null;
  let server2: ServerHandle | null = null;
  let r2Racer: Client | null = null;
  let r2Lock: Client | null = null;
  const gates: Array<() => void> = [];

  try {
    isolated = await startIsolatedPostgres({
      runId: RUN,
      containerName: `yaya-agent-app1-${RUN}`,
      dbName: 'yaya_agent_app1',
      labelKey: LABEL_KEY,
    });
    const url = isolated.url;
    database = new Client({ connectionString: url });
    await database.connect();
    await database.query("SET TIME ZONE 'UTC'");
    await runMigrations(database);
    const facts = await seed(database);
    stage('migrated+seeded');

    stub = await startModelStub();

    stub.register('[app1:basic]', [{ content: actionAnswer('你好，可以聊聊保教工作。') }]);
    stub.register('[app1:read]', [
      { content: actionRead('list_children') },
      { content: actionAnswer('已按当前范围列出可读幼儿。', ['children:current_scope']) },
    ]);
    stub.register('[app1:tworeads]', [
      { content: actionRead('list_children') },
      { content: actionRead('list_observations') },
      { content: actionAnswer('综合早先读到的名单回答。', ['children:current_scope']) },
    ]);
    const raceGate = deferred();
    gates.push(raceGate.resolve);
    stub.register('[app1:race]', [{ hold: raceGate.promise }, { content: actionAnswer('竞赛完成。') }]);
    const cancelGate = deferred();
    gates.push(cancelGate.resolve);
    stub.register('[app1:cancel]', [{ hold: cancelGate.promise }, { content: actionAnswer('取消后不应发布。') }]);
    const revokeGate = deferred();
    gates.push(revokeGate.resolve);
    stub.register('[app1:revoke]', [
      { content: actionRead('list_children') },
      { hold: revokeGate.promise },
      // 终答不引用任何来源：验证 source_refs=[] 不豁免已加载上下文的重核。
      { content: actionAnswer('撤权后不应发布。') },
    ]);
    const sessionGate = deferred();
    gates.push(sessionGate.resolve);
    stub.register('[app1:session]', [
      { hold: sessionGate.promise },
      { content: actionAnswer('会话失效后不应发布。') },
    ]);
    const disableGate = deferred();
    gates.push(disableGate.resolve);
    stub.register('[app1:disable]', [
      { hold: disableGate.promise },
      { content: actionAnswer('账号停用后不应发布。') },
    ]);
    const replaceGate = deferred();
    gates.push(replaceGate.resolve);
    stub.register('[app1:replace]', [{ hold: replaceGate.promise }, { content: actionAnswer('被替换的迟到回答。') }]);
    stub.register('[app1:gate]', [
      { content: actionRead('list_children') },
      { content: actionAnswer('基于名单的回答。', ['children:current_scope']) },
    ]);
    const historyScenario = stub.register('[app1:history]', [
      { content: actionAnswer('结合历史消息回答。') },
    ]);
    stub.register('[app1:modelfail]', [{ status: 500 }]);
    stub.register('[app1:unknownread]', [{ content: actionRead('delete_all_children') }]);
    stub.register('[app1:sourcemismatch]', [
      { content: actionAnswer('引用不存在的来源。', ['ghost:1']) },
    ]);
    stub.register('[app1:writeintent]', [
      { content: actionPropose('create_observation', { child_id: facts.childA, raw_text: 'x' }) },
    ]);
    stub.register('[app1:admin]', [{ content: actionAnswer('管理员的一般问答。') }]);
    const crossCancelGate = deferred();
    gates.push(crossCancelGate.resolve);
    stub.register('[app1:crosscancel]', [
      { hold: crossCancelGate.promise },
      { content: actionAnswer('跨进程取消后不应发布。') },
    ]);
    const full2histGate = deferred();
    gates.push(full2histGate.resolve);
    const histreadScenario = stub.register('[app1:histread]', [
      { content: actionRead('get_observation', { observation_id: facts.observationA }) },
      { content: actionAnswer('历史只读最小查询。', [`observation:${facts.observationA}`]) },
    ]);
    const full2histScenario = stub.register('[app1:full2hist]', [
      { content: actionRead('get_observation', { observation_id: facts.observationA }) },
      { hold: full2histGate.promise, content: actionAnswer('投影降级后不应发布。') },
    ]);
    stub.register('[app1:fullanswer]', [
      { content: actionRead('get_observation', { observation_id: facts.observationA }) },
      { content: actionAnswer('完整投影回答。', [`observation:${facts.observationA}`]) },
    ]);
    stub.register('[app1:persistfail]', [{ content: actionAnswer('落账失败前不应发布。') }]);
    stub.register('[app1:depcorrupt]', [{ content: actionAnswer('依赖完整性对照回答。') }]);
    const lostGate = deferred();
    gates.push(lostGate.resolve);
    stub.register('[app1:lost]', [
      { hold: lostGate.promise },
      { content: actionAnswer('进程失联后不应发布。') },
    ]);

    mediaRoot = await mkdtemp(path.join(os.tmpdir(), 'yaya-agent-app1-media-'));
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: url,
      AUTH_SCHOOL_ID: SCHOOL_ID,
      MEDIA_ENVIRONMENT: 'development',
      MEDIA_STORAGE_MODE: 'local',
      MEDIA_LOCAL_ROOT: mediaRoot,
      NEXT_TELEMETRY_DISABLED: '1',
      LLM_PROVIDER: 'stepfun',
      STEPFUN_API_KEY: 'app1-stub-key',
      STEPFUN_BASE_URL: stub.baseUrl,
      STEPFUN_MODEL: 'app1-stub-model',
      STEPFUN_TIMEOUT_MS: '30000',
    };
    // 检查进程自身也接同一隔离库/媒体根（跨进程数据访问与依赖重核）。
    process.env.DATABASE_URL = url;
    delete process.env.PGDATABASE_URL;
    process.env.AUTH_SCHOOL_ID = SCHOOL_ID;
    process.env.MEDIA_ENVIRONMENT = 'development';
    process.env.MEDIA_STORAGE_MODE = 'local';
    process.env.MEDIA_LOCAL_ROOT = mediaRoot;
    process.env.AUTH_TRUSTED_ORIGINS = 'http://127.0.0.1:3000';

    server1 = await startNext('s1', childEnv);
    const base = server1.base;

    /* ============================== 认证边界 ============================== */

    const anonymousRun = await fetch(
      `${base}/api/yaya/conversations/${randomUUID()}/runs`,
      { method: 'POST', body: '{}' },
    );
    check('匿名发起被拒（HTTP 错误，非流）', anonymousRun.status === 401);
    const anonymousLookup = await lookupRun(base, { cookie: '' }, randomUUID(), 'x');
    check('匿名查询被拒', anonymousLookup.status === 401);
    const anonymousCancel = await cancelRun(base, { cookie: '', csrf: '' }, randomUUID());
    check('匿名取消被拒', anonymousCancel.status === 401);

    const loginA = await login(base, facts.teacherA.username, facts.teacherA.password);
    check('真实登录成功（AUTH 会话 + CSRF）', loginA.status === 200 && loginA.body.state?.kind === 'authenticated');
    const authA = { cookie: loginA.cookie, csrf: loginA.csrf };
    const loginToken = loginA.cookie.slice(`${SESSION_COOKIE_NAME}=`.length);
    const sessionExpiryBefore = await database.query<{ expires_at: Date }>(
      'SELECT expires_at FROM app_sessions WHERE token_hash = $1',
      [hashSessionToken(loginToken)],
    );
    const authB = await directSession(database, facts.teacherB.id);
    const authC = await directSession(database, facts.teacherC.id);
    const authAdmin = await directSession(database, facts.admin.id);

    const convA = await createConversation(base, authA);
    check('真实会话创建（A）', convA.status === 201 && convA.revision === 1);
    const convB = await createConversation(base, authB);
    const convC = await createConversation(base, authC);
    const convAdmin = await createConversation(base, authAdmin);
    check('真实会话创建（B/C/管理员）', convB.status === 201 && convC.status === 201 && convAdmin.status === 201);

    const crossRunBody = runBody({
      conversation_id: convA.conversation_id,
      client_request_id: `cross-${randomUUID()}`,
      user_text: '[app1:basic] 越权',
      expected_conversation_revision: convA.revision,
    });
    const crossB = await postRun(base, authB, convA.conversation_id, crossRunBody);
    check('他人会话发起被拒（404，不泄漏存在性）', crossB.status === 404);
    const crossAdmin = await postRun(base, authAdmin, convA.conversation_id, crossRunBody);
    check('管理员对他人会话发起被拒', crossAdmin.status === 404);
    const badCsrf = await fetch(`${base}/api/yaya/conversations/${convA.conversation_id}/runs`, {
      method: 'POST',
      headers: { origin: base, cookie: authA.cookie, 'x-csrf-token': 'wrong' },
      body: crossRunBody,
    });
    check('错误 CSRF 发起被拒（403）', badCsrf.status === 403);
    const forgedBody = JSON.stringify({
      conversation_id: convA.conversation_id,
      client_request_id: `forged-${randomUUID()}`,
      user_text: 'hi',
      attachment_ids: [],
      expected_conversation_revision: convA.revision,
      principal: { account_id: authB.token },
    });
    const forged = await postRun(base, authA, convA.conversation_id, forgedBody);
    check('自报 Principal 的请求被拒（400）', forged.status === 400);

    /* ============================== 一般问答 / 空任教 ============================== */

    const basicId = `basic-${randomUUID()}`;
    const basicResponse = await postRun(
      base,
      authA,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: basicId,
        user_text: '[app1:basic] 你好',
        expected_conversation_revision: convA.revision,
      }),
    );
    check(
      '发起响应为 NDJSON（200）',
      basicResponse.status === 200 &&
        (basicResponse.headers.get('content-type') ?? '').startsWith('application/x-ndjson'),
    );
    const basicStream = openNdjson(basicResponse);
    const basicLines = await basicStream.collect();
    const basicParsed = parseLines(basicLines);
    check('全部行均为合法 API0 线事件', basicParsed.allParsed);
    check(
      '唯一 run_end 且与 answer 一致',
      basicParsed.verdict.ok && basicParsed.verdict.outcome.kind === 'answered',
    );
    const basicRunId = basicParsed.verdict.ok ? basicParsed.verdict.run_id : '';
    const usageEvent = basicParsed.events.find((event) => event.type === 'model_completed');
    check(
      'usage 未知记 null（不填 0）',
      usageEvent !== undefined && usageEvent.type === 'model_completed' && usageEvent.usage === null,
    );
    check('模型替换请求 1 次', stub.requestCount('[app1:basic]') === 1);

    const basicLookup = await lookupRun(base, authA, convA.conversation_id, basicId);
    const basicLookupBody = (await basicLookup.json()) as {
      status?: string;
      run_id?: string;
      outcome?: { kind?: string; content?: string };
    };
    check(
      '查询返回 finished 且与流终态一致',
      basicLookup.status === 200 &&
        basicLookupBody.status === 'finished' &&
        basicLookupBody.run_id === basicRunId &&
        basicLookupBody.outcome?.kind === 'answered' &&
        basicLookupBody.outcome?.content === '你好，可以聊聊保教工作。',
    );
    const beforeLookupCount = stub.total;
    await lookupRun(base, authA, convA.conversation_id, basicId);
    check('查询不调用模型', stub.total === beforeLookupCount);

    const operationsProbe = await fetch(
      `${base}/api/yaya/operations?operation_id=${randomUUID()}`,
      { headers: { origin: base, cookie: authA.cookie } },
    );
    check('原 operation 查询不触发模型', stub.total === beforeLookupCount && operationsProbe.status < 500);

    const unassignedId = `c-general-${randomUUID()}`;
    const unassignedResponse = await postRun(
      base,
      authC,
      convC.conversation_id,
      runBody({
        conversation_id: convC.conversation_id,
        client_request_id: unassignedId,
        user_text: '[app1:basic] 空任教也能一般问答',
        expected_conversation_revision: convC.revision,
      }),
    );
    const unassignedStream = openNdjson(unassignedResponse);
    const unassignedParsed = parseLines(await unassignedStream.collect());
    check(
      '空任教账号一般问答可回答',
      unassignedResponse.status === 200 && unassignedParsed.verdict.ok &&
        unassignedParsed.verdict.outcome.kind === 'answered',
    );

    const adminId = `admin-${randomUUID()}`;
    const adminResponse = await postRun(
      base,
      authAdmin,
      convAdmin.conversation_id,
      runBody({
        conversation_id: convAdmin.conversation_id,
        client_request_id: adminId,
        user_text: '[app1:admin] 一般问答',
        expected_conversation_revision: convAdmin.revision,
      }),
    );
    const adminParsed = parseLines(await openNdjson(adminResponse).collect());
    check(
      '管理员一般问答可回答（非教学动作）',
      adminParsed.verdict.ok && adminParsed.verdict.outcome.kind === 'answered',
    );

    /* ============================== 查询边界 ============================== */

    const missingParam = await fetch(
      `${base}/api/yaya/conversations/${convA.conversation_id}/runs`,
      { headers: { origin: base, cookie: authA.cookie } },
    );
    check('查询缺少 client_request_id → 400', missingParam.status === 400);
    const missingRun = await lookupRun(base, authA, convA.conversation_id, `nope-${randomUUID()}`);
    check('查询不存在 → missing', ((await missingRun.json()) as { status?: string }).status === 'missing');
    const otherConvLookup = await lookupRun(base, authB, convA.conversation_id, basicId);
    check('查询他人会话 → 404', otherConvLookup.status === 404);
    const sessionExpiryAfter = await database.query<{ expires_at: Date }>(
      'SELECT expires_at FROM app_sessions WHERE token_hash = $1',
      [hashSessionToken(loginToken)],
    );
    check(
      '查询不续期会话（expires_at 不变）',
      sessionExpiryBefore.rows[0] !== undefined &&
        sessionExpiryAfter.rows[0] !== undefined &&
        sessionExpiryBefore.rows[0].expires_at.getTime() === sessionExpiryAfter.rows[0].expires_at.getTime(),
    );

    /* ============================== 幂等与双连接竞争 ============================== */

    const beforeReplayCount = stub.requestCount('[app1:basic]');
    const replayResponse = await postRun(
      base,
      authA,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: basicId,
        user_text: '[app1:basic] 你好',
        expected_conversation_revision: convA.revision,
      }),
    );
    const replayParsed = parseLines(await openNdjson(replayResponse).collect());
    check(
      '同键同内容终态回放（同 run_id / 同终态 / 不再派发模型）',
      replayResponse.status === 200 &&
        replayParsed.verdict.ok &&
        replayParsed.verdict.run_id === basicRunId &&
        replayParsed.verdict.outcome.kind === 'answered' &&
        replayParsed.verdict.outcome.content === '你好，可以聊聊保教工作。' &&
        stub.requestCount('[app1:basic]') === beforeReplayCount,
    );
    const conflictResponse = await postRun(
      base,
      authA,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: basicId,
        user_text: '[app1:basic] 你好（改内容）',
        expected_conversation_revision: convA.revision,
      }),
    );
    const conflictBody = (await conflictResponse.json()) as { error?: string };
    check(
      '同键异内容 → 409 idempotency_conflict',
      conflictResponse.status === 409 && conflictBody.error === 'idempotency_conflict',
    );

    const raceId = `race-${randomUUID()}`;
    const raceBody = runBody({
      conversation_id: convA.conversation_id,
      client_request_id: raceId,
      user_text: '[app1:race] 双连接',
      expected_conversation_revision: convA.revision,
    });
    const raceAResponsePromise = postRun(base, authA, convA.conversation_id, raceBody);
    await stub.waitForRequest('[app1:race]', 1);
    const raceBResponse = await postRun(base, authA, convA.conversation_id, raceBody);
    const raceBBody = (await raceBResponse.json()) as { error?: string };
    check(
      '双连接竞争：第二条不派发（409 operation_started）',
      raceBResponse.status === 409 && raceBBody.error === 'operation_started',
    );
    raceGate.resolve();
    const raceAResponse = await raceAResponsePromise;
    const raceAParsed = parseLines(await openNdjson(raceAResponse).collect());
    check(
      '双连接竞争：第一条正常完成且模型只派发一次',
      raceAResponse.status === 200 && raceAParsed.verdict.ok &&
        raceAParsed.verdict.outcome.kind === 'answered' &&
        stub.requestCount('[app1:race]') === 1,
    );

    /* ============================== 读取 / 来源协议 / run 依赖 ============================== */

    const readId = `read-${randomUUID()}`;
    const readResponse = await postRun(
      base,
      authA,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: readId,
        user_text: '[app1:read] 列出可读幼儿',
        expected_conversation_revision: convA.revision,
      }),
    );
    const readParsed = parseLines(await openNdjson(readResponse).collect());
    check(
      '真实 READ1 读取后回答并引用 citable_source',
      readParsed.verdict.ok &&
        readParsed.verdict.outcome.kind === 'answered' &&
        readParsed.verdict.outcome.sources.some((source) => source.ref_id === 'children:current_scope'),
    );
    const readRunId = readParsed.verdict.ok ? readParsed.verdict.run_id : '';
    const readRunRow = await loadYayaRun(readRunId);
    const depRefIds = (readRunRow?.dependencies ?? []).map((entry) => entry.ref?.ref_id ?? '');
    check(
      'run 依赖累积 citable 与完整子依赖',
      depRefIds.includes('children:current_scope') &&
        depRefIds.includes(`child:${facts.childA}`),
    );

    const twoReadsId = `tworeads-${randomUUID()}`;
    const twoReadsResponse = await postRun(
      base,
      authA,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: twoReadsId,
        user_text: '[app1:tworeads] 先列幼儿再列观察',
        expected_conversation_revision: convA.revision,
      }),
    );
    const twoReadsParsed = parseLines(await openNdjson(twoReadsResponse).collect());
    const twoReadsRow = twoReadsParsed.verdict.ok ? await loadYayaRun(twoReadsParsed.verdict.run_id) : null;
    const twoReadsDepIds = (twoReadsRow?.dependencies ?? []).map((entry) => entry.ref?.ref_id ?? '');
    check(
      '后续读取不覆盖早先依赖（两次读取依赖并存）',
      twoReadsParsed.verdict.ok &&
        twoReadsParsed.verdict.outcome.kind === 'answered' &&
        twoReadsParsed.verdict.outcome.sources.some((source) => source.ref_id === 'children:current_scope') &&
        twoReadsDepIds.includes('observations:current_scope') &&
        twoReadsDepIds.includes('children:current_scope'),
    );

    /* ============================== 历史投影 ============================== */

    const historyConv = await createConversation(base, authA);
    const savedMessage = await saveMessage(
      base,
      authA,
      historyConv.conversation_id,
      historyConv.revision,
      '历史：王一诺在积木区搭了高塔。',
      facts.childA,
    );
    check('真实 DATA 保存历史消息（版本推进）', savedMessage.status === 201 && savedMessage.revision === 2);
    const historyId = `history-${randomUUID()}`;
    const historyResponse = await postRun(
      base,
      authA,
      historyConv.conversation_id,
      runBody({
        conversation_id: historyConv.conversation_id,
        client_request_id: historyId,
        user_text: '[app1:history] 结合历史回答',
        expected_conversation_revision: savedMessage.revision,
      }),
    );
    const historyParsed = parseLines(await openNdjson(historyResponse).collect());
    check(
      '历史消息按当前投影进入模型上下文',
      historyParsed.verdict.ok &&
        historyParsed.verdict.outcome.kind === 'answered' &&
        historyScenario.count === 1 &&
        (historyScenario.bodies[0] ?? '').includes('历史：王一诺在积木区搭了高塔。'),
    );
    const historyRunId = historyParsed.verdict.ok ? historyParsed.verdict.run_id : '';
    const historyRow = await loadYayaRun(historyRunId);
    check(
      '历史片段登记为 run 级依赖',
      (historyRow?.dependencies ?? []).some((entry) => entry.message_id !== null),
    );

    /* ============================== 撤权 / run 替换 ============================== */

    // 模型等待期间撤权：私有依赖已装载，撤权后不得发布回答。
    const revokeId = `revoke-${randomUUID()}`;
    const revokeResponsePromise = postRun(
      base,
      authA,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: revokeId,
        user_text: '[app1:revoke] 撤权测试',
        expected_conversation_revision: convA.revision,
      }),
    );
    await stub.waitForRequest('[app1:revoke]', 2);
    await database.query(
      'UPDATE teacher_class_assignments SET removed_at = now() WHERE account_id = $1 AND class_id = $2',
      [facts.teacherA.id, facts.classA],
    );
    revokeGate.resolve();
    const revokeParsed = parseLines(await openNdjson(await revokeResponsePromise).collect());
    check(
      '模型等待期间撤权 → context_revoked 且不发布回答',
      revokeParsed.verdict.ok &&
        revokeParsed.verdict.outcome.kind === 'stopped' &&
        revokeParsed.verdict.outcome.reason === 'context_revoked' &&
        !revokeParsed.events.some((event) => event.type === 'answer'),
    );
    const revokeRunId = revokeParsed.verdict.ok ? revokeParsed.verdict.run_id : '';
    const revokedPrincipal: Principal = {
      account_id: facts.teacherA.id,
      username: facts.teacherA.username,
      display_name: '甲老师',
      role: 'teacher',
      account_status: 'active',
      scope: { kind: 'classes', class_ids: [] },
    };
    const revokedRunRow = await loadYayaRun(revokeRunId);
    const revokedVerdict = revokedRunRow
      ? await revalidateYayaRunContext(
          createYayaRunRuntimeStateFromRecord(revokedRunRow, {
            headers: new Headers({ cookie: authA.cookie }),
          }),
          {
            run_id: revokedRunRow.run_id,
            identity: {
              run_id: revokedRunRow.run_id,
              identity_state: 'authenticated',
              principal: revokedPrincipal,
              session_valid: true,
            },
            sources: [],
            image_ids: [],
          },
          { principal: revokedPrincipal },
        )
      : null;
    check(
      '独立进程重核：撤权后依赖被判 context_revoked',
      revokedVerdict !== null && !revokedVerdict.ok && revokedVerdict.denied_refs.length > 0,
    );
    await database.query(
      'UPDATE teacher_class_assignments SET removed_at = NULL WHERE account_id = $1 AND class_id = $2',
      [facts.teacherA.id, facts.classA],
    );

    // run 替换：持久化 replaced_by 后，迟到结果不得发布、不得覆盖新运行。
    const replaceId = `replace-${randomUUID()}`;
    const replaceResponsePromise = postRun(
      base,
      authA,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: replaceId,
        user_text: '[app1:replace] 替换测试',
        expected_conversation_revision: convA.revision,
      }),
    );
    await stub.waitForRequest('[app1:replace]', 1);
    const activeReplace = await database.query<{ id: string }>(
      "SELECT id FROM yaya_runs WHERE client_request_id = $1 AND state = 'active'",
      [replaceId],
    );
    const replaceRunId = activeReplace.rows[0]?.id ?? '';
    await database.query("UPDATE yaya_runs SET replaced_by = $2, updated_at = now() WHERE id = $1", [
      replaceRunId,
      randomUUID(),
    ]);
    replaceGate.resolve();
    const replaceParsed = parseLines(await openNdjson(await replaceResponsePromise).collect());
    check(
      'run 替换 → 迟到结果不发布（stopped run_replaced）',
      replaceParsed.verdict.ok &&
        replaceParsed.verdict.outcome.kind === 'stopped' &&
        replaceParsed.verdict.outcome.reason === 'run_replaced' &&
        !replaceParsed.events.some((event) => event.type === 'answer'),
    );
    const replacedRow = await loadYayaRun(replaceRunId);
    check(
      '被替换 run 的终态落库为 stopped 且未被迟到回答覆盖',
      replacedRow !== null &&
        replacedRow.state === 'terminal' &&
        (replacedRow.outcome as { kind?: string; reason?: string }).kind === 'stopped' &&
        (replacedRow.outcome as { reason?: string }).reason === 'run_replaced',
    );

    // 终态投影：私域回答在撤权后查询为不可核验，恢复后重新可读。
    const gateId = `gate-${randomUUID()}`;
    const gateResponse = await postRun(
      base,
      authA,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: gateId,
        user_text: '[app1:gate] 投影测试',
        expected_conversation_revision: convA.revision,
      }),
    );
    const gateParsed = parseLines(await openNdjson(gateResponse).collect());
    check('投影基线 run 正常回答', gateParsed.verdict.ok && gateParsed.verdict.outcome.kind === 'answered');
    await database.query(
      'UPDATE teacher_class_assignments SET removed_at = now() WHERE account_id = $1 AND class_id = $2',
      [facts.teacherA.id, facts.classA],
    );
    const gatedLookup = await lookupRun(base, authA, convA.conversation_id, gateId);
    const gatedBody = (await gatedLookup.json()) as { status?: string; reason?: string };
    check(
      '撤权后终态恢复不可核验（不返回旧私域内容）',
      gatedBody.status === 'unverifiable' && gatedBody.reason === 'terminal_unreadable',
    );
    await database.query(
      'UPDATE teacher_class_assignments SET removed_at = NULL WHERE account_id = $1 AND class_id = $2',
      [facts.teacherA.id, facts.classA],
    );
    const restoredLookup = await lookupRun(base, authA, convA.conversation_id, gateId);
    const restoredBody = (await restoredLookup.json()) as { status?: string; outcome?: { kind?: string } };
    check(
      '恢复授权后终态恢复重新可读',
      restoredBody.status === 'finished' && restoredBody.outcome?.kind === 'answered',
    );
    const restoredConvoLookup = await lookupRun(base, authA, historyConv.conversation_id, historyId);
    const restoredHistoryBody = (await restoredConvoLookup.json()) as { status?: string };
    check('历史依赖 run 恢复授权后可读', restoredHistoryBody.status === 'finished');

    /* ============================== 取消 ============================== */

    const cancelId = `cancel-${randomUUID()}`;
    const cancelResponsePromise = postRun(
      base,
      authA,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: cancelId,
        user_text: '[app1:cancel] 取消测试',
        expected_conversation_revision: convA.revision,
      }),
    );
    await stub.waitForRequest('[app1:cancel]', 1);
    // 事件在模型等待期间已逐条到达客户端：证明业务事件及时写出（无整体缓冲）。
    const cancelResponse = await cancelResponsePromise;
    const cancelStream = openNdjson(cancelResponse);
    const cancelFirst = parseYayaRunWireLine((await readLineWithin(cancelStream, 10_000)) ?? '');
    const cancelSecond = parseYayaRunWireLine((await readLineWithin(cancelStream, 10_000)) ?? '');
    check(
      '模型等待期间 run_started/model_attempted 已及时写出（逐条 flush）',
      cancelFirst.ok &&
        cancelFirst.value.type === 'run_started' &&
        cancelSecond.ok &&
        cancelSecond.value.type === 'model_attempted',
    );
    // 首响应丢失恢复：按原 client_request_id 查回进行中的运行，不重复派发。
    const inProgressLookup = await lookupRun(base, authA, convA.conversation_id, cancelId);
    const inProgressBody = (await inProgressLookup.json()) as { status?: string; run_id?: string };
    check(
      '运行中查询返回 in_progress + 原 run_id（首响应丢失恢复）',
      inProgressBody.status === 'in_progress' && inProgressBody.run_id !== '',
    );
    const beforeInProgress = stub.requestCount('[app1:cancel]');
    await lookupRun(base, authA, convA.conversation_id, cancelId);
    check('运行中查询不派发模型', stub.requestCount('[app1:cancel]') === beforeInProgress);
    const activeCancel = await database.query<{ id: string }>(
      "SELECT id FROM yaya_runs WHERE client_request_id = $1 AND state = 'active'",
      [cancelId],
    );
    const cancelRunId = activeCancel.rows[0]?.id ?? '';
    check('取消前运行已持久化为活跃（先登记后派发）', cancelRunId !== '');
    const cancelResponse2 = await cancelRun(base, authA, cancelRunId);
    const cancelBody = (await cancelResponse2.json()) as Record<string, unknown>;
    check(
      '取消响应固定三布尔（不撤销已提交业务/不声称物理取消）',
      cancelResponse2.status === 200 &&
        cancelBody.status === 'cancel_requested' &&
        cancelBody.stops_subsequent_dispatch === true &&
        cancelBody.rolls_back_committed_business === false &&
        cancelBody.upstream_http_cancel_verified === false,
    );
    cancelGate.resolve();
    const cancelParsed = parseLines(await cancelStream.collect());
    check(
      '取消后流以 stopped(cancelled) 显式结束',
      cancelParsed.verdict.ok &&
        cancelParsed.verdict.outcome.kind === 'stopped' &&
        cancelParsed.verdict.outcome.reason === 'cancelled' &&
        !cancelParsed.events.some((event) => event.type === 'answer'),
    );
    const cancelledLookup = await lookupRun(base, authA, convA.conversation_id, cancelId);
    const cancelledBody = (await cancelledLookup.json()) as { status?: string; outcome?: { kind?: string; reason?: string } };
    check(
      '取消后查询终态一致（finished + stopped cancelled）',
      cancelledBody.status === 'finished' &&
        cancelledBody.outcome?.kind === 'stopped' &&
        cancelledBody.outcome?.reason === 'cancelled',
    );
    const cancelAgain = await cancelRun(base, authA, cancelRunId);
    check('重复取消幂等（固定响应）', cancelAgain.status === 200);
    const cancelBadBody = await cancelRun(base, authA, cancelRunId, JSON.stringify({ approved: true }));
    check('取消请求体非空被拒（400）', cancelBadBody.status === 400);
    const cancelOther = await cancelRun(base, authB, cancelRunId);
    check('取消他人运行 → 404', cancelOther.status === 404);
    const cancelUnknown = await cancelRun(base, authA, randomUUID());
    check('取消不存在运行 → 404', cancelUnknown.status === 404);

    /* ============================== 跨进程取消（检查进程直接持久化） ============================== */

    const crossCancelId = `crosscancel-${randomUUID()}`;
    const crossCancelPromise = postRun(
      base,
      authA,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: crossCancelId,
        user_text: '[app1:crosscancel] 跨进程取消',
        expected_conversation_revision: convA.revision,
      }),
    );
    await stub.waitForRequest('[app1:crosscancel]', 1);
    const crossCancelRows = await database.query<{ id: string; owner_instance: string; state: string }>(
      'SELECT id, owner_instance, state FROM yaya_runs WHERE client_request_id = $1',
      [crossCancelId],
    );
    const crossCancelRunId = crossCancelRows.rows[0]?.id ?? '';
    const crossCancelOwner = crossCancelRows.rows[0]?.owner_instance ?? '';
    check('跨进程可见活跃 run（持久化）', crossCancelRows.rows[0]?.state === 'active');
    await database.query(
      'UPDATE yaya_runs SET cancel_requested_at = now(), updated_at = now() WHERE id = $1',
      [crossCancelRunId],
    );
    crossCancelGate.resolve();
    const crossCancelParsed = parseLines(await openNdjson(await crossCancelPromise).collect());
    check(
      '检查进程持久化取消后，owner 进程在边界停止后续派发',
      crossCancelParsed.verdict.ok &&
        crossCancelParsed.verdict.outcome.kind === 'stopped' &&
        crossCancelParsed.verdict.outcome.reason === 'cancelled',
    );
    const assertAfterCancel = await withTransaction(async (client) =>
      assertYayaRunActive(client, crossCancelRunId, crossCancelOwner).then(
        () => 'allowed',
        () => 'rejected',
      ),
    );
    check('TOOLS1 保存前钩子：已取消 run 拒绝保存', assertAfterCancel === 'rejected');
    const basicRowForHook = await loadYayaRun(basicRunId);
    const assertAfterTerminal = await withTransaction(async (client) =>
      assertYayaRunActive(client, basicRunId, basicRowForHook?.owner_instance ?? '').then(
        () => 'allowed',
        () => 'rejected',
      ),
    );
    check('TOOLS1 保存前钩子：终态 run 拒绝保存', assertAfterTerminal === 'rejected');

    /* ============================== 会话失效 / 账号停用 / 身份服务失败 ============================== */

    const authA2 = await directSession(database, facts.teacherA.id);
    const sessionId = `session-${randomUUID()}`;
    const sessionResponsePromise = postRun(
      base,
      authA2,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: sessionId,
        user_text: '[app1:session] 会话失效',
        expected_conversation_revision: convA.revision,
      }),
    );
    await stub.waitForRequest('[app1:session]', 1);
    await database.query(
      "UPDATE app_sessions SET revoked_at = now(), revoked_reason = 'app1-test' WHERE token_hash = $1",
      [hashSessionToken(authA2.token)],
    );
    sessionGate.resolve();
    const sessionParsed = parseLines(await openNdjson(await sessionResponsePromise).collect());
    check(
      '模型等待期间会话失效 → session_invalid 且模型调用关闭',
      sessionParsed.verdict.ok &&
        sessionParsed.verdict.outcome.kind === 'stopped' &&
        sessionParsed.verdict.outcome.reason === 'session_invalid' &&
        !sessionParsed.events.some((event) => event.type === 'answer'),
    );

    const authA3 = await directSession(database, facts.teacherA.id);
    const disableId = `disable-${randomUUID()}`;
    const disableResponsePromise = postRun(
      base,
      authA3,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: disableId,
        user_text: '[app1:disable] 账号停用',
        expected_conversation_revision: convA.revision,
      }),
    );
    await stub.waitForRequest('[app1:disable]', 1);
    await database.query("UPDATE app_accounts SET status = 'disabled' WHERE id = $1", [facts.teacherA.id]);
    disableGate.resolve();
    const disableParsed = parseLines(await openNdjson(await disableResponsePromise).collect());
    check(
      '模型等待期间账号停用 → account_disabled 且模型调用关闭',
      disableParsed.verdict.ok &&
        disableParsed.verdict.outcome.kind === 'stopped' &&
        disableParsed.verdict.outcome.reason === 'account_disabled' &&
        !disableParsed.events.some((event) => event.type === 'answer'),
    );
    await database.query("UPDATE app_accounts SET status = 'active' WHERE id = $1", [facts.teacherA.id]);

    // 身份服务失败：同一实现返回 unavailable（引擎按 identity_unavailable 停止全部模型调用）。
    const healthyPool = (globalThis as { __pgPool?: { end: () => Promise<void> } }).__pgPool;
    (globalThis as { __pgPool?: unknown }).__pgPool = undefined;
    if (healthyPool) await healthyPool.end();
    process.env.DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:1/app1-unavailable';
    const unavailableIdentity = await resolveYayaRunCurrentIdentity({
      runId: basicRunId,
      token: loginToken,
    });
    check(
      '身份服务不可用 → resolveCurrentIdentity=unavailable（关闭模型调用）',
      unavailableIdentity.identity_state === 'unavailable' && unavailableIdentity.principal === null,
    );
    process.env.DATABASE_URL = url;
    const failedPool = (globalThis as { __pgPool?: { end: () => Promise<void> } }).__pgPool;
    (globalThis as { __pgPool?: unknown }).__pgPool = undefined;
    if (failedPool) await failedPool.end().catch(() => undefined);

    /* ============================== 模型失败 / 非法动作 / 来源错配 / 写入口关闭 ============================== */

    const failId = `fail-${randomUUID()}`;
    const failResponse = await postRun(
      base,
      authA,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: failId,
        user_text: '[app1:modelfail] 模型失败',
        expected_conversation_revision: convA.revision,
      }),
    );
    check('模型失败下响应头已发仍为 200（显式终态）', failResponse.status === 200);
    const failParsed = parseLines(await openNdjson(failResponse).collect());
    check(
      '模型失败 → stopped(model_failed)，详情为协议文案（无内部异常/原始 JSON）',
      failParsed.verdict.ok &&
        failParsed.verdict.outcome.kind === 'stopped' &&
        failParsed.verdict.outcome.reason === 'model_failed' &&
        failParsed.verdict.outcome.detail === safeYayaStopDetail('model_failed') &&
        failParsed.allParsed &&
        !failParsed.events.some((event) => JSON.stringify(event).includes('stub provider failure')),
    );

    const unknownReadId = `unknownread-${randomUUID()}`;
    const unknownReadResponse = await postRun(
      base,
      authA,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: unknownReadId,
        user_text: '[app1:unknownread] 未知工具',
        expected_conversation_revision: convA.revision,
      }),
    );
    const unknownReadParsed = parseLines(await openNdjson(unknownReadResponse).collect());
    check(
      '未知读取工具在触达依赖端前停止（unknown_read_tool）',
      unknownReadParsed.verdict.ok &&
        unknownReadParsed.verdict.outcome.kind === 'stopped' &&
        unknownReadParsed.verdict.outcome.reason === 'unknown_read_tool' &&
        !unknownReadParsed.events.some((event) => event.type === 'tool_result'),
    );

    const mismatchId = `mismatch-${randomUUID()}`;
    const mismatchResponse = await postRun(
      base,
      authA,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: mismatchId,
        user_text: '[app1:sourcemismatch] 错来源',
        expected_conversation_revision: convA.revision,
      }),
    );
    const mismatchParsed = parseLines(await openNdjson(mismatchResponse).collect());
    check(
      '未知来源引用被拒（source_mismatch）',
      mismatchParsed.verdict.ok &&
        mismatchParsed.verdict.outcome.kind === 'stopped' &&
        mismatchParsed.verdict.outcome.reason === 'source_mismatch' &&
        !mismatchParsed.events.some((event) => event.type === 'answer'),
    );

    const writeId = `write-${randomUUID()}`;
    const writeResponse = await postRun(
      base,
      authA,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: writeId,
        user_text: '[app1:writeintent] 帮我记一下',
        expected_conversation_revision: convA.revision,
      }),
    );
    const writeParsed = parseLines(await openNdjson(writeResponse).collect());
    check(
      'TOOLS1 未交付时写入 fail closed（unknown_write_tool / 无假提案/假回执）',
      writeParsed.verdict.ok &&
        writeParsed.verdict.outcome.kind === 'stopped' &&
        (writeParsed.verdict.outcome.reason === 'unknown_write_tool' ||
          writeParsed.verdict.outcome.reason === 'propose_failed') &&
        !writeParsed.events.some(
          (event) => event.type === 'proposal_prepared' || event.type === 'receipt',
        ),
    );

    /* ============================== 图片授权 ============================== */

    const png = await sharp({
      create: { width: 96, height: 64, channels: 3, background: { r: 180, g: 90, b: 60 } },
    })
      .png()
      .toBuffer();
    const uploadForm = new FormData();
    uploadForm.append('files', new File([new Uint8Array(png)], 'app1.png', { type: 'image/png' }));
    const uploadResponse = await fetch(`${base}/api/yaya/uploads`, {
      method: 'POST',
      headers: { origin: base, cookie: authA.cookie, 'x-csrf-token': authA.csrf },
      body: uploadForm,
    });
    const uploadBody = (await uploadResponse.json()) as {
      uploads?: { ok?: boolean; attachment?: { attachment_id?: string } }[];
    };
    const attachmentA = uploadBody.uploads?.[0]?.attachment?.attachment_id ?? '';
    check(
      '真实上传（MEDIA sharp 管线）成功',
      uploadResponse.status === 200 && attachmentA !== '',
    );
    const beforeImage = stub.total;
    const imageId = `image-${randomUUID()}`;
    const imageResponse = await postRun(
      base,
      authA,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: imageId,
        user_text: '',
        attachment_ids: [attachmentA],
        expected_conversation_revision: convA.revision,
      }),
    );
    const imageParsed = parseLines(await openNdjson(imageResponse).collect());
    check(
      '授权图片进入模型请求（StepFun 图片能力显式 unsupported，0 provider 请求）',
      imageResponse.status === 200 &&
        imageParsed.verdict.ok &&
        imageParsed.verdict.outcome.kind === 'stopped' &&
        imageParsed.verdict.outcome.reason === 'model_unsupported_capability' &&
        stub.total === beforeImage,
    );

    const uploadB = new FormData();
    uploadB.append('files', new File([new Uint8Array(png)], 'app1-b.png', { type: 'image/png' }));
    const uploadBResponse = await fetch(`${base}/api/yaya/uploads`, {
      method: 'POST',
      headers: { origin: base, cookie: authB.cookie, 'x-csrf-token': authB.csrf },
      body: uploadB,
    });
    const uploadBBody = (await uploadBResponse.json()) as {
      uploads?: { attachment?: { attachment_id?: string } }[];
    };
    const attachmentB = uploadBBody.uploads?.[0]?.attachment?.attachment_id ?? '';
    const foreignImage = await postRun(
      base,
      authA,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: `foreign-${randomUUID()}`,
        user_text: '看图',
        attachment_ids: [attachmentB],
        expected_conversation_revision: convA.revision,
      }),
    );
    check('引用他人附件在登记时被拒（409，不触达模型）', foreignImage.status === 409 && stub.total === beforeImage);

    // 进程内：授权图片读的是 MEDIA 处理后的 model 变体字节，且不暴露对象键/URL。
    const mediaRow = await database.query<{
      model_key: string | null;
      model_checksum: string | null;
    }>('SELECT model_key, model_checksum FROM yaya_attachments WHERE id = $1', [attachmentA]);
    const stored = row0(mediaRow.rows);
    const mediaContent = await loadAttachmentContent(mediaRuntimeOrThrow(), {
      attachment_id: attachmentA,
      viewer: { account_id: facts.teacherA.id, role: 'teacher' },
      loadRecordAccess: async () => null,
      variant: 'model',
    });
    check(
      '图片上下文只加载授权、处理后的字节（与 model 变体 checksum 一致）',
      stored !== null &&
        stored.model_checksum !== null &&
        mediaContent.body.length > 0 &&
        createHash('sha256').update(mediaContent.body).digest('hex') === stored.model_checksum,
    );
    check('图片字节不含对象键/签名 URL 字段', !JSON.stringify(mediaContent).includes('http'));

    const imageRunId = imageParsed.verdict.ok ? imageParsed.verdict.run_id : '';
    const imageRunRow = await loadYayaRun(imageRunId);
    const imagePrincipal: Principal = {
      account_id: facts.teacherA.id,
      username: facts.teacherA.username,
      display_name: '甲老师',
      role: 'teacher',
      account_status: 'active',
      scope: { kind: 'classes', class_ids: [facts.classA] },
    };
    const imageContext = imageRunRow
      ? await loadYayaRunProjectedContext(
          createYayaRunRuntimeStateFromRecord(imageRunRow, {
            headers: new Headers({ cookie: authA.cookie }),
          }),
          imagePrincipal,
        )
      : null;
    const projectedImage = imageContext?.images[0];
    check(
      '正式上下文中图片是 image_interpretation 来源且字节与处理结果一致（不与教师原文混淆）',
      projectedImage !== undefined &&
        projectedImage.image_id === attachmentA &&
        projectedImage.source.kind === 'image_interpretation' &&
        projectedImage.source.derived_from === null &&
        stored?.model_checksum !== null &&
        stored?.model_checksum !== undefined &&
        createHash('sha256')
          .update(Buffer.from(projectedImage.data_base64, 'base64'))
          .digest('hex') === stored.model_checksum &&
        !('url' in projectedImage) &&
        !('key' in projectedImage),
    );

    /* ============================== R1-A：投影降级不得继续消费旧数据 ============================== */

    const PRIVATE_MARKER = 'APP1_AI_PRIVATE_MARKER';
    await database.query('UPDATE observations SET ai_draft = $2::jsonb WHERE id = $1', [
      facts.observationA,
      JSON.stringify({ app1_private_marker: PRIVATE_MARKER }),
    ]);
    const moveChildA = async (classId: string): Promise<void> => {
      const db = database;
      if (db === null) throw new Error('database unavailable');
      await db.query(
        'UPDATE child_class_enrollments SET end_date = current_date WHERE child_id = $1 AND end_date IS NULL',
        [facts.childA],
      );
      await db.query(
        'INSERT INTO child_class_enrollments (child_id, class_id, start_date) VALUES ($1,$2,current_date)',
        [facts.childA, classId],
      );
    };
    // 正例：原班历史只读的合法最小查询保留（幼儿转入教师无权班级，原班仍在范围内）。
    await moveChildA(facts.classB);
    const histreadId = `histread-${randomUUID()}`;
    const histreadResponse = await postRun(
      base,
      authA,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: histreadId,
        user_text: '[app1:histread] 历史最小查询',
        expected_conversation_revision: convA.revision,
      }),
    );
    const histreadParsed = parseLines(await openNdjson(histreadResponse).collect());
    check(
      'R1-A 合法历史只读最小查询仍可回答',
      histreadParsed.verdict.ok && histreadParsed.verdict.outcome.kind === 'answered',
    );
    check(
      'R1-A 历史只读投影不含完整私有字段（AI 草稿标记未进入模型）',
      !(histreadScenario.bodies[1] ?? '').includes(PRIVATE_MARKER),
    );
    const histreadRunId = histreadParsed.verdict.ok ? histreadParsed.verdict.run_id : '';
    const histreadRow = await loadYayaRun(histreadRunId);
    check(
      'R1-A 历史只读依赖记录投影等级 historical_read_only',
      (histreadRow?.dependencies ?? []).some(
        (entry) => entry.ref?.ref_id === `observation:${facts.observationA}` &&
          entry.projection === 'historical_read_only',
      ),
    );
    const histreadLookup = await lookupRun(base, authA, convA.conversation_id, histreadId);
    check(
      'R1-A 历史只读 run 终态查询可读（授权不变）',
      ((await histreadLookup.json()) as { status?: string }).status === 'finished',
    );
    await moveChildA(facts.classA);

    // 运行中降级：完整投影加载后转入无权班级 → 停止且不发布旧完整内容。
    const full2histId = `full2hist-${randomUUID()}`;
    const full2histPromise = postRun(
      base,
      authA,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: full2histId,
        user_text: '[app1:full2hist] 投影降级',
        expected_conversation_revision: convA.revision,
      }),
    );
    await stub.waitForRequest('[app1:full2hist]', 2);
    check(
      'R1-A 完整投影内容确已装载（第二模型请求含私有标记）',
      (full2histScenario.bodies[1] ?? '').includes(PRIVATE_MARKER),
    );
    await moveChildA(facts.classB);
    full2histGate.resolve();
    const full2histParsed = parseLines(await openNdjson(await full2histPromise).collect());
    check(
      'R1-A 运行中 full→historical 降级 → context_revoked 且不发布回答',
      full2histParsed.verdict.ok &&
        full2histParsed.verdict.outcome.kind === 'stopped' &&
        full2histParsed.verdict.outcome.reason === 'context_revoked' &&
        !full2histParsed.events.some((event) => event.type === 'answer'),
    );
    const full2histRunId = full2histParsed.verdict.ok ? full2histParsed.verdict.run_id : '';
    const full2histRow = await loadYayaRun(full2histRunId);
    check(
      'R1-A full 降级 run 依赖要求完整投影',
      (full2histRow?.dependencies ?? []).some(
        (entry) => entry.ref?.ref_id === `observation:${facts.observationA}` && entry.projection === 'full',
      ),
    );
    const full2histLookup = await lookupRun(base, authA, convA.conversation_id, full2histId);
    const full2histBody = (await full2histLookup.json()) as {
      status?: string;
      outcome?: { kind?: string; reason?: string };
    };
    check(
      'R1-A 降级 run 终态查询只返回协议停止语义（无旧内容）',
      full2histBody.status === 'finished' &&
        full2histBody.outcome?.kind === 'stopped' &&
        full2histBody.outcome?.reason === 'context_revoked',
    );
    await moveChildA(facts.classA);

    // 终态投影：完整回答完成后撤权 → 查询不可核验、回放拒绝；恢复授权后重新可读。
    const fullAnswerId = `fullanswer-${randomUUID()}`;
    const fullAnswerResponse = await postRun(
      base,
      authA,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: fullAnswerId,
        user_text: '[app1:fullanswer] 完整投影回答',
        expected_conversation_revision: convA.revision,
      }),
    );
    const fullAnswerParsed = parseLines(await openNdjson(fullAnswerResponse).collect());
    check(
      'R1-A 完整投影 run 正常回答（基线）',
      fullAnswerParsed.verdict.ok && fullAnswerParsed.verdict.outcome.kind === 'answered',
    );
    const fullAnswerRunId = fullAnswerParsed.verdict.ok ? fullAnswerParsed.verdict.run_id : '';
    const fullAnswerCount = stub.requestCount('[app1:fullanswer]');
    await moveChildA(facts.classB);
    const fullAnswerGated = await lookupRun(base, authA, convA.conversation_id, fullAnswerId);
    const fullAnswerGatedBody = (await fullAnswerGated.json()) as { status?: string; reason?: string };
    check(
      'R1-A 撤权后完整终态查询不可核验（不返回旧 AI 工作流内容）',
      fullAnswerGatedBody.status === 'unverifiable' &&
        fullAnswerGatedBody.reason === 'terminal_unreadable',
    );
    const fullAnswerReplay = await postRun(
      base,
      authA,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: fullAnswerId,
        user_text: '[app1:fullanswer] 完整投影回答',
        expected_conversation_revision: convA.revision,
      }),
    );
    check(
      'R1-A 撤权后终态回放被拒（409 source_conflict，不重派发）',
      fullAnswerReplay.status === 409 && stub.requestCount('[app1:fullanswer]') === fullAnswerCount,
    );
    await moveChildA(facts.classA);
    const fullAnswerRestored = await lookupRun(base, authA, convA.conversation_id, fullAnswerId);
    check(
      'R1-A 恢复授权后终态查询重新可读',
      ((await fullAnswerRestored.json()) as { status?: string }).status === 'finished',
    );
    const fullAnswerReplayOk = await postRun(
      base,
      authA,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: fullAnswerId,
        user_text: '[app1:fullanswer] 完整投影回答',
        expected_conversation_revision: convA.revision,
      }),
    );
    const fullAnswerReplayParsed = parseLines(await openNdjson(fullAnswerReplayOk).collect());
    check(
      'R1-A 恢复授权后回放原 run（同 run_id，0 次重派发）',
      fullAnswerReplayOk.status === 200 &&
        fullAnswerReplayParsed.verdict.ok &&
        fullAnswerReplayParsed.verdict.run_id === fullAnswerRunId &&
        stub.requestCount('[app1:fullanswer]') === fullAnswerCount,
    );

    // 旧快照（缺 projection）保守不可核验，不补造历史。
    const histreadDepsBefore = histreadRow?.dependencies ?? [];
    await database.query(
      `UPDATE yaya_runs SET dependencies = (
         SELECT COALESCE(jsonb_agg(entry - 'projection'), '[]'::jsonb)
           FROM jsonb_array_elements($2::jsonb) AS entry
       ) WHERE id = $1`,
      [histreadRunId, JSON.stringify(histreadDepsBefore)],
    );
    const legacyLookup = await lookupRun(base, authA, convA.conversation_id, histreadId);
    const legacyBody = (await legacyLookup.json()) as { status?: string; reason?: string };
    check(
      'R1-A 旧 run 缺投影快照 → 保守不可核验',
      legacyBody.status === 'unverifiable' && legacyBody.reason === 'terminal_unreadable',
    );
    await database.query('UPDATE yaya_runs SET dependencies = $2::jsonb WHERE id = $1', [
      histreadRunId,
      JSON.stringify(histreadDepsBefore),
    ]);
    const restoredLegacy = await lookupRun(base, authA, convA.conversation_id, histreadId);
    check(
      'R1-A 恢复快照后重新可读（对照）',
      ((await restoredLegacy.json()) as { status?: string }).status === 'finished',
    );

    /* ============================== R1-B：终态持久化裁决后才发布 ============================== */

    // 最后保存边界：取消/替换/到期时成功候选不得落账，合法停止仍按协议记录。
    const boundarySession = await directSession(database, facts.teacherA.id);
    const boundarySessionId =
      (
        await database.query<{ id: string }>('SELECT id FROM app_sessions WHERE token_hash = $1', [
          hashSessionToken(boundarySession.token),
        ])
      ).rows[0]?.id ?? '';
    const makeBoundaryRun = async (sessionId: string = boundarySessionId) => {
      const registration = await withTransaction((client) =>
        registerYayaRun(client, {
          run_id: randomUUID(),
          owner_account_id: facts.teacherA.id,
          conversation_id: convA.conversation_id,
          client_request_id: `boundary-${randomUUID()}`,
          user_text: '[app1:boundary] 合成',
          attachment_ids: [],
          expected_conversation_revision: convA.revision,
          session_id: sessionId,
          owner_instance: 'app1-check-boundary',
          deadline_at: new Date(Date.now() + 90_000).toISOString(),
        }),
      );
      if (registration.kind !== 'created') throw new Error('boundary run not created');
      return registration.run;
    };
    const outcomeOf = (stored: Awaited<ReturnType<typeof finalizeYayaRun>>): { kind?: string; reason?: string } =>
      (stored?.outcome ?? {}) as { kind?: string; reason?: string };
    const candidateAnswered = { kind: 'answered', content: 'BOUNDARY_LATE', sources: [] };

    const normalBoundary = await makeBoundaryRun();
    const normalStored = await finalizeYayaRun(normalBoundary.run_id, 'app1-check-boundary', candidateAnswered);
    check('R1-B 正常候选成功落账（对照）', outcomeOf(normalStored).kind === 'answered');

    const cancelBoundary = await makeBoundaryRun();
    await database.query('UPDATE yaya_runs SET cancel_requested_at = now() WHERE id = $1', [
      cancelBoundary.run_id,
    ]);
    const cancelStored = await finalizeYayaRun(cancelBoundary.run_id, 'app1-check-boundary', candidateAnswered);
    check(
      'R1-B 已取消后成功候选不落账（记 stopped cancelled）',
      outcomeOf(cancelStored).kind === 'stopped' && outcomeOf(cancelStored).reason === 'cancelled',
    );

    const replaceBoundary = await makeBoundaryRun();
    await database.query('UPDATE yaya_runs SET replaced_by = $2 WHERE id = $1', [
      replaceBoundary.run_id,
      randomUUID(),
    ]);
    const replaceStored = await finalizeYayaRun(replaceBoundary.run_id, 'app1-check-boundary', candidateAnswered);
    check(
      'R1-B 已替换后成功候选不落账（记 stopped run_replaced）',
      outcomeOf(replaceStored).kind === 'stopped' && outcomeOf(replaceStored).reason === 'run_replaced',
    );

    const deadlineBoundary = await makeBoundaryRun();
    await database.query("UPDATE yaya_runs SET deadline_at = now() - interval '1 second' WHERE id = $1", [
      deadlineBoundary.run_id,
    ]);
    const deadlineStored = await finalizeYayaRun(deadlineBoundary.run_id, 'app1-check-boundary', candidateAnswered);
    check(
      'R1-B 已到期后成功候选不落账（记 stopped deadline）',
      outcomeOf(deadlineStored).kind === 'stopped' && outcomeOf(deadlineStored).reason === 'deadline',
    );

    const stopBoundary = await makeBoundaryRun();
    const stopStored = await finalizeYayaRun(stopBoundary.run_id, 'app1-check-boundary', {
      kind: 'stopped',
      reason: 'source_mismatch',
      detail: null,
    });
    check(
      'R1-B 正常停止流程不被锁死（stopped 原样落账）',
      outcomeOf(stopStored).kind === 'stopped' && outcomeOf(stopStored).reason === 'source_mismatch',
    );

    const verifyOkBoundary = await makeBoundaryRun();
    const verifyOkStored = await finalizeYayaRun(verifyOkBoundary.run_id, 'app1-check-boundary', candidateAnswered, {
      verify: (client) =>
        verifyYayaRunBoundaryIdentity(client, { run: verifyOkBoundary, token: boundarySession.token }),
    });
    check('R1-B 保存边界身份重核通过（对照）', outcomeOf(verifyOkStored).kind === 'answered');

    const sessionInvalidBoundary = await makeBoundaryRun();
    await database.query("UPDATE app_sessions SET revoked_at = now() WHERE id = $1", [boundarySessionId]);
    const sessionInvalidStored = await finalizeYayaRun(
      sessionInvalidBoundary.run_id,
      'app1-check-boundary',
      candidateAnswered,
      {
        verify: (client) =>
          verifyYayaRunBoundaryIdentity(client, {
            run: sessionInvalidBoundary,
            token: boundarySession.token,
          }),
      },
    );
    check(
      'R1-B 保存边界会话失效 → 成功候选改为 stopped session_invalid',
      outcomeOf(sessionInvalidStored).kind === 'stopped' &&
        outcomeOf(sessionInvalidStored).reason === 'session_invalid',
    );
    await database.query('UPDATE app_sessions SET revoked_at = NULL WHERE id = $1', [boundarySessionId]);

    const disabledBoundary = await makeBoundaryRun();
    await database.query("UPDATE app_accounts SET status = 'disabled' WHERE id = $1", [facts.teacherA.id]);
    const disabledStored = await finalizeYayaRun(disabledBoundary.run_id, 'app1-check-boundary', candidateAnswered, {
      verify: (client) =>
        verifyYayaRunBoundaryIdentity(client, { run: disabledBoundary, token: boundarySession.token }),
    });
    check(
      'R1-B 保存边界账号停用 → 成功候选改为 stopped account_disabled',
      outcomeOf(disabledStored).kind === 'stopped' && outcomeOf(disabledStored).reason === 'account_disabled',
    );
    await database.query("UPDATE app_accounts SET status = 'active' WHERE id = $1", [facts.teacherA.id]);

    // 损坏依赖不得被 append 抹掉或吞成空集合。
    const corruptAppendBoundary = await makeBoundaryRun();
    await database.query(
      `UPDATE yaya_runs SET dependencies = '[{"unexpected":true}]'::jsonb WHERE id = $1`,
      [corruptAppendBoundary.run_id],
    );
    const appendResult = await appendYayaRunDependencies(corruptAppendBoundary.run_id, [
      { ref: null, tool: null, image_id: 'app1-image-x', message_id: null, fragment_id: null, projection: 'any' },
    ]);
    const corruptRows = await database.query<{ dependencies: unknown }>(
      'SELECT dependencies FROM yaya_runs WHERE id = $1',
      [corruptAppendBoundary.run_id],
    );
    check(
      'R1-D 损坏依赖 append 不覆盖、不吞成空集合',
      appendResult.corrupt === true &&
        appendResult.dependencies.length === 0 &&
        JSON.stringify(corruptRows.rows[0]?.dependencies) === '[{"unexpected":true}]',
    );
    await finalizeYayaRun(corruptAppendBoundary.run_id, 'app1-check-boundary', {
      kind: 'stopped',
      reason: 'model_failed',
      detail: null,
    });

    // 真实 PG 终态保存失败：整条 NDJSON 必须通过冻结 API0 校验，且不得先发成功再改失败。
    await database.query(
      `CREATE OR REPLACE FUNCTION app1_fail_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.state = 'terminal' AND NEW.user_text LIKE '%app1_persist_failure%' THEN
             RAISE EXCEPTION 'app1 synthetic terminal persistence failure';
           END IF;
           RETURN NEW;
         END $$;
       DROP TRIGGER IF EXISTS app1_fail_terminal_trigger ON yaya_runs;
       CREATE TRIGGER app1_fail_terminal_trigger BEFORE UPDATE ON yaya_runs
         FOR EACH ROW EXECUTE FUNCTION app1_fail_terminal();`,
    );
    const persistFailId = `persistfail-${randomUUID()}`;
    const persistFailResponse = await postRun(
      base,
      authA,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: persistFailId,
        user_text: '[app1:persistfail] app1_persist_failure',
        expected_conversation_revision: convA.revision,
      }),
    );
    const persistFailParsed = parseLines(await openNdjson(persistFailResponse).collect());
    const persistFailEnd = persistFailParsed.events.find((event) => event.type === 'run_end');
    const persistFailRow = await database.query<{ state: string }>(
      'SELECT state FROM yaya_runs WHERE client_request_id = $1',
      [persistFailId],
    );
    check(
      'R1-B 真实 PG 终态写失败：整条流通过 API0、无成功终局、唯一 run_end',
      persistFailResponse.status === 200 &&
        persistFailParsed.allParsed &&
        persistFailParsed.verdict.ok &&
        !persistFailParsed.events.some((event) => event.type === 'answer') &&
        persistFailEnd !== undefined &&
        persistFailEnd.type === 'run_end' &&
        persistFailEnd.outcome.kind === 'stopped' &&
        persistFailEnd.outcome.reason === 'model_failed',
    );
    check(
      'R1-B 持久化失败标记为中断且查询不可核验',
      persistFailRow.rows[0]?.state === 'interrupted',
    );
    const persistFailLookup = await lookupRun(base, authA, convA.conversation_id, persistFailId);
    const persistFailBody = (await persistFailLookup.json()) as { status?: string; reason?: string };
    check(
      'R1-B 保存失败行查询不可核验（不返回 missing）',
      persistFailBody.status === 'unverifiable' && persistFailBody.reason === 'terminal_unreadable',
    );
    await database.query('DROP TRIGGER IF EXISTS app1_fail_terminal_trigger ON yaya_runs');
    await database.query('DROP FUNCTION IF EXISTS app1_fail_terminal()');

    /* ============================== R1-C：历史重核不受 20 条窗口限制 ============================== */

    const principalFull: Principal = {
      account_id: facts.teacherA.id,
      username: facts.teacherA.username,
      display_name: '甲老师',
      role: 'teacher',
      account_status: 'active',
      scope: { kind: 'classes', class_ids: [facts.classA] },
    };
    const loginSessionId =
      (
        await database.query<{ id: string }>('SELECT id FROM app_sessions WHERE token_hash = $1', [
          hashSessionToken(loginToken),
        ])
      ).rows[0]?.id ?? '';
    const historyReg = await withTransaction((client) =>
      registerYayaRun(client, {
        run_id: randomUUID(),
        owner_account_id: facts.teacherA.id,
        conversation_id: historyConv.conversation_id,
        client_request_id: `history-recheck-${randomUUID()}`,
        user_text: '[app1:history-recheck]',
        attachment_ids: [],
        expected_conversation_revision: savedMessage.revision,
        session_id: loginSessionId,
        owner_instance: 'app1-check',
        deadline_at: new Date(Date.now() + 90_000).toISOString(),
      }),
    );
    assert.equal(historyReg.kind, 'created');
    const historyRuntime = createYayaRunRuntimeState({
      run: historyReg.run,
      token: loginToken,
      owner_instance: 'app1-check',
      carrier: { headers: new Headers({ cookie: authA.cookie }) },
    });
    const historyIdentity = {
      run_id: historyReg.run.run_id,
      identity_state: 'authenticated' as const,
      principal: principalFull,
      session_valid: true,
    };
    const historyLoaded = await loadYayaRunProjectedContext(historyRuntime, principalFull);
    check(
      'R1-C 历史加载含窗口内片段（20 条上限）',
      historyLoaded.history.some((turn) => turn.content.includes('历史：王一诺在积木区搭了高塔。')),
    );
    const beforeWindow = await revalidateYayaRunContext(
      historyRuntime,
      { run_id: historyReg.run.run_id, identity: historyIdentity, sources: [], image_ids: [] },
      { principal: principalFull },
    );
    check('R1-C 追加前重核通过（基线）', beforeWindow.ok);
    for (let index = 0; index < 21; index += 1) {
      await database.query(
        `INSERT INTO yaya_messages (id, conversation_id, owner_account_id, role, message_kind, fragments)
         VALUES ($1,$2,$3,'user','text',$4::jsonb)`,
        [
          randomUUID(),
          historyConv.conversation_id,
          facts.teacherA.id,
          JSON.stringify([
            {
              fragment_id: randomUUID(),
              text: `[app1] 追加消息 ${index}`,
              sources: [],
              independently_readable: true,
              provenance: { kind: 'teacher_supplement', ref_id: null, label: '合成', derived_from: null },
            },
          ]),
        ],
      );
    }
    const afterWindow = await revalidateYayaRunContext(
      historyRuntime,
      { run_id: historyReg.run.run_id, identity: historyIdentity, sources: [], image_ids: [] },
      { principal: principalFull },
    );
    check(
      'R1-C 分页窗口外合法片段仍通过（不误判不可核验）',
      afterWindow.ok,
    );
    const freshHistoryRuntime = createYayaRunRuntimeState({
      run: historyReg.run,
      token: loginToken,
      owner_instance: 'app1-check',
      carrier: { headers: new Headers({ cookie: authA.cookie }) },
    });
    const freshHistory = await loadYayaRunProjectedContext(freshHistoryRuntime, principalFull);
    check(
      'R1-C 模型历史仍保持 20 条上限（分页外片段不再注入）',
      freshHistory.history.length <= 20 &&
        !freshHistory.history.some((turn) => turn.content.includes('历史：王一诺在积木区搭了高塔。')),
    );

    const historySnapshots = [...historyRuntime.dependencies.values()].filter(
      (dependency) => dependency.message_id !== null,
    );
    const recordedMessageId = historySnapshots[0]?.message_id as string;
    const recordedFragmentId = historySnapshots[0]?.fragment_id as string;
    await database.query('UPDATE yaya_messages SET deleted_at = now() WHERE id = $1', [recordedMessageId]);
    const deletedHistory = await revalidateYayaRunContext(
      historyRuntime,
      { run_id: historyReg.run.run_id, identity: historyIdentity, sources: [], image_ids: [] },
      { principal: principalFull },
    );
    check('R1-C 已删除片段保守拒绝', !deletedHistory.ok);
    await database.query('UPDATE yaya_messages SET deleted_at = NULL WHERE id = $1', [recordedMessageId]);
    const restoredHistory = await revalidateYayaRunContext(
      historyRuntime,
      { run_id: historyReg.run.run_id, identity: historyIdentity, sources: [], image_ids: [] },
      { principal: principalFull },
    );
    check('R1-C 恢复删除后重新通过（对照）', restoredHistory.ok);
    const fragmentRows = await database.query<{ fragments: unknown }>(
      'SELECT fragments FROM yaya_messages WHERE id = $1',
      [recordedMessageId],
    );
    const originalFragments = fragmentRows.rows[0]?.fragments ?? [];
    await database.query(`UPDATE yaya_messages SET fragments = '[1]'::jsonb WHERE id = $1`, [
      recordedMessageId,
    ]);
    const corruptHistory = await revalidateYayaRunContext(
      historyRuntime,
      { run_id: historyReg.run.run_id, identity: historyIdentity, sources: [], image_ids: [] },
      { principal: principalFull },
    );
    check('R1-C 损坏片段保守拒绝', !corruptHistory.ok);
    await database.query('UPDATE yaya_messages SET fragments = $2::jsonb WHERE id = $1', [
      recordedMessageId,
      JSON.stringify(originalFragments),
    ]);
    const restoredFragment = await revalidateYayaRunContext(
      historyRuntime,
      { run_id: historyReg.run.run_id, identity: historyIdentity, sources: [], image_ids: [] },
      { principal: principalFull },
    );
    check('R1-C 恢复片段后重新通过（对照）', restoredFragment.ok);
    // 真实调用链在重核前会重新解析当前身份/任教范围；用当前数据库事实构造 principal。
    const freshPrincipalA = async (): Promise<Principal> => {
      const db = database;
      if (db === null) throw new Error('database unavailable');
      const rows = await db.query<{ class_id: string }>(
        `SELECT class_id FROM teacher_class_assignments
          WHERE account_id = $1 AND removed_at IS NULL ORDER BY class_id`,
        [facts.teacherA.id],
      );
      return {
        ...principalFull,
        scope: { kind: 'classes', class_ids: rows.rows.map((entry) => entry.class_id) },
      };
    };
    await database.query(
      'UPDATE teacher_class_assignments SET removed_at = now() WHERE account_id = $1 AND class_id = $2',
      [facts.teacherA.id, facts.classA],
    );
    const revokedPrincipalNow = await freshPrincipalA();
    const revokedHistory = await revalidateYayaRunContext(
      historyRuntime,
      {
        run_id: historyReg.run.run_id,
        identity: { ...historyIdentity, principal: revokedPrincipalNow },
        sources: [],
        image_ids: [],
      },
      { principal: revokedPrincipalNow },
    );
    check('R1-C 历史片段来源撤权保守拒绝', !revokedHistory.ok);
    await database.query(
      'UPDATE teacher_class_assignments SET removed_at = NULL WHERE account_id = $1 AND class_id = $2',
      [facts.teacherA.id, facts.classA],
    );
    const reauthorizedPrincipalNow = await freshPrincipalA();
    const reauthorizedHistory = await revalidateYayaRunContext(
      historyRuntime,
      {
        run_id: historyReg.run.run_id,
        identity: { ...historyIdentity, principal: reauthorizedPrincipalNow },
        sources: [],
        image_ids: [],
      },
      { principal: reauthorizedPrincipalNow },
    );
    check('R1-C 恢复授权后重新通过（对照）', reauthorizedHistory.ok);
    void recordedFragmentId;

    /* ============================== R1-D：损坏依赖严格区分 ============================== */

    const validDependency = {
      ref: {
        kind: 'tool_result',
        ref_id: `observation:${facts.observationA}`,
        label: null,
        derived_from: null,
      },
      tool: 'get_observation',
      image_id: null,
      message_id: null,
      fragment_id: null,
      projection: 'full',
    };
    const rawRunRecord = {
      id: randomUUID(),
      owner_account_id: facts.teacherA.id,
      conversation_id: convA.conversation_id,
      client_request_id: `parser-${randomUUID()}`,
      request_digest: '0'.repeat(64),
      user_text: 'parser',
      attachment_ids: [],
      expected_conversation_revision: 1,
      session_id: randomUUID(),
      owner_instance: 'app1-check',
      state: 'terminal',
      outcome: { kind: 'stopped', reason: 'model_failed', detail: null },
      dependencies: [validDependency],
      cancel_requested_at: null,
      replaced_by: null,
      deadline_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      terminal_at: new Date().toISOString(),
    };
    const parsedValid = parseYayaRunRecord(rawRunRecord);
    check(
      'R1-D 合法依赖快照可解析（含投影等级）',
      parsedValid !== null &&
        !parsedValid.dependencies_corrupt &&
        parsedValid.dependencies.length === 1 &&
        parsedValid.dependencies[0]?.projection === 'full',
    );
    const emptyDeps = parseYayaRunRecord({ ...rawRunRecord, dependencies: [] });
    check(
      'R1-D 合法空集合与损坏集合区分',
      emptyDeps !== null && !emptyDeps.dependencies_corrupt && emptyDeps.dependencies.length === 0,
    );
    const corruptCases: [string, unknown][] = [
      ['未知条目', [{ unexpected: true }]],
      ['部分损坏', [validDependency, { unexpected: true }]],
      [
        '未知来源 kind',
        [{ ...validDependency, ref: { kind: 'alien', ref_id: 'x', label: null, derived_from: null } }],
      ],
      ['缺投影快照（旧 run）', [{ ...validDependency, projection: undefined }]],
      ['message/fragment 不成对', [{ ...validDependency, message_id: 'm' }]],
      ['非数组', 'corrupt'],
    ];
    let corruptCasesOk = true;
    for (const [label, value] of corruptCases) {
      const record = parseYayaRunRecord({ ...rawRunRecord, dependencies: value });
      if (record === null || !record.dependencies_corrupt || record.dependencies.length !== 0) {
        corruptCasesOk = false;
        console.error(`R1-D 反例未按损坏处理：${label}`);
      }
    }
    check('R1-D 未知/缺字段/旧快照一律判损坏且不丢条假装完整', corruptCasesOk);
    check(
      'R1-D parseStoredDependencies 对损坏数组返回 corrupt',
      parseStoredDependencies([{ unexpected: true }]).corrupt === true &&
        parseStoredDependencies([]).corrupt === false,
    );

    // HTTP：损坏依赖的终态查询不可核验（行存在但不可读，不得 missing）。
    const depCorruptId = `depcorrupt-${randomUUID()}`;
    const depCorruptResponse = await postRun(
      base,
      authA,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: depCorruptId,
        user_text: '[app1:depcorrupt] 依赖完整性',
        expected_conversation_revision: convA.revision,
      }),
    );
    const depCorruptParsed = parseLines(await openNdjson(depCorruptResponse).collect());
    check(
      'R1-D 依赖完整性对照 run 正常回答',
      depCorruptParsed.verdict.ok && depCorruptParsed.verdict.outcome.kind === 'answered',
    );
    const depCorruptRunId = depCorruptParsed.verdict.ok ? depCorruptParsed.verdict.run_id : '';
    const depCorruptOriginal = (
      await database.query<{ dependencies: unknown }>('SELECT dependencies FROM yaya_runs WHERE id = $1', [
        depCorruptRunId,
      ])
    ).rows[0]?.dependencies;
    await database.query(
      `UPDATE yaya_runs SET dependencies = '[{"unexpected":true}]'::jsonb WHERE id = $1`,
      [depCorruptRunId],
    );
    const corruptLookup = await lookupRun(base, authA, convA.conversation_id, depCorruptId);
    const corruptLookupBody = (await corruptLookup.json()) as { status?: string; reason?: string };
    check(
      'R1-D 损坏依赖终态查询不可核验（非 missing）',
      corruptLookupBody.status === 'unverifiable' && corruptLookupBody.reason === 'terminal_unreadable',
    );
    const corruptParsedRow = await loadYayaRun(depCorruptRunId);
    check(
      'R1-D 损坏依赖行解析标记 dependencies_corrupt',
      corruptParsedRow !== null && corruptParsedRow.dependencies_corrupt === true,
    );
    await database.query('UPDATE yaya_runs SET dependencies = $2::jsonb WHERE id = $1', [
      depCorruptRunId,
      JSON.stringify(depCorruptOriginal ?? []),
    ]);
    const restoredCorruptLookup = await lookupRun(base, authA, convA.conversation_id, depCorruptId);
    check(
      'R1-D 恢复依赖后重新可读（对照）',
      ((await restoredCorruptLookup.json()) as { status?: string }).status === 'finished',
    );
    await database.query(`UPDATE yaya_runs SET attachment_ids = '[1]'::jsonb WHERE id = $1`, [depCorruptRunId]);
    const unreadableLookup = await lookupRun(base, authA, convA.conversation_id, depCorruptId);
    const unreadableBody = (await unreadableLookup.json()) as { status?: string; reason?: string };
    check(
      'R1-D 行存在但不可读 → 不可核验（不归为 missing）',
      unreadableBody.status === 'unverifiable' && unreadableBody.reason === 'terminal_unreadable',
    );
    await database.query(`UPDATE yaya_runs SET attachment_ids = '[]'::jsonb WHERE id = $1`, [depCorruptRunId]);

    /* ============================== R2：最后保存边界的锁等待与严格解析 ============================== */

    r2Racer = new Client({ connectionString: url });
    r2Lock = new Client({ connectionString: url });
    await r2Racer.connect();
    await r2Lock.connect();
    const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    // P1-B：事务在到期前开始，锁等待跨过期限后必须按实际时刻判到期。
    const r2DeadlineRun = await makeBoundaryRun();
    await database.query(
      "UPDATE yaya_runs SET deadline_at = clock_timestamp() + interval '2 seconds' WHERE id = $1",
      [r2DeadlineRun.run_id],
    );
    await r2Racer.query('BEGIN');
    await r2Racer.query('SELECT id FROM yaya_runs WHERE id = $1 FOR UPDATE', [r2DeadlineRun.run_id]);
    let r2DeadlineSettled = false;
    const r2DeadlineFinalize = finalizeYayaRun(
      r2DeadlineRun.run_id,
      'app1-check-boundary',
      candidateAnswered,
      {
        verify: (client) =>
          verifyYayaRunBoundaryIdentity(client, { run: r2DeadlineRun, token: boundarySession.token }),
      },
    ).finally(() => {
      r2DeadlineSettled = true;
    });
    await sleepMs(400);
    check('R2-B 终态保存被 run 行锁挡住（受控交错）', !r2DeadlineSettled);
    let r2DeadlineExpired = false;
    for (let attempt = 0; attempt < 160; attempt += 1) {
      const expired = await database.query<{ expired: boolean }>(
        'SELECT deadline_at < clock_timestamp() AS expired FROM yaya_runs WHERE id = $1',
        [r2DeadlineRun.run_id],
      );
      if (expired.rows[0]?.expired === true) {
        r2DeadlineExpired = true;
        break;
      }
      await sleepMs(25);
    }
    await r2Racer.query('COMMIT');
    const r2DeadlineStored = await r2DeadlineFinalize;
    const r2DeadlineRow = await database.query<{ after_deadline: boolean }>(
      'SELECT terminal_at > deadline_at AS after_deadline FROM yaya_runs WHERE id = $1',
      [r2DeadlineRun.run_id],
    );
    check('R2-B 锁等待期间 deadline 已到期', r2DeadlineExpired);
    check(
      'R2-B 到期后成功候选不落账（记 stopped deadline）',
      outcomeOf(r2DeadlineStored).kind === 'stopped' && outcomeOf(r2DeadlineStored).reason === 'deadline',
    );
    check(
      'R2-B 落账时间反映实际裁决时刻（晚于 deadline）',
      r2DeadlineRow.rows[0]?.after_deadline === true,
    );

    // P1-B：已过期的 active run，保存 hook 必须拒绝。
    const r2ExpiredHookRun = await makeBoundaryRun();
    await database.query("UPDATE yaya_runs SET deadline_at = clock_timestamp() - interval '1 second' WHERE id = $1", [
      r2ExpiredHookRun.run_id,
    ]);
    const r2ExpiredHook = await withTransaction((client) =>
      assertYayaRunActive(client, r2ExpiredHookRun.run_id, 'app1-check-boundary').then(
        () => 'allowed',
        () => 'rejected',
      ),
    );
    check('R2-B 已过期 active run 保存 hook 拒绝（锁后判期限）', r2ExpiredHook === 'rejected');

    // P1-A：身份阶段持账号/会话共享锁；撤销在 run 锁等待期间提交时被串行化到原终态之后。
    const r2SessionRun = await makeBoundaryRun();
    await r2Racer.query('BEGIN');
    await r2Racer.query('SELECT id FROM yaya_runs WHERE id = $1 FOR UPDATE', [r2SessionRun.run_id]);
    let r2SessionSettled = false;
    const r2SessionFinalize = finalizeYayaRun(
      r2SessionRun.run_id,
      'app1-check-boundary',
      candidateAnswered,
      {
        verify: (client) =>
          verifyYayaRunBoundaryIdentity(client, { run: r2SessionRun, token: boundarySession.token }),
      },
    ).finally(() => {
      r2SessionSettled = true;
    });
    await sleepMs(400);
    check('R2-A 身份阶段完成后被 run 行锁挡住（受控交错）', !r2SessionSettled);
    let revokeDone = false;
    const revokePromise = database
      .query("UPDATE app_sessions SET revoked_at = clock_timestamp() WHERE id = $1", [boundarySessionId])
      .then(() => {
        revokeDone = true;
      });
    await sleepMs(500);
    check('R2-A 锁等待期间会话撤销被保存边界锁住（正确串行化）', !revokeDone);
    await r2Racer.query('COMMIT');
    const r2SessionStored = await r2SessionFinalize;
    await revokePromise;
    const r2RevokedAfter = await database.query<{ revoked: boolean }>(
      'SELECT revoked_at IS NOT NULL AS revoked FROM app_sessions WHERE id = $1',
      [boundarySessionId],
    );
    check(
      'R2-A 串行化后原终态落账成功（撤销线性化在后）',
      outcomeOf(r2SessionStored).kind === 'answered',
    );
    check('R2-A 终态提交后撤销才生效', r2RevokedAfter.rows[0]?.revoked === true);
    await database.query('UPDATE app_sessions SET revoked_at = NULL WHERE id = $1', [boundarySessionId]);

    // P1-A（真实 startYayaRun）：完整投影读取后，终态保存等待 run 锁期间幼儿转班，
    // 保存边界必须在锁等待后重核已装载来源并拒绝发布旧私域回答。
    await moveChildA(facts.classA);
    const r2FinalLockId = `finallock-${randomUUID()}`;
    const r2FinalLocked = deferred();
    const r2FinalRelease = deferred();
    stub.register('[app1:finallock]', [
      { content: actionRead('get_observation', { observation_id: facts.observationA }) },
      {
        prepare: async () => {
          const db = database;
          if (db === null) throw new Error('database unavailable');
          const rows = await db.query<{ id: string }>(
            'SELECT id FROM yaya_runs WHERE client_request_id = $1',
            [r2FinalLockId],
          );
          const serviceRunId = rows.rows[0]?.id;
          if (!serviceRunId) throw new Error('finallock run not found');
          await r2Lock!.query('BEGIN');
          await r2Lock!.query('SELECT id FROM yaya_runs WHERE id = $1 FOR UPDATE', [serviceRunId]);
          r2FinalLocked.resolve();
          void (async () => {
            await r2FinalRelease.promise;
            await r2Lock!.query('COMMIT').catch(() => undefined);
          })();
        },
        content: actionAnswer('不应发布旧私域内容。', [`observation:${facts.observationA}`]),
      },
    ]);
    const r2FinalLockPromise = postRun(
      base,
      authA,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: r2FinalLockId,
        user_text: '[app1:finallock] 最后保存边界',
        expected_conversation_revision: convA.revision,
      }),
    );
    await r2FinalLocked.promise;
    await stub.waitForRequest('[app1:finallock]', 2);
    // run 行锁持有期间：服务端的终态保存必须停在 active，不得先行落账。
    await sleepMs(800);
    const r2FinalStateWhileLocked = await database.query<{ state: string }>(
      'SELECT state FROM yaya_runs WHERE client_request_id = $1',
      [r2FinalLockId],
    );
    check(
      'R2-A 锁持有期间终局未落账（仍 active）',
      r2FinalStateWhileLocked.rows[0]?.state === 'active',
    );
    await moveChildA(facts.classB);
    r2FinalRelease.resolve();
    const r2FinalParsed = parseLines(await openNdjson(await r2FinalLockPromise).collect());
    check(
      'R2-A 锁等待期间来源降级 → 拒绝发布旧私域回答（context_revoked）',
      r2FinalParsed.verdict.ok &&
        r2FinalParsed.verdict.outcome.kind === 'stopped' &&
        r2FinalParsed.verdict.outcome.reason === 'context_revoked' &&
        !r2FinalParsed.events.some((event) => event.type === 'answer'),
    );
    await moveChildA(facts.classA);

    // P2-C：非法 ref 与合法 message/fragment（或 image）选择器并存时不得豁免。
    const mixedSelector = parseStoredDependencies([
      {
        ref: { kind: 'alien', ref_id: 'observation:unknown', label: null, derived_from: null },
        tool: 'get_observation',
        image_id: null,
        message_id: 'some-message',
        fragment_id: 'some-fragment',
        projection: 'full',
      },
    ]);
    check(
      'R2-C 未知 ref 与合法 message/fragment 并存 → 整组损坏',
      mixedSelector.corrupt === true && mixedSelector.dependencies.length === 0,
    );
    const mixedImage = parseStoredDependencies([
      {
        ref: { kind: 'alien', ref_id: 'observation:unknown', label: null, derived_from: null },
        tool: null,
        image_id: 'image-1',
        message_id: null,
        fragment_id: null,
        projection: 'any',
      },
    ]);
    check(
      'R2-C 未知 ref 与合法 image 选择器并存 → 整组损坏',
      mixedImage.corrupt === true && mixedImage.dependencies.length === 0,
    );
    const nullRefImage = parseStoredDependencies([
      {
        ref: null,
        tool: null,
        image_id: 'image-1',
        message_id: null,
        fragment_id: null,
        projection: 'any',
      },
    ]);
    check(
      'R2-C 合法 ref=null + image 选择器仍有效（对照）',
      nullRefImage.corrupt === false && nullRefImage.dependencies.length === 1,
    );
    const validRefPair = parseStoredDependencies([
      {
        ref: { kind: 'tool_result', ref_id: `observation:${facts.observationA}`, label: null, derived_from: null },
        tool: 'get_observation',
        image_id: null,
        message_id: 'm-1',
        fragment_id: 'f-1',
        projection: 'full',
      },
    ]);
    check(
      'R2-C 合法 ref + message/fragment 选择器仍有效（对照）',
      validRefPair.corrupt === false && validRefPair.dependencies.length === 1,
    );

    /* ============================== R3：锁等待后的身份/来源/权限前提 ============================== */

    await r2Racer.query('ROLLBACK').catch(() => undefined);
    await r2Lock.query('ROLLBACK').catch(() => undefined);

    // 反例 A1：run 锁等待跨过会话自然到期；共享锁能串行化撤销行 UPDATE，却冻结不了墙钟。
    const a1Session = await directSession(database, facts.teacherA.id, 10);
    const a1Auth = { cookie: `${SESSION_COOKIE_NAME}=${a1Session.token}`, csrf: a1Session.csrf };
    const a1Id = `expiry-${randomUUID()}`;
    const a1Locked = deferred();
    const a1Release = deferred();
    gates.push(a1Release.resolve);
    stub.register('[app1:expiry]', [
      {
        prepare: async () => {
          const db = database;
          if (db === null) throw new Error('database unavailable');
          const rows = await db.query<{ id: string }>(
            'SELECT id FROM yaya_runs WHERE client_request_id = $1',
            [a1Id],
          );
          const serviceRunId = rows.rows[0]?.id;
          if (!serviceRunId) throw new Error('expiry run not found');
          await r2Lock!.query('BEGIN');
          await r2Lock!.query('SELECT id FROM yaya_runs WHERE id = $1 FOR UPDATE', [serviceRunId]);
          a1Locked.resolve();
          void (async () => {
            await a1Release.promise;
            await r2Lock!.query('COMMIT').catch(() => undefined);
          })();
        },
        content: actionAnswer('会话到期后不应发布。'),
      },
    ]);
    const a1Response = await postRun(
      base,
      a1Auth,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: a1Id,
        user_text: '[app1:expiry] 锁等待到期',
        expected_conversation_revision: convA.revision,
      }),
    );
    await a1Locked.promise;
    const a1Stream = openNdjson(a1Response);
    const a1Action = await readUntilActionParsed(a1Stream);
    const a1Remaining = await database.query<{ remaining_ms: string }>(
      'SELECT EXTRACT(EPOCH FROM (expires_at - clock_timestamp())) * 1000 AS remaining_ms FROM app_sessions WHERE token_hash = $1',
      [hashSessionToken(a1Session.token)],
    );
    check(
      'R3-A 进入保存边界前会话仍有效（剩余 >3000ms，受控交错）',
      a1Action && Number(a1Remaining.rows[0]?.remaining_ms ?? 0) > 3000,
    );
    const a1Active = await database.query<{ state: string }>(
      'SELECT state FROM yaya_runs WHERE client_request_id = $1',
      [a1Id],
    );
    check('R3-A 锁等待期间 run 仍活跃（终态未落）', a1Active.rows[0]?.state === 'active');
    let a1Expired = false;
    for (let attempt = 0; attempt < 250; attempt += 1) {
      const expired = await database.query<{ expired: boolean }>(
        'SELECT expires_at < clock_timestamp() AS expired FROM app_sessions WHERE token_hash = $1',
        [hashSessionToken(a1Session.token)],
      );
      if (expired.rows[0]?.expired === true) {
        a1Expired = true;
        break;
      }
      await sleepMs(60);
    }
    check('R3-A 锁等待期间会话墙钟已到期（受控交错）', a1Expired);
    a1Release.resolve();
    const a1Parsed = parseLines(await a1Stream.collect());
    const a1Row = await database.query<{ kind: string | null; reason: string | null; after_expiry: boolean | null }>(
      `SELECT outcome->>'kind' AS kind, outcome->>'reason' AS reason,
              terminal_at > (SELECT expires_at FROM app_sessions WHERE token_hash = $1) AS after_expiry
         FROM yaya_runs WHERE client_request_id = $2`,
      [hashSessionToken(a1Session.token), a1Id],
    );
    check(
      'R3-A 跨过会话到期的锁等待 → 拒绝发布（唯一 run_end stopped session_invalid，无 answer）',
      a1Parsed.allParsed &&
        a1Parsed.verdict.ok &&
        !a1Parsed.events.some((event) => event.type === 'answer') &&
        a1Parsed.verdict.outcome.kind === 'stopped' &&
        a1Parsed.verdict.outcome.reason === 'session_invalid',
    );
    check(
      'R3-A 落账按实际当前时刻裁决（stopped session_invalid 且 terminal_at 晚于 expires_at）',
      a1Row.rows[0]?.kind === 'stopped' &&
        a1Row.rows[0]?.reason === 'session_invalid' &&
        a1Row.rows[0]?.after_expiry === true,
    );
    const a1Lookup = await lookupRun(base, authA, convA.conversation_id, a1Id);
    const a1LookupBody = (await a1Lookup.json()) as {
      status?: string;
      outcome?: { kind?: string; reason?: string };
    };
    check(
      'R3-A 查询口径一致（finished + stopped session_invalid）',
      a1LookupBody.status === 'finished' &&
        a1LookupBody.outcome?.kind === 'stopped' &&
        a1LookupBody.outcome?.reason === 'session_invalid',
    );

    // 对照 A2：同样的 run 锁等待，但会话未跨期 → 正常回答。
    const a2Session = await directSession(database, facts.teacherA.id);
    const a2Auth = { cookie: `${SESSION_COOKIE_NAME}=${a2Session.token}`, csrf: a2Session.csrf };
    const a2Id = `expiry-ok-${randomUUID()}`;
    const a2Locked = deferred();
    const a2Release = deferred();
    gates.push(a2Release.resolve);
    stub.register('[app1:expiry-ok]', [
      {
        prepare: async () => {
          const db = database;
          if (db === null) throw new Error('database unavailable');
          const rows = await db.query<{ id: string }>(
            'SELECT id FROM yaya_runs WHERE client_request_id = $1',
            [a2Id],
          );
          const serviceRunId = rows.rows[0]?.id;
          if (!serviceRunId) throw new Error('expiry-ok run not found');
          await r2Lock!.query('BEGIN');
          await r2Lock!.query('SELECT id FROM yaya_runs WHERE id = $1 FOR UPDATE', [serviceRunId]);
          a2Locked.resolve();
          void (async () => {
            await a2Release.promise;
            await r2Lock!.query('COMMIT').catch(() => undefined);
          })();
        },
        content: actionAnswer('锁等待未跨期，正常发布。'),
      },
    ]);
    const a2Response = await postRun(
      base,
      a2Auth,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: a2Id,
        user_text: '[app1:expiry-ok] 锁等待未跨期',
        expected_conversation_revision: convA.revision,
      }),
    );
    await a2Locked.promise;
    const a2Stream = openNdjson(a2Response);
    const a2Action = await readUntilActionParsed(a2Stream);
    check('R3-A 对照：正常会话进入保存边界有效且动作已解析', a2Action);
    a2Release.resolve();
    const a2Parsed = parseLines(await a2Stream.collect());
    check(
      'R3-A 对照：锁等待未跨期 → 正常回答（answered）',
      a2Parsed.allParsed && a2Parsed.verdict.ok && a2Parsed.verdict.outcome.kind === 'answered',
    );
    const a2Lookup = await lookupRun(base, authA, convA.conversation_id, a2Id);
    const a2LookupBody = (await a2Lookup.json()) as {
      status?: string;
      outcome?: { kind?: string };
    };
    check(
      'R3-A 对照：查询可读（finished + answered）',
      a2LookupBody.status === 'finished' && a2LookupBody.outcome?.kind === 'answered',
    );

    // 对照 A3：已到期会话在身份阶段（run 锁之前）即停。
    const a3Session = await directSession(database, facts.teacherA.id, -5);
    const a3SessionId =
      (
        await database.query<{ id: string }>('SELECT id FROM app_sessions WHERE token_hash = $1', [
          hashSessionToken(a3Session.token),
        ])
      ).rows[0]?.id ?? '';
    const a3Run = await makeBoundaryRun(a3SessionId);
    const a3Stored = await finalizeYayaRun(a3Run.run_id, 'app1-check-boundary', candidateAnswered, {
      verify: (client) =>
        verifyYayaRunBoundaryIdentity(client, { run: a3Run, token: a3Session.token }),
    });
    check(
      'R3-A 对照：已到期会话在身份阶段即停（stopped session_invalid）',
      outcomeOf(a3Stored).kind === 'stopped' && outcomeOf(a3Stored).reason === 'session_invalid',
    );

    // 反例 B1：可信 peer 先落已存终态，随后转班；发布分支必须核验实际待发布记录自身的来源。
    const peerTermGate = deferred();
    gates.push(peerTermGate.resolve);
    stub.register('[app1:peerterm]', [
      { content: actionRead('get_observation', { observation_id: facts.observationA }) },
      { hold: peerTermGate.promise, content: actionAnswer('已存终态后不应发布旧内容。') },
    ]);
    const b1Id = `peerterm-${randomUUID()}`;
    const b1Promise = postRun(
      base,
      authA,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: b1Id,
        user_text: '[app1:peerterm] 已存终态恢复',
        expected_conversation_revision: convA.revision,
      }),
    );
    await stub.waitForRequest('[app1:peerterm]', 2);
    const b1Rows = await database.query<{ id: string; owner_instance: string }>(
      'SELECT id, owner_instance FROM yaya_runs WHERE client_request_id = $1',
      [b1Id],
    );
    const b1Run = b1Rows.rows[0];
    if (!b1Run) throw new Error('peerterm run not found');
    const PEER_TERM_MARKER = 'APP1_R3_PEER_FALLBACK_MARKER';
    const peerTermStored = await finalizeYayaRun(b1Run.id, b1Run.owner_instance, {
      kind: 'answered',
      content: `${PEER_TERM_MARKER} 不应发布。`,
      sources: [],
    });
    check('R3-B 夹具：可信 peer 先落已存终态（answered）', outcomeOf(peerTermStored).kind === 'answered');
    await enrollChildInClass({ child_id: facts.childA, class_id: facts.classB });
    peerTermGate.resolve();
    const b1Parsed = parseLines(await openNdjson(await b1Promise).collect());
    const b1Db = await database.query<{ outcome: unknown }>('SELECT outcome FROM yaya_runs WHERE id = $1', [
      b1Run.id,
    ]);
    const b1Lookup = await lookupRun(base, authA, convA.conversation_id, b1Id);
    const b1LookupText = JSON.stringify(await b1Lookup.json());
    check(
      'R3-B 已存终态经当前授权核验后不发布旧私域内容（无 answer、run_end stopped context_revoked）',
      b1Parsed.allParsed &&
        b1Parsed.verdict.ok &&
        !b1Parsed.events.some((event) => event.type === 'answer') &&
        b1Parsed.verdict.outcome.kind === 'stopped' &&
        b1Parsed.verdict.outcome.reason === 'context_revoked',
    );
    check(
      'R3-B 不覆盖 peer 已提交终态（库内仍是 peer 内容）',
      JSON.stringify(b1Db.rows[0]?.outcome ?? null).includes(PEER_TERM_MARKER),
    );
    check(
      'R3-B 查询口径一致（unverifiable，不含标记）',
      !b1LookupText.includes(PEER_TERM_MARKER) && b1LookupText.includes('unverifiable'),
    );
    await enrollChildInClass({ child_id: facts.childA, class_id: facts.classA });

    // 对照 B2：核验通过时已存终态正常发布（同一原语、无转班）。
    const peerOkGate = deferred();
    gates.push(peerOkGate.resolve);
    stub.register('[app1:peerok]', [
      { content: actionRead('get_observation', { observation_id: facts.observationA }) },
      { hold: peerOkGate.promise, content: actionAnswer('已存终态正常发布对照。') },
    ]);
    const b2Id = `peerok-${randomUUID()}`;
    const b2Promise = postRun(
      base,
      authA,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: b2Id,
        user_text: '[app1:peerok] 已存终态对照',
        expected_conversation_revision: convA.revision,
      }),
    );
    await stub.waitForRequest('[app1:peerok]', 2);
    const b2Rows = await database.query<{ id: string; owner_instance: string }>(
      'SELECT id, owner_instance FROM yaya_runs WHERE client_request_id = $1',
      [b2Id],
    );
    const b2Run = b2Rows.rows[0];
    if (!b2Run) throw new Error('peerok run not found');
    const PEER_OK_MARKER = 'APP1_R3_PEER_OK_MARKER';
    const peerOkStored = await finalizeYayaRun(b2Run.id, b2Run.owner_instance, {
      kind: 'answered',
      content: `${PEER_OK_MARKER} 可正常发布。`,
      sources: [],
    });
    check('R3-B 对照夹具：peer 终态落库（answered）', outcomeOf(peerOkStored).kind === 'answered');
    peerOkGate.resolve();
    const b2Parsed = parseLines(await openNdjson(await b2Promise).collect());
    check(
      'R3-B 对照：核验通过 → 已存终态正常发布（answer 含 peer 内容）',
      b2Parsed.allParsed &&
        b2Parsed.verdict.ok &&
        b2Parsed.verdict.outcome.kind === 'answered' &&
        b2Parsed.verdict.outcome.content.includes(PEER_OK_MARKER),
    );
    const b2Lookup = await lookupRun(base, authA, convA.conversation_id, b2Id);
    const b2LookupText = JSON.stringify(await b2Lookup.json());
    check(
      'R3-B 对照：查询可读且含内容（finished）',
      b2LookupText.includes('"status":"finished"') && b2LookupText.includes(PEER_OK_MARKER),
    );

    // 反例 C1：多来源 —— 后项来源等待期间，前项已核验来源的权限前提必须保护到提交。
    const childC = randomUUID();
    await database.query(
      "INSERT INTO children (id, name, gender, birth_date, class_name) VALUES ($1,'孙小满','女','2021-03-03','松果班')",
      [childC],
    );
    await database.query(
      "INSERT INTO child_class_enrollments (child_id, class_id, start_date) VALUES ($1,$2,'2026-01-01')",
      [childC, facts.classA],
    );
    const c1Conv = await createConversation(base, authA);
    const c1Saved = await saveMessage(
      base,
      authA,
      c1Conv.conversation_id,
      c1Conv.revision,
      '孙小满今天在娃娃家照顾弟弟娃娃。',
      childC,
    );
    check(
      'R3-C 前置：多来源历史片段已登记（会话版本推进）',
      c1Conv.status === 201 && c1Saved.status === 201 && c1Saved.revision === 2,
    );
    const c1Id = `multisource-${randomUUID()}`;
    const c1Locked = deferred();
    const c1Gate = deferred();
    const c1Release = deferred();
    gates.push(c1Gate.resolve);
    gates.push(c1Release.resolve);
    stub.register('[app1:multisource]', [
      { content: actionRead('get_observation', { observation_id: facts.observationA }) },
      {
        prepare: async () => {
          const db = database;
          if (db === null) throw new Error('database unavailable');
          const rows = await db.query<{ id: string }>(
            'SELECT id FROM yaya_runs WHERE client_request_id = $1',
            [c1Id],
          );
          const serviceRunId = rows.rows[0]?.id;
          if (!serviceRunId) throw new Error('multisource run not found');
          await r2Lock!.query('BEGIN');
          await r2Lock!.query('SELECT id FROM yaya_runs WHERE id = $1 FOR UPDATE', [serviceRunId]);
          c1Locked.resolve();
          void (async () => {
            await c1Release.promise;
            await r2Lock!.query('COMMIT').catch(() => undefined);
          })();
        },
        hold: c1Gate.promise,
        content: actionAnswer('APP1_R3_MULTI_SOURCE_MARKER 转班竞态不应发布。', [
          `observation:${facts.observationA}`,
        ]),
      },
    ]);
    const c1Promise = postRun(
      base,
      authA,
      c1Conv.conversation_id,
      runBody({
        conversation_id: c1Conv.conversation_id,
        client_request_id: c1Id,
        user_text: '[app1:multisource] 多来源锁等待',
        expected_conversation_revision: c1Saved.revision,
      }),
    );
    await c1Locked.promise;
    c1Gate.resolve();
    const c1Stream = openNdjson(await c1Promise);
    // 等到 answer 的 action_parsed：答案动作的发布前重核已过（此刻 childC 空闲，必过），
    // 引擎随即进入保存边界；run 行锁仍被 r2Lock 占着，finalize 必然停在 run 锁上。
    // 之后才抢 childC，释放 run 锁后 finalize 的来源重核必然卡在 childC 共享锁上——
    // 若等首个（read 的）action_parsed，racer 会抢在引擎答案重核之前，把锁窗口挪到引擎边界。
    const c1Action = await readUntilActionParsed(c1Stream, 'answer');
    check('R3-C 引擎发布前重核已通过（answer action_parsed，进入保存边界）', c1Action);
    await r2Racer.query('BEGIN');
    await r2Racer.query('SELECT id FROM children WHERE id = $1 FOR UPDATE', [childC]);
    c1Release.resolve();
    // 第二次锁等待：finalize 在后项来源（历史片段 childC）的共享锁上实测等待。
    // 只认「已在 children 行上持有元组锁且仍在等事务」的等待者（唯一可能是 finalize 的来源重核）：
    // run 行锁的释放尾迹也是 transactionid 等待，若计入会在 finalize 取得 childA 共享锁之前放行转班。
    let c1Waiting = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const waitRows = await database.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks w
          WHERE w.locktype = 'transactionid' AND NOT w.granted AND w.pid <> pg_backend_pid()
            AND EXISTS (
              SELECT 1 FROM pg_locks h
               WHERE h.pid = w.pid AND h.granted AND h.locktype = 'tuple'
                 AND h.relation::regclass::text = 'children'
            )`,
      );
      if ((waitRows.rows[0]?.n ?? 0) > 0) {
        c1Waiting = true;
        break;
      }
      await sleepMs(100);
    }
    check('R3-C 第二次锁等待实测：finalize 卡在后项来源共享锁上', c1Waiting);
    let c1TransferDone = false;
    let c1TransferDbNowMs = Number.NaN;
    const c1Transfer = enrollChildInClass({ child_id: facts.childA, class_id: facts.classB }).then(
      async () => {
        c1TransferDone = true;
        const db = database;
        if (db === null) throw new Error('database unavailable');
        const nowRow = await db.query<{ db_now_ms: number }>(
          'SELECT EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS db_now_ms',
        );
        c1TransferDbNowMs = Number(nowRow.rows[0]?.db_now_ms ?? Number.NaN);
      },
    );
    await sleepMs(600);
    check('R3-C 前项已核验来源受锁保护（转班未在终态前提交）', !c1TransferDone);
    const c1State = await database.query<{ state: string }>(
      'SELECT state FROM yaya_runs WHERE client_request_id = $1',
      [c1Id],
    );
    check('R3-C 等待期间 run 仍活跃（终态未提交）', c1State.rows[0]?.state === 'active');
    await r2Racer.query('COMMIT');
    await Promise.race([c1Transfer, sleepMs(10_000)]);
    const c1Parsed = parseLines(await c1Stream.collect());
    check(
      'R3-C 整条流 API0 合法且单一终局（若发布 answer 必含标记）',
      c1Parsed.allParsed &&
        c1Parsed.verdict.ok &&
        (c1Parsed.verdict.outcome.kind === 'stopped' ||
          (c1Parsed.verdict.outcome.kind === 'answered' &&
            c1Parsed.verdict.outcome.content.includes('APP1_R3_MULTI_SOURCE_MARKER'))),
    );
    // children.updated_at = now() 取的是转班事务开始时刻（可能早于终态），不能证明提交顺序；
    // 改用「转班完成瞬间的 DB 时钟 >= terminal_at」——同一 DB 时钟源，无跨机偏差。
    const c1Timing = await database.query<{ terminal_epoch_ms: number | null }>(
      `SELECT (EXTRACT(EPOCH FROM r.terminal_at) * 1000) AS terminal_epoch_ms
         FROM yaya_runs r WHERE r.client_request_id = $1`,
      [c1Id],
    );
    const c1TerminalMs = Number(c1Timing.rows[0]?.terminal_epoch_ms ?? Number.NaN);
    check(
      'R3-C 转班提交晚于终态提交（权限前提保护到提交的时序证明）',
      Number.isFinite(c1TerminalMs) && Number.isFinite(c1TransferDbNowMs) && c1TerminalMs <= c1TransferDbNowMs,
    );
    await enrollChildInClass({ child_id: facts.childA, class_id: facts.classA });

    // 对照 C2：转班先提交 → 必须拒绝旧内容。
    const c2Gate = deferred();
    gates.push(c2Gate.resolve);
    stub.register('[app1:multisource2]', [
      { content: actionRead('get_observation', { observation_id: facts.observationA }) },
      {
        hold: c2Gate.promise,
        content: actionAnswer('APP1_R3_MULTI_SOURCE_MARKER 先转班后不应发布。', [
          `observation:${facts.observationA}`,
        ]),
      },
    ]);
    const c2Id = `multisource2-${randomUUID()}`;
    const c2Promise = postRun(
      base,
      authA,
      c1Conv.conversation_id,
      runBody({
        conversation_id: c1Conv.conversation_id,
        client_request_id: c2Id,
        user_text: '[app1:multisource2] 先转班对照',
        expected_conversation_revision: c1Saved.revision,
      }),
    );
    await stub.waitForRequest('[app1:multisource2]', 2);
    await enrollChildInClass({ child_id: facts.childA, class_id: facts.classB });
    c2Gate.resolve();
    const c2Parsed = parseLines(await openNdjson(await c2Promise).collect());
    check(
      'R3-C 对照：转班先提交 → 拒绝旧内容（run_end stopped context_revoked，无 answer）',
      c2Parsed.allParsed &&
        c2Parsed.verdict.ok &&
        !c2Parsed.events.some((event) => event.type === 'answer') &&
        c2Parsed.verdict.outcome.kind === 'stopped' &&
        c2Parsed.verdict.outcome.reason === 'context_revoked',
    );
    await enrollChildInClass({ child_id: facts.childA, class_id: facts.classA });

    /* ============ R4：终态已提交后，发布/恢复门禁的等待跨过会话到期 ============ */

    // 共享可呈现边界（runTerminalPresentable）在来源异步核验（children/历史/图片锁等待）之后
    // 必须按当前事实再核身份；进入时的 principal 与 session_valid=true 只代表核验开始时有效。
    // 反例手法：真实终态已提交后，用独立连接持 child 行锁让发布/恢复的来源核验实测等待；
    // 等待开始时会话有效，放行前用真实墙钟到期；到期后不得输出任何受限正文，
    // 已提交记录/回执不变，且不得重复派发。

    const r2RacerPid = Number(
      (await r2Racer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? 0,
    );
    const r2LockPid = Number(
      (await r2Lock.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? 0,
    );

    /** 实测「有连接被指定 backend pid 阻塞」出现（pg_locks 未授予等待 + pg_blocking_pids 精确指向） */
    const waitForBlockedBy = async (blockerPid: number, timeoutMs: number): Promise<boolean> => {
      const db = database;
      if (db === null) throw new Error('database unavailable');
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const rows = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks w
            WHERE NOT w.granted AND w.pid <> pg_backend_pid()
              AND pg_blocking_pids(w.pid) @> ARRAY[$1::int]`,
          [blockerPid],
        );
        if ((rows.rows[0]?.n ?? 0) > 0) return true;
        await sleepMs(50);
      }
      return false;
    };
    const sessionValidNow = async (tokenHash: string): Promise<boolean> => {
      const db = database;
      if (db === null) throw new Error('database unavailable');
      const rows = await db.query<{ valid: boolean }>(
        'SELECT expires_at > clock_timestamp() AS valid FROM app_sessions WHERE token_hash = $1',
        [tokenHash],
      );
      return rows.rows[0]?.valid === true;
    };
    const waitSessionExpired = async (tokenHash: string, timeoutMs: number): Promise<boolean> => {
      const db = database;
      if (db === null) throw new Error('database unavailable');
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const rows = await db.query<{ expired: boolean }>(
          'SELECT expires_at <= clock_timestamp() AS expired FROM app_sessions WHERE token_hash = $1',
          [tokenHash],
        );
        if (rows.rows[0]?.expired === true) return true;
        await sleepMs(50);
      }
      return false;
    };
    const expireWithin = async (tokenHash: string, seconds: number): Promise<void> => {
      const db = database;
      if (db === null) throw new Error('database unavailable');
      await db.query(
        'UPDATE app_sessions SET expires_at = clock_timestamp() + make_interval(secs => $2) WHERE token_hash = $1',
        [tokenHash, seconds],
      );
    };

    /* ---------- D1：live 发布门禁等待跨期（自身 finalize 提交后的发布阶段） ---------- */

    const d1Session = await directSession(database, facts.teacherA.id, 600);
    const d1Auth = { cookie: d1Session.cookie, csrf: d1Session.csrf };
    const d1TokenHash = hashSessionToken(d1Session.token);
    const d1Id = `r4-live-${randomUUID()}`;
    const d1Locked = deferred();
    const d1Gate = deferred();
    const d1Release = deferred();
    gates.push(d1Gate.resolve, d1Release.resolve);
    stub.register('[app1:r4-live-expire]', [
      { content: actionRead('get_observation', { observation_id: facts.observationA }) },
      {
        prepare: async () => {
          const db = database;
          if (db === null) throw new Error('database unavailable');
          const rows = await db.query<{ id: string }>(
            'SELECT id FROM yaya_runs WHERE client_request_id = $1',
            [d1Id],
          );
          const serviceRunId = rows.rows[0]?.id;
          if (!serviceRunId) throw new Error('r4 live run not found');
          await r2Lock!.query('BEGIN');
          await r2Lock!.query('SELECT id FROM yaya_runs WHERE id = $1 FOR UPDATE', [serviceRunId]);
          d1Locked.resolve();
          void (async () => {
            await d1Release.promise;
            await r2Lock!.query('COMMIT').catch(() => undefined);
          })();
        },
        hold: d1Gate.promise,
        content: actionAnswer('R4_LIVE_MARKER 不应发布。', [`observation:${facts.observationA}`]),
      },
    ]);
    const d1CallsBefore = stub.total;
    const d1Promise = postRun(
      base,
      d1Auth,
      c1Conv.conversation_id,
      runBody({
        conversation_id: c1Conv.conversation_id,
        client_request_id: d1Id,
        user_text: '[app1:r4-live-expire] 终态提交后发布等待跨期',
        expected_conversation_revision: c1Saved.revision,
      }),
    );
    await d1Locked.promise;
    // 收紧会话 TTL 必须先于 finalize 的 verify（其会话 FOR SHARE 会挡住行更新；
    // 且 run 锁/来源锁交错会形成行使测试自锁的等待链）。6s 覆盖到发布门禁开始，
    // 并在发布来源等待（racer2 持 childA）期间自然到期。
    await expireWithin(d1TokenHash, 6);
    d1Gate.resolve();
    const d1Stream = openNdjson(await d1Promise);
    const d1Action = await readUntilActionParsed(d1Stream, 'answer');
    check('R4-D live：answer 动作已解析（进入保存边界）', d1Action);
    // childC 行锁：finalize 已持 childA 共享锁后必然卡在 childC（与 R3 同一锁序）
    await r2Racer.query('BEGIN');
    await r2Racer.query('SELECT id FROM children WHERE id = $1 FOR UPDATE', [childC]);
    d1Release.resolve();
    const d1SaveWait = await waitForBlockedBy(r2RacerPid, 10_000);
    // racer2 排在 finalize 的 childA 共享锁之后：finalize 提交时由它接住 childA，发布门禁必然等待
    await r2Lock.query('BEGIN');
    void r2Lock
      .query('SELECT id FROM children WHERE id = $1 FOR UPDATE', [facts.childA])
      .catch(() => undefined);
    await r2Racer.query('COMMIT');
    const d1PublishWait = await waitForBlockedBy(r2LockPid, 10_000);
    const d1Row = await database.query<{ state: string; kind: string }>(
      "SELECT state, outcome->>'kind' AS kind FROM yaya_runs WHERE client_request_id = $1",
      [d1Id],
    );
    const d1ValidAtWait = await sessionValidNow(d1TokenHash);
    check(
      'R4-D live：终态已提交且发布来源核验实测等待（等待开始时会话有效）',
      d1SaveWait &&
        d1PublishWait &&
        d1Row.rows[0]?.state === 'terminal' &&
        d1Row.rows[0]?.kind === 'answered' &&
        d1ValidAtWait,
    );
    const d1Expired = await waitSessionExpired(d1TokenHash, 20_000);
    check('R4-D live：放行前会话已自然到期（等待期间墙钟跨期）', d1Expired);
    await r2Lock.query('COMMIT');
    const d1Parsed = parseLines(await d1Stream.collect());
    check(
      'R4-D live：到期后不发布正文（无 answer/标记，唯一 run_end stopped session_invalid）',
      d1Parsed.allParsed &&
        d1Parsed.verdict.ok &&
        !d1Parsed.events.some((event) => event.type === 'answer') &&
        d1Parsed.verdict.outcome.kind === 'stopped' &&
        d1Parsed.verdict.outcome.reason === 'session_invalid',
    );
    const d1Db = await database.query<{ state: string; outcome: string }>(
      "SELECT state, outcome::text AS outcome FROM yaya_runs WHERE client_request_id = $1",
      [d1Id],
    );
    check(
      'R4-D live：已提交终态未被覆盖且未重复派发（库内 answered + 标记，模型恰 2 次）',
      d1Db.rows[0]?.state === 'terminal' &&
        (d1Db.rows[0]?.outcome ?? '').includes('R4_LIVE_MARKER') &&
        stub.total - d1CallsBefore === 2,
    );
    const d1ExpiredLookup = await lookupRun(base, d1Auth, c1Conv.conversation_id, d1Id);
    check('R4-D live：过期令牌查询被拒（unauthenticated 401）', d1ExpiredLookup.status === 401);
    const d1Fresh = await directSession(database, facts.teacherA.id);
    const d1FreshLookup = await lookupRun(base, d1Fresh, c1Conv.conversation_id, d1Id);
    const d1FreshBody = (await d1FreshLookup.json()) as {
      status?: string;
      outcome?: { content?: string };
    };
    check(
      'R4-D live：同 owner 新会话合法恢复旧终态（finished + 标记）',
      d1FreshLookup.status === 200 &&
        d1FreshBody.status === 'finished' &&
        (d1FreshBody.outcome?.content ?? '').includes('R4_LIVE_MARKER'),
    );

    /* ---------- D2/D2b：已存终态（peer 先提交）发布门禁等待跨期与未跨期对照 ---------- */

    const d2Conv = await createConversation(base, authA);
    check('R4-D 前置：已存终态对照会话已建立', d2Conv.status === 201);

    async function storedPublishProbe(
      tag: string,
      requestId: string,
      body: string,
      expire: boolean,
    ): Promise<{
      waitObserved: boolean;
      rowState: string;
      outcomeText: string;
      validAtWait: boolean;
      expired: boolean;
      parsed: ReturnType<typeof parseLines>;
      calls: number;
    }> {
      const db = database;
      const racer = r2Racer;
      const lock = r2Lock;
      const modelStub = stub;
      if (db === null || racer === null || lock === null || modelStub === null) {
        throw new Error('r4 stored probe unavailable');
      }
      const session = await directSession(db, facts.teacherA.id, 600);
      const tokenHash = hashSessionToken(session.token);
      const locked = deferred();
      const gate = deferred();
      const release = deferred();
      gates.push(gate.resolve, release.resolve);
      modelStub.register(tag, [
        { content: actionRead('get_observation', { observation_id: facts.observationA }) },
        {
          prepare: async () => {
            const rows = await db.query<{ id: string; owner_instance: string }>(
              'SELECT id, owner_instance FROM yaya_runs WHERE client_request_id = $1',
              [requestId],
            );
            const run = rows.rows[0];
            if (!run) throw new Error('r4 stored run not found');
            // 可信 peer 先以真实 finalize 原语提交 answered 终态，再占 run 锁：
            // 本 run 的 finalize 必然停在 run 锁上，且引擎在下一异步边界按 run_replaced 停止。
            const peer = await finalizeYayaRun(run.id, run.owner_instance, {
              kind: 'answered',
              content: `R4_STORED_MARKER ${requestId} 不应发布。`,
              sources: [],
            });
            if (peer === null) throw new Error('r4 peer terminal not committed');
            await lock.query('BEGIN');
            await lock.query('SELECT id FROM yaya_runs WHERE id = $1 FOR UPDATE', [run.id]);
            locked.resolve();
            void (async () => {
              await release.promise;
              await lock.query('COMMIT').catch(() => undefined);
            })();
          },
          hold: gate.promise,
          content: actionAnswer('R4_STORED_ENGINE_MARKER 不应发布。'),
        },
      ]);
      const callsBefore = modelStub.total;
      const responsePromise = postRun(
        base,
        { cookie: session.cookie, csrf: session.csrf },
        d2Conv.conversation_id,
        body,
      );
      await locked.promise;
      // 同 D1：收紧 TTL 必须先于 finalize 的 verify（会话 FOR SHARE 挡行更新），
      // 且要在 run 锁放行之前完成，使到期落在发布门禁的来源等待窗口内。
      if (expire) await expireWithin(tokenHash, 6);
      gate.resolve();
      // run 锁被占：抢住 childA 必须先于 run 锁放行，放行后发布门禁的来源核验必然等待
      await racer.query('BEGIN');
      await racer.query('SELECT id FROM children WHERE id = $1 FOR UPDATE', [facts.childA]);
      release.resolve();
      const waitObserved = await waitForBlockedBy(r2RacerPid, 10_000);
      const row = await db.query<{ state: string; outcome: string }>(
        "SELECT state, outcome::text AS outcome FROM yaya_runs WHERE client_request_id = $1",
        [requestId],
      );
      const validAtWait = await sessionValidNow(tokenHash);
      const expired = expire ? await waitSessionExpired(tokenHash, 20_000) : false;
      await racer.query('COMMIT');
      const parsed = parseLines(await openNdjson(await responsePromise).collect());
      return {
        waitObserved,
        rowState: row.rows[0]?.state ?? '',
        outcomeText: row.rows[0]?.outcome ?? '',
        validAtWait,
        expired,
        parsed,
        calls: modelStub.total - callsBefore,
      };
    }

    const d2Id = `r4-stored-${randomUUID()}`;
    const d2Body = runBody({
      conversation_id: d2Conv.conversation_id,
      client_request_id: d2Id,
      user_text: '[app1:r4-stored-expire] 已存终态发布等待跨期',
      expected_conversation_revision: d2Conv.revision,
    });
    const d2Probe = await storedPublishProbe('[app1:r4-stored-expire]', d2Id, d2Body, true);
    check(
      'R4-D stored：已存终态已提交且发布来源核验实测等待（等待开始时会话有效）',
      d2Probe.waitObserved &&
        d2Probe.rowState === 'terminal' &&
        d2Probe.outcomeText.includes('R4_STORED_MARKER') &&
        d2Probe.validAtWait,
    );
    check('R4-D stored：放行前会话已自然到期', d2Probe.expired);
    check(
      'R4-D stored：到期后不发布已存正文（无 answer/标记，唯一 run_end stopped session_invalid）',
      d2Probe.parsed.allParsed &&
        d2Probe.parsed.verdict.ok &&
        !d2Probe.parsed.events.some((event) => event.type === 'answer') &&
        d2Probe.parsed.verdict.outcome.kind === 'stopped' &&
        d2Probe.parsed.verdict.outcome.reason === 'session_invalid',
    );
    check(
      'R4-D stored：已提交 peer 终态未被覆盖且未重复派发（库内标记仍在，模型恰 2 次）',
      d2Probe.outcomeText.includes('R4_STORED_MARKER') && d2Probe.calls === 2,
    );

    const d2bId = `r4-stored-ok-${randomUUID()}`;
    const d2bBody = runBody({
      conversation_id: d2Conv.conversation_id,
      client_request_id: d2bId,
      user_text: '[app1:r4-stored-ok] 已存终态发布未跨期对照',
      expected_conversation_revision: d2Conv.revision,
    });
    const d2bProbe = await storedPublishProbe('[app1:r4-stored-ok]', d2bId, d2bBody, false);
    check(
      'R4-D 对照：已存终态发布等待未跨期 → 正常发布（answered + 已存标记）',
      d2bProbe.waitObserved &&
        d2bProbe.validAtWait &&
        d2bProbe.parsed.allParsed &&
        d2bProbe.parsed.verdict.ok &&
        d2bProbe.parsed.verdict.outcome.kind === 'answered' &&
        d2bProbe.parsed.events.some(
          (event) => event.type === 'answer' && event.content.includes('R4_STORED_MARKER'),
        ),
    );

    /* ---------- D3：GET 原 run 恢复来源核验等待期间到期 ---------- */

    const d3Session = await directSession(database, facts.teacherA.id, 600);
    const d3TokenHash = hashSessionToken(d3Session.token);
    await r2Racer.query('BEGIN');
    await r2Racer.query('SELECT id FROM children WHERE id = $1 FOR UPDATE', [facts.childA]);
    await expireWithin(d3TokenHash, 6);
    const d3Pending = lookupRun(base, d3Session, d2Conv.conversation_id, d2Id);
    const d3WaitObserved = await waitForBlockedBy(r2RacerPid, 10_000);
    const d3ValidAtWait = await sessionValidNow(d3TokenHash);
    const d3Expired = await waitSessionExpired(d3TokenHash, 20_000);
    check(
      'R4-D lookup：恢复来源核验实测等待、开始时有效、放行前到期',
      d3WaitObserved && d3ValidAtWait && d3Expired,
    );
    await r2Racer.query('COMMIT');
    const d3Response = await d3Pending;
    const d3Text = await d3Response.text();
    check(
      'R4-D lookup：到期后拒绝旧正文（401 unauthenticated，无已存标记）',
      d3Response.status === 401 && !d3Text.includes('R4_STORED_MARKER'),
    );

    /* ---------- D4：同 client_request_id 的终态回放等待期间到期 ---------- */

    const d4Session = await directSession(database, facts.teacherA.id, 600);
    const d4TokenHash = hashSessionToken(d4Session.token);
    await r2Racer.query('BEGIN');
    await r2Racer.query('SELECT id FROM children WHERE id = $1 FOR UPDATE', [facts.childA]);
    await expireWithin(d4TokenHash, 6);
    const d4Pending = postRun(base, d4Session, d2Conv.conversation_id, d2Body);
    const d4WaitObserved = await waitForBlockedBy(r2RacerPid, 10_000);
    const d4ValidAtWait = await sessionValidNow(d4TokenHash);
    const d4Expired = await waitSessionExpired(d4TokenHash, 20_000);
    check(
      'R4-D 回放：同键回放来源核验实测等待、开始时有效、放行前到期',
      d4WaitObserved && d4ValidAtWait && d4Expired,
    );
    await r2Racer.query('COMMIT');
    const d4Response = await d4Pending;
    const d4Text = await d4Response.text();
    check(
      'R4-D 回放：到期后拒绝回放过旧内容（401 unauthenticated，无已存标记）',
      d4Response.status === 401 && !d4Text.includes('R4_STORED_MARKER'),
    );

    /* ---------- D5 对照：同 owner 新会话对已存终态的合法只读恢复 ---------- */

    const d5Fresh = await directSession(database, facts.teacherA.id);
    const d5Lookup = await lookupRun(base, d5Fresh, d2Conv.conversation_id, d2Id);
    const d5Body = (await d5Lookup.json()) as { status?: string; outcome?: { content?: string } };
    check(
      'R4-D 对照：同 owner 新会话合法恢复已存终态（finished + 标记）',
      d5Lookup.status === 200 &&
        d5Body.status === 'finished' &&
        (d5Body.outcome?.content ?? '').includes('R4_STORED_MARKER'),
    );

    /* ============================== 中断恢复标记 ============================== */

    await database.query(
      "UPDATE yaya_runs SET state = 'interrupted', updated_at = now() WHERE id = $1",
      [replaceRunId],
    );
    const interruptedLookup = await lookupRun(base, authA, convA.conversation_id, replaceId);
    const interruptedBody = (await interruptedLookup.json()) as { status?: string; reason?: string };
    check(
      '中断恢复标记 → 查询不可核验（不冒充缺失/进行中）',
      interruptedBody.status === 'unverifiable' && interruptedBody.reason === 'terminal_unreadable',
    );

    check('模型替身无未登记请求', stub.unexpected.length === 0);

    /* ============================== 进程失联与跨进程查询 ============================== */

    const lostId = `lost-${randomUUID()}`;
    const lostPromise = postRun(
      base,
      authA,
      convA.conversation_id,
      runBody({
        conversation_id: convA.conversation_id,
        client_request_id: lostId,
        user_text: '[app1:lost] 进程失联',
        expected_conversation_revision: convA.revision,
      }),
    );
    await stub.waitForRequest('[app1:lost]', 1);
    const lostRows = await database.query<{ id: string }>(
      "SELECT id FROM yaya_runs WHERE client_request_id = $1 AND state = 'active'",
      [lostId],
    );
    const lostRunId = lostRows.rows[0]?.id ?? '';
    check('失联前 run 已持久化为活跃', lostRunId !== '');
    const stopReport = await stopTrackedChildTree(server1.tracked);
    check('真实 Next 进程已核验终止（进程失联）', stopReport.ok);
    void lostPromise.catch(() => undefined);

    server2 = await startNext('s2', childEnv);
    const base2 = server2.base;
    const beforeLostQueries = stub.total;
    const lostLookup = await lookupRun(base2, authA, convA.conversation_id, lostId);
    const lostBody = (await lostLookup.json()) as { status?: string; reason?: string };
    check(
      '跨进程查询失联活跃 run → 不可核验（不自动重跑）',
      lostBody.status === 'unverifiable' && lostBody.reason === 'owner_binding_failed',
    );
    const terminalLookup = await lookupRun(base2, authA, convA.conversation_id, basicId);
    const terminalBody = (await terminalLookup.json()) as { status?: string; run_id?: string };
    check(
      '跨进程查询真实终态（finished）',
      terminalBody.status === 'finished' && terminalBody.run_id === basicRunId,
    );
    check('跨进程查询不触发模型', stub.total === beforeLostQueries);

    /* ============================== 清理 ============================== */
    stage('checks-done');
  } finally {
    for (const resolve of gates) resolve();
    await runCleanupSteps(
      [
        {
          label: 'next-server-2',
          run: async () => {
            if (!server2) return;
            const report = await stopTrackedChildTree(server2.tracked);
            if (!report.ok) throw new Error(`${report.detail}\n${readLogTail(server2.tracked, 30)}`);
          },
        },
        {
          label: 'next-server-1',
          run: async () => {
            if (!server1) return;
            const report = await stopTrackedChildTree(server1.tracked);
            if (!report.ok) throw new Error(`${report.detail}\n${readLogTail(server1.tracked, 30)}`);
          },
        },
        {
          label: 'r2-clients',
          run: async () => {
            for (const [label, client] of [
              ['r2-racer', r2Racer],
              ['r2-lock', r2Lock],
            ] as const) {
              if (!client) continue;
              try {
                await client.query('ROLLBACK').catch(() => undefined);
                await client.end();
              } catch (error) {
                throw new Error(`${label}: ${String(error)}`);
              }
            }
          },
        },
        {
          label: 'generated-artifacts',
          run: () => {
            const report = restoreGeneratedArtifacts(artifactSnapshot, ROOT);
            if (report.issues.length > 0) throw new Error(report.issues.join('；'));
          },
        },
        { label: 'model-stub', run: () => stub?.close() },
        {
          label: 'pg-pool',
          run: async () => {
            const pool = (globalThis as { __pgPool?: { end: () => Promise<void> } }).__pgPool;
            if (!pool) return;
            (globalThis as { __pgPool?: unknown }).__pgPool = undefined;
            await pool.end();
          },
        },
        { label: 'database', run: () => database?.end().then(() => undefined) },
        {
          label: 'media-root',
          run: async () => {
            if (mediaRoot) await rm(mediaRoot, { recursive: true, force: true });
          },
        },
        {
          label: 'container',
          run: () => {
            if (!isolated) return;
            const report = isolated.teardown();
            if (!report.ok) throw new Error(report.detail);
          },
        },
        {
          label: 'logs',
          run: async () => {
            for (const handle of [server1, server2]) {
              if (handle) await rm(handle.logFile, { force: true }).catch(() => undefined);
            }
          },
        },
      ],
      (label, detail) => cleanupIssues.push(`${label}: ${detail}`),
    );
    if (mediaRoot) {
      const remaining = await readdir(mediaRoot).catch(() => [] as string[]);
      if (remaining.length > 0) cleanupIssues.push(`media-root 残留 ${remaining.length} 项`);
    }
    assertCleanupComplete(cleanupIssues);
  }

  console.log(
    JSON.stringify({
      passed,
      total: passed + failures.length,
      failures,
      run_id: RUN,
      layers: {
        server: 'real next dev (HTTP)',
        database: 'one-off isolated postgres',
        auth: 'real login/session/CSRF + direct sessions for auxiliary accounts',
        media: 'real sharp pipeline + own local object root',
        model: 'local StepFun-protocol stub (real llm.ts path, 0 real provider requests)',
        cross_process: 'check process reads same DB; owner process killed for lost-run case',
      },
    }),
  );
  if (failures.length > 0) process.exit(1);
}

function row0<T>(rows: T[]): T | null {
  return rows[0] ?? null;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
