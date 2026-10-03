import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { NextRequest } from 'next/server';
import { Client } from 'pg';

import { TEACHER_COOKIE, createSessionToken } from '../src/lib/auth';
import {
  buildEnrollmentSnapshot,
  buildTeacherConfirmedSnapshot,
  getReliableClass,
  parseReliableClass,
  resolveClassContextAt,
} from '../src/lib/class-context';
import {
  fetchClassContextState,
  isAbortError,
  parseClassContextResponse,
} from '../src/lib/class-context-client';
import { isoDateInShanghai } from '../src/lib/format';
import {
  ClassHistoryProtectedError,
  ObservationContextConflictError,
  createObservation,
  getObservation,
  listEnrollments,
  listObservations,
  updateClass,
} from '../src/lib/queries';
import {
  findSemesterConfigProblems,
  getCurrentSemester,
  getSemester,
  listSemesters,
  resolveEvidenceScope,
} from '../src/lib/semester';
import { CONFIGURED_SEMESTERS, SEMESTER_CALENDAR_NOTE } from '../src/lib/semester/config';
import { query, queryOne } from '../src/storage/database/pg-client';
import type { Child, Observation, SchoolClass } from '../src/lib/types';

/**
 * G2 历史归属与学期底座自检（R2）。
 *
 * 资源安全：
 * - 只用自己创建的一次性本地容器（唯一名/库/标签），清理只按核实过的容器 ID；
 * - Docker stdout/stderr 分开解析，容器 ID 只从 stdout 严格提取，兼容首次拉取镜像的 stderr 进度；
 * - 身份与空库校验先于任何 DDL/写入；失败（含注入故障）时结束阻塞事务→有界等待异步任务→
 *   关池→关连接→删容器，步骤彼此独立，删除结果必须验证；残留资源会报告并使退出码非零；
 * - teardown 之后先验证旧固定名反例容器仍存在，再删除自己创建的反例容器；
 * - 外部测试 URL 模式已移除，哨兵变量会被忽略；Docker 不可用不回退任何未知数据库。
 *
 * 业务边界：观察快照前提在共同保存边界用短事务复核（两种来源、双向交错）、
 * 缺失/非法学段不生成快照、班级历史保护（含双连接竞争）、学期配置副本与校验、
 * 客户端严格解析、旧记录 NULL、坏 guide_evidence 透传、三件套不变、上海日期口径。
 * 故障注入模式：--fault=init|begin|insert|race-assert（子进程运行，由本脚本成功路径拉起）。
 * 不调用真实模型；不连接 .env 或托管库。
 */

const TEACHER_PASSCODE_KEY = 'TEACHER_PASSCODE';
const LEGACY_CONTAINER_NAME = 'cga-history-check';
const FAULT_MODE =
  process.argv.find((arg) => arg.startsWith('--fault='))?.split('=')[1] ?? null;

/** 本轮唯一标记：容器名、库名、标签共用；只影响本轮创建的资源 */
const RUN_ID = `${process.pid.toString(36)}${Date.now().toString(36)}`.toLowerCase();
const CONTAINER_NAME = `cga-hist-${RUN_ID}`;
const DB_NAME = `cga_history_${RUN_ID}`;
const CONTAINER_LABEL = `cga-history-check=${RUN_ID}`;
const SENTINEL_LABEL = `cga-r2-sentinel=${RUN_ID}`;

interface ApiBody {
  message?: string;
  error?: string;
  reason?: string;
  status?: string;
  class?: SchoolClass | null;
  candidates?: unknown[];
  history?: { enrollment_count: number; observation_count: number };
  observation?: Observation;
  child?: Child;
}

interface DockerResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface CleanupResult {
  ok: boolean;
  detail: string;
}

const cleanupIssues: string[] = [];

function noteCleanupIssue(label: string, detail: string): void {
  cleanupIssues.push(`${label}: ${detail}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Docker stdout/stderr 严格分开：ID 只从 stdout 解析，进度/错误留在 stderr */
function docker(args: string[]): DockerResult {
  const res = spawnSync('docker', args, { encoding: 'utf8' });
  return {
    status: res.status ?? 1,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
  };
}

function parseContainerIdFromStdout(stdout: string): string | null {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  return /^[0-9a-f]{64}$/i.test(last) ? last : null;
}

function containerIdOf(idOrName: string): string | null {
  const res = docker(['inspect', '--format', '{{.Id}}', idOrName]);
  return res.status === 0 && res.stdout ? res.stdout.split('\n')[0].trim() : null;
}

function listContainersByLabel(label: string): string[] {
  const res = docker(['ps', '-a', '--filter', `label=${label}`, '--format', '{{.ID}}']);
  return res.status === 0 && res.stdout
    ? res.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    : [];
}

function listContainersByName(name: string): string[] {
  const res = docker(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}']);
  return res.status === 0 && res.stdout
    ? res.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    : [];
}

/** 只按核实过的容器 ID 删除，并验证删除结果；失败返回 detail，不静默忽略 */
function removeContainerById(containerId: string | null): CleanupResult {
  if (!containerId) return { ok: true, detail: '' };
  const res = docker(['rm', '-f', containerId]);
  if (res.status === 0) return { ok: true, detail: '' };
  if (!containerIdOf(containerId)) return { ok: true, detail: '' };
  return {
    ok: false,
    detail: `容器 ${containerId.slice(0, 12)} 删除失败：${res.stderr || res.stdout || `exit=${res.status}`}`,
  };
}

/** 反例容器：占用历史固定名称，验证本轮清理不会按名称误删 */
function ensureLegacyNameDecoy(): { id: string | null; created: boolean } {
  const existing = containerIdOf(LEGACY_CONTAINER_NAME);
  if (existing) return { id: existing, created: false };
  const run = docker([
    'run', '-d',
    '--name', LEGACY_CONTAINER_NAME,
    '--label', `cga-decoy=${RUN_ID}`,
    'postgres:16-alpine',
    'true',
  ]);
  const id = parseContainerIdFromStdout(run.stdout);
  if (run.status !== 0 || !id) {
    throw new Error(`无法创建资源反例容器：${run.stderr || run.stdout}`);
  }
  return { id, created: true };
}

/**
 * 启动一次性本地 Postgres。身份/空库校验通过前不执行任何 DDL 或写入；
 * 启动、连接、校验失败都按 ID 释放本轮容器。
 */
async function startTestDatabase(): Promise<{
  url: string;
  containerId: string;
  teardown: () => CleanupResult;
}> {
  const probe = docker(['version']);
  if (probe.status !== 0) {
    throw new Error(
      '未检测到可用的 Docker：G2 自检只使用一次性本地容器，不连接 .env 或任何未知数据库'
    );
  }

  const run = docker([
    'run', '-d',
    '--name', CONTAINER_NAME,
    '--label', CONTAINER_LABEL,
    '-e', 'POSTGRES_PASSWORD=postgres',
    '-e', `POSTGRES_DB=${DB_NAME}`,
    '-e', 'TZ=UTC',
    '-p', '127.0.0.1::5432',
    'postgres:16-alpine',
  ]);
  const containerId = parseContainerIdFromStdout(run.stdout);
  if (run.status !== 0 || !containerId) {
    throw new Error(
      `启动一次性测试数据库失败：${run.stderr || run.stdout || `exit=${run.status}`}`
    );
  }
  const teardown = () => removeContainerById(containerId);

  try {
    const inspected = containerIdOf(containerId);
    if (!inspected || inspected !== containerId) {
      throw new Error('无法核实本轮容器身份：docker run stdout 与 inspect 不一致');
    }
    const label = docker([
      'inspect', '--format', '{{index .Config.Labels "cga-history-check"}}', containerId,
    ]).stdout;
    if (label !== RUN_ID) throw new Error('容器标签与本轮运行标记不一致，拒绝继续');

    const mapped = docker(['port', containerId, '5432/tcp']).stdout.split('\n')[0] ?? '';
    if (!mapped.startsWith('127.0.0.1:')) {
      throw new Error('端口映射不在本机回环地址上，拒绝连接');
    }
    const hostPort = mapped.split(':').pop()?.trim();
    if (!hostPort) throw new Error('无法读取一次性测试数据库端口');
    const url = `postgresql://postgres:postgres@127.0.0.1:${hostPort}/${DB_NAME}`;

    const deadline = Date.now() + 60_000;
    for (;;) {
      const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
      try {
        await client.connect();
        await client.end();
        break;
      } catch {
        try {
          await client.end();
        } catch {
          // 未建立连接时 end 可能抛错，忽略后继续重试
        }
        if (Date.now() > deadline) throw new Error('一次性测试数据库启动超时');
        await sleep(500);
      }
    }

    const verifier = new Client({ connectionString: url });
    await verifier.connect();
    try {
      const identity = await verifier.query<{ db: string; usr: string; port: number; tz: string }>(
        "SELECT current_database() AS db, current_user AS usr, inet_server_port() AS port, current_setting('TimeZone') AS tz"
      );
      if (identity.rows[0]?.db !== DB_NAME) {
        throw new Error('目标库身份不符：current_database 与本轮库名不一致');
      }
      if (identity.rows[0]?.usr !== 'postgres') {
        throw new Error('目标库身份不符：当前用户不是本轮容器默认用户');
      }
      if (identity.rows[0]?.port !== 5432) {
        throw new Error('目标端口上不是预期的 PostgreSQL 服务');
      }
      if (identity.rows[0]?.tz !== 'UTC') {
        throw new Error('测试库时区不是 UTC，无法验证上海跨日反例');
      }
      const existing = await verifier.query<{ rel: string | null }>(
        `SELECT to_regclass('public.observations') AS rel`
      );
      if (existing.rows[0]?.rel !== null) {
        throw new Error('目标库不是全新空库（已存在 observations），拒绝执行初始化');
      }
    } finally {
      await verifier.end();
    }

    return { url, containerId, teardown };
  } catch (error) {
    const removal = teardown();
    if (!removal.ok) noteCleanupIssue('startup-container', removal.detail);
    throw error;
  }
}

async function applySql(client: Client, file: string): Promise<void> {
  await client.query(readFileSync(new URL(`../scripts/${file}`, import.meta.url), 'utf8'));
}

/** 演示观察三件套快照：迁移与写入前后必须完全一致 */
async function snapshotCore() {
  return query<{
    id: string;
    raw_text: string;
    ai_draft: unknown;
    confirmed_content: unknown;
    agent_context: unknown;
  }>(
    `SELECT id, raw_text, ai_draft, confirmed_content, agent_context
       FROM observations WHERE is_demo ORDER BY id`
  );
}

function apiRequest(
  path: string,
  init: { method: string; body?: unknown; cookie?: string }
): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.cookie) headers.cookie = init.cookie;
  return new NextRequest(`http://localhost${path}`, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function insertClass(input: {
  id: string;
  name: string;
  stage: string;
  school_year: string;
}): Promise<void> {
  await query(
    `INSERT INTO classes (id, name, stage, school_year, is_active, is_demo)
     VALUES ($1, $2, $3, $4, true, false)`,
    [input.id, input.name, input.stage, input.school_year]
  );
}

async function insertChild(id: string, name: string): Promise<void> {
  await query(
    `INSERT INTO children (id, name, gender, birth_date, class_name)
     VALUES ($1, $2, '女', '2021-01-01', '待核对班')`,
    [id, name]
  );
}

async function insertEnrollment(input: {
  id: string;
  child_id: string;
  class_id: string;
  start_date: string;
  end_date: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO child_class_enrollments (id, child_id, class_id, start_date, end_date)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.id, input.child_id, input.class_id, input.start_date, input.end_date]
  );
}

const ID = {
  classSmall: 'a0000000-0000-4000-8000-000000000001',
  classMiddle: 'a0000000-0000-4000-8000-000000000002',
  classOverlapA: 'a0000000-0000-4000-8000-000000000003',
  classOverlapB: 'a0000000-0000-4000-8000-000000000004',
  classFresh: 'a0000000-0000-4000-8000-000000000005',
  classTransferFrom: 'a0000000-0000-4000-8000-000000000006',
  classTransferTo: 'a0000000-0000-4000-8000-000000000007',
  classEnrollmentOnly: 'a0000000-0000-4000-8000-000000000008',
  classObservationOnly: 'a0000000-0000-4000-8000-000000000009',
  classRace: 'a0000000-0000-4000-8000-000000000010',
  classBrokenRecord: 'a0000000-0000-4000-8000-000000000011',
  classConflict: 'a0000000-0000-4000-8000-000000000012',
  classEnrollConflict: 'a0000000-0000-4000-8000-000000000013',
  classBackdatedFrom: 'a0000000-0000-4000-8000-000000000014',
  classBackdatedTo: 'a0000000-0000-4000-8000-000000000015',
  classWindow: 'a0000000-0000-4000-8000-000000000016',
  classDateCheck: 'a0000000-0000-4000-8000-000000000017',
  childBackfill: 'b0000000-0000-4000-8000-000000000001',
  childOverlap: 'b0000000-0000-4000-8000-000000000002',
  childBroken: 'b0000000-0000-4000-8000-000000000003',
  childTransfer: 'b0000000-0000-4000-8000-000000000004',
  childEnrollmentOnly: 'b0000000-0000-4000-8000-000000000005',
  childObservationOnly: 'b0000000-0000-4000-8000-000000000006',
  childRace: 'b0000000-0000-4000-8000-000000000007',
  childBrokenRecord: 'b0000000-0000-4000-8000-000000000008',
  childConflict: 'b0000000-0000-4000-8000-000000000009',
  childEnrollConflict: 'b0000000-0000-4000-8000-000000000010',
  childBackdated: 'b0000000-0000-4000-8000-000000000011',
  childWindow: 'b0000000-0000-4000-8000-000000000012',
  enrollBackfillA: 'e0000000-0000-4000-8000-000000000001',
  enrollBackfillB: 'e0000000-0000-4000-8000-000000000002',
  enrollOverlapA: 'e0000000-0000-4000-8000-000000000003',
  enrollOverlapB: 'e0000000-0000-4000-8000-000000000004',
  enrollBroken: 'e0000000-0000-4000-8000-000000000005',
  enrollTransferFrom: 'e0000000-0000-4000-8000-000000000006',
  enrollEnrollmentOnly: 'e0000000-0000-4000-8000-000000000007',
  enrollRace: 'e0000000-0000-4000-8000-000000000008',
  enrollBrokenRecord: 'e0000000-0000-4000-8000-000000000009',
  enrollEnrollConflict: 'e0000000-0000-4000-8000-000000000010',
  enrollBackdated: 'e0000000-0000-4000-8000-000000000011',
} as const;

function checkDateSemantics(): void {
  // 上海跨日、数据库采用 UTC 的反例：UTC 仍是 10-03，上海已是 10-04
  assert.equal(isoDateInShanghai(new Date('2026-10-03T15:59:00Z')), '2026-10-03');
  assert.equal(isoDateInShanghai(new Date('2026-10-03T16:00:00Z')), '2026-10-04');
  assert.equal(new Date('2026-10-03T16:00:00Z').toISOString().slice(0, 10), '2026-10-03');
  // 首次分班不得再用数据库 CURRENT_DATE（注释除外）
  const queriesSource = readFileSync(
    new URL('../src/lib/queries.ts', import.meta.url),
    'utf8'
  ).replace(/\/\/[^\n]*/g, '');
  assert.ok(!queriesSource.includes('CURRENT_DATE'), 'createChild 不得使用 CURRENT_DATE');
}

function checkSemesterBoundary(): void {
  const semesters = listSemesters();
  assert.ok(semesters.length >= 6, '学期配置应覆盖多个学年');
  assert.equal(new Set(semesters.map((s) => s.id)).size, semesters.length, '学期 id 必须唯一');
  for (const period of semesters) {
    assert.ok(period.start_date <= period.end_date, `${period.id} 起止日期顺序错误`);
    assert.ok(
      /^\d{4}-\d{2}-\d{2}$/.test(period.start_date) && /^\d{4}-\d{2}-\d{2}$/.test(period.end_date),
      `${period.id} 日期格式错误`
    );
    assert.ok(!period.label.includes('项目演示校历'), '用户可见 label 不应携带演示字样');
  }
  assert.ok(SEMESTER_CALENDAR_NOTE.includes('不是全国统一学期'), '配置性质说明必须保留');
  const configSource = readFileSync(
    new URL('../src/lib/semester/config.ts', import.meta.url),
    'utf8'
  );
  assert.ok(configSource.includes('不是全国统一学期'), '配置源注释须注明不是全国统一学期');

  // 配置不可变 + 查询返回副本：调用方无法污染后续查询
  assert.ok(Object.isFrozen(CONFIGURED_SEMESTERS), '配置数组必须冻结');
  assert.ok(Object.isFrozen(CONFIGURED_SEMESTERS[0]), '配置条目必须冻结');
  const first = listSemesters()[0];
  const labelBefore = first.label;
  first.label = '被污染';
  first.start_date = '1900-01-01';
  assert.equal(listSemesters()[0].label, labelBefore, '修改 listSemesters 返回值不得影响配置');
  const gotSemester = getSemester('2026-2027-1');
  assert.ok(gotSemester);
  gotSemester.end_date = '1900-01-01';
  assert.equal(getSemester('2026-2027-1')?.end_date, '2027-01-29', '修改 getSemester 返回值不得影响配置');
  const currentSemester = getCurrentSemester('2026-10-03');
  assert.ok(currentSemester);
  currentSemester.id = '污染';
  assert.equal(getCurrentSemester('2026-10-03')?.id, '2026-2027-1');

  // 配置校验：非法日期 / 起止倒置 / 重复 id / 重叠 / term
  assert.deepEqual(findSemesterConfigProblems(CONFIGURED_SEMESTERS), [], '内置配置必须通过校验');
  const base = {
    id: 'x-1',
    school_year: '2030-2031',
    term: 1 as const,
    label: 'x',
    start_date: '2030-09-01',
    end_date: '2031-01-15',
  };
  assert.ok(findSemesterConfigProblems([{ ...base, start_date: '2031-02-30' }]).length > 0);
  assert.ok(findSemesterConfigProblems([{ ...base, end_date: '2030-08-01' }]).length > 0);
  assert.ok(findSemesterConfigProblems([base, { ...base }]).some((p) => p.includes('重复')));
  assert.ok(
    findSemesterConfigProblems([
      base,
      { ...base, id: 'x-2', start_date: '2030-12-01', end_date: '2031-03-01' },
    ]).some((p) => p.includes('重叠'))
  );
  assert.ok(
    findSemesterConfigProblems([{ ...base, term: 3 as unknown as 1 }]).some((p) => p.includes('term'))
  );

  // 首尾含端点、跨年、当前学期（语义与 R1 一致）
  assert.equal(getCurrentSemester('2026-09-01')?.id, '2026-2027-1', '学期首日必须覆盖');
  assert.equal(getCurrentSemester('2027-01-29')?.id, '2026-2027-1', '学期末日必须覆盖');
  assert.equal(getCurrentSemester('2027-01-30'), null, '学期结束次日不应落入学期');
  assert.equal(getCurrentSemester('2026-12-31')?.id, '2026-2027-1', '跨年日期属于本学期');
  assert.equal(getCurrentSemester('2024-08-15'), null, '配置未覆盖的日期返回 null');

  const bySemester = resolveEvidenceScope({ semester_id: '2025-2026-2' });
  assert.ok(bySemester.ok);
  assert.deepEqual(bySemester.scope, {
    kind: 'semester',
    semester_id: '2025-2026-2',
    label: getSemester('2025-2026-2')?.label,
    start_date: '2026-02-23',
    end_date: '2026-07-10',
    filter_field: 'observed_at',
  });
  const priority = resolveEvidenceScope({
    semester_id: '2026-2027-1',
    from: 'not-a-date',
    to: 'also-bad',
  });
  assert.ok(priority.ok);
  assert.equal(priority.scope.semester_id, '2026-2027-1');

  const leap = resolveEvidenceScope({ from: '2024-02-29', to: '2024-03-01' });
  assert.ok(leap.ok);
  assert.deepEqual([leap.scope.start_date, leap.scope.end_date], ['2024-02-29', '2024-03-01']);
  for (const bad of [
    { from: '2025-02-29', to: '2025-03-01' },
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-01-01' },
    { to: '2026-01-01' },
    { from: '2026-05-01', to: '2026-04-01' },
  ]) {
    const res = resolveEvidenceScope(bad);
    assert.equal(res.ok, false, `非法范围应被拒绝：${JSON.stringify(bad)}`);
    if (!res.ok) assert.equal(res.error, 'invalid_request');
  }
  const allHistory = resolveEvidenceScope({ scope: 'all_history' });
  assert.ok(allHistory.ok);
  assert.deepEqual(
    [allHistory.scope.kind, allHistory.scope.start_date, allHistory.scope.end_date],
    ['all_history', null, null]
  );
  const badScope = resolveEvidenceScope({ scope: 'last_year' });
  assert.equal(badScope.ok, false);
  const bareCustom = resolveEvidenceScope({ scope: 'custom_range' });
  assert.equal(bareCustom.ok, false);
  const current = resolveEvidenceScope({}, { today: '2026-10-03' });
  assert.ok(current.ok);
  assert.equal(current.scope.semester_id, '2026-2027-1');
  const missing = resolveEvidenceScope({}, { semesters: [], today: '2026-10-03' });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error, 'semester_config_missing');
  const missingToday = resolveEvidenceScope({}, { today: '2020-01-01' });
  assert.equal(missingToday.ok, false);
  if (!missingToday.ok) assert.equal(missingToday.error, 'semester_config_missing');
}

async function checkClientParsing(): Promise<void> {
  const invalidJson = parseClassContextResponse(200, 'not-json');
  assert.equal(invalidJson.ok, false);
  if (!invalidJson.ok) assert.ok(invalidJson.message.includes('无法解析'));

  for (const body of [
    '{}',
    JSON.stringify({ status: 'resolved' }),
    JSON.stringify({
      status: 'resolved',
      class: { id: '', name: '班', stage: 'small', school_year: '2026-2027' },
    }),
    JSON.stringify({
      status: 'resolved',
      class: { id: 'c1', name: '班', stage: 'infant', school_year: '2026-2027' },
    }),
    JSON.stringify({
      status: 'resolved',
      class: { id: 'c1', name: '', stage: 'small', school_year: '2026-2027' },
    }),
    JSON.stringify({ status: 'needs_confirmation', reason: 'bogus' }),
    JSON.stringify({ status: 'unknown' }),
  ]) {
    assert.equal(parseClassContextResponse(200, body).ok, false, `非法响应必须拒绝：${body}`);
  }

  const resolved = parseClassContextResponse(
    200,
    JSON.stringify({
      status: 'resolved',
      class: { id: 'c1', name: '真实班', stage: 'middle', school_year: '2026-2027' },
    })
  );
  assert.ok(resolved.ok && resolved.state.status === 'resolved');
  if (resolved.ok && resolved.state.status === 'resolved') {
    assert.equal(resolved.state.class.stage, 'middle');
  }

  const confirm = parseClassContextResponse(
    200,
    JSON.stringify({ status: 'needs_confirmation', reason: 'unreliable_class_record' })
  );
  assert.ok(confirm.ok && confirm.state.status === 'needs_confirmation');
  if (confirm.ok && confirm.state.status === 'needs_confirmation') {
    assert.ok(confirm.state.message.length > 0, '缺少服务端文案时必须使用回退文案');
  }

  const httpError = parseClassContextResponse(500, JSON.stringify({ message: '服务暂不可用' }));
  assert.equal(httpError.ok, false);
  if (!httpError.ok) assert.equal(httpError.message, '服务暂不可用');
  const bareError = parseClassContextResponse(503, '<html>bad gateway</html>');
  assert.equal(bareError.ok, false);
  if (!bareError.ok) assert.ok(bareError.message.includes('无法解析'));

  let requestedUrl = '';
  const okFetch = (async (url: string | URL | Request) => {
    requestedUrl = String(url);
    return {
      status: 200,
      text: async () =>
        JSON.stringify({ status: 'needs_confirmation', reason: 'no_attribution', message: '请选择班级' }),
    } as unknown as Response;
  }) as typeof fetch;
  const state = await fetchClassContextState({
    childId: ID.childBackfill,
    observedAt: '2030-09-15',
    signal: new AbortController().signal,
    fetchImpl: okFetch,
  });
  assert.equal(state.status, 'needs_confirmation');
  assert.ok(requestedUrl.includes(encodeURIComponent('2030-09-15')));
  assert.ok(!requestedUrl.includes('undefined'));

  const invalidFetch = (async () =>
    ({ status: 200, text: async () => 'not-json' }) as unknown as Response) as typeof fetch;
  await assert.rejects(
    fetchClassContextState({
      childId: ID.childBackfill,
      observedAt: '2030-09-15',
      signal: new AbortController().signal,
      fetchImpl: invalidFetch,
    }),
    /无法解析/
  );

  const abortFetch = (async () => {
    throw new DOMException('aborted', 'AbortError');
  }) as typeof fetch;
  await assert.rejects(
    fetchClassContextState({
      childId: ID.childBackfill,
      observedAt: '2030-09-15',
      signal: new AbortController().signal,
      fetchImpl: abortFetch,
    }),
    (error: unknown) => isAbortError(error)
  );

  assert.equal(
    parseReliableClass({ id: 'c1', name: '班', stage: '', school_year: '2026-2027' }),
    null
  );
  assert.equal(
    parseReliableClass({ id: 'c1', name: '班', stage: 'infant', school_year: '2026-2027' }),
    null
  );
  assert.equal(parseReliableClass({ id: 'c1', name: '班', school_year: '2026-2027' }), null);
  assert.equal(
    parseReliableClass({ id: 'c1', name: '', stage: 'small', school_year: '2026-2027' }),
    null
  );
  const reliable = parseReliableClass({
    id: 'c1',
    name: '真实班',
    stage: 'large',
    school_year: '2026-2027',
    is_active: true,
  });
  assert.ok(reliable && reliable.stage === 'large');
}

function checkMigrationAndSchema(): void {
  const migrationSql = readFileSync(
    new URL('../scripts/upgrade-guide-evidence-v1.sql', import.meta.url),
    'utf8'
  );
  const migrationCode = migrationSql.replace(/--[^\n]*/g, '');
  assert.ok(migrationCode.includes('ADD COLUMN IF NOT EXISTS class_context_snapshot jsonb'));
  assert.ok(migrationCode.includes('ADD COLUMN IF NOT EXISTS guide_evidence jsonb'));
  assert.ok(!/UPDATE\s+observations/i.test(migrationCode), '迁移不得回填/改写观察');
  assert.ok(!/DROP\s+(TABLE|COLUMN)/i.test(migrationCode));
  assert.ok(!migrationCode.includes('legacy_import'), '迁移不得伪造 legacy_import 历史');
  const initSql = readFileSync(
    new URL('../scripts/initialize-demo-db.sql', import.meta.url),
    'utf8'
  );
  assert.ok(initSql.includes('class_context_snapshot jsonb'));
  assert.ok(initSql.includes('guide_evidence jsonb'));
  const schemaSource = readFileSync(
    new URL('../src/storage/database/shared/schema.ts', import.meta.url),
    'utf8'
  );
  assert.ok(schemaSource.includes('class_context_snapshot: jsonb('));
  assert.ok(schemaSource.includes('guide_evidence: jsonb('));
  const scriptSource = readFileSync(new URL(import.meta.url), 'utf8');
  const forbiddenExternalAccess = ["process", "env", "HISTORY_TEST_DATABASE_URL"].join(".");
  assert.ok(
    !scriptSource.includes(forbiddenExternalAccess) &&
      !/connectionString:\s*external/.test(scriptSource),
    '已移除外部测试 URL 模式，不允许连接未知数据库'
  );
}

/** 在成功路径拉起故障注入子进程，验证失败退出 + 资源清理 + 既有资源不受影响 */
async function runFaultChildren(
  legacyPreExistingId: string | null,
  countPassed: () => void
): Promise<void> {
  const tsxCli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
  const scriptPath = fileURLToPath(new URL('./check-history-semester.ts', import.meta.url));
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const sentinelName = `cga-r2-sentinel-${RUN_ID}`;
  const sentinelRun = docker([
    'run', '-d',
    '--name', sentinelName,
    '--label', SENTINEL_LABEL,
    'postgres:16-alpine',
    'true',
  ]);
  const sentinelId = parseContainerIdFromStdout(sentinelRun.stdout);
  if (sentinelRun.status !== 0 || !sentinelId) {
    throw new Error(`无法创建既有资源哨兵：${sentinelRun.stderr || sentinelRun.stdout}`);
  }

  try {
    for (const mode of ['init', 'begin', 'insert', 'race-assert']) {
      const child = spawnSync(
        process.execPath,
        [tsxCli, scriptPath, `--fault=${mode}`],
        { cwd: repoRoot, encoding: 'utf8', timeout: 180_000 }
      );
      const output = `${child.stdout ?? ''}\n${child.stderr ?? ''}`;
      if (child.error) {
        throw new Error(`故障注入 ${mode} 子进程异常：${child.error.message}`);
      }
      if (child.status === 0) {
        throw new Error(`故障注入 ${mode} 应以非零退出，实际 0：${output.slice(-400)}`);
      }
      if (!output.includes('注入故障')) {
        throw new Error(`故障注入 ${mode} 未按预期失败：${output.slice(-400)}`);
      }
      const runResidual = listContainersByLabel('cga-history-check');
      if (runResidual.length > 0) {
        throw new Error(`故障注入 ${mode} 后有残留容器：${runResidual.join(',')}`);
      }
      if (legacyPreExistingId) {
        if (!containerIdOf(legacyPreExistingId)) {
          throw new Error(`故障注入 ${mode} 误删了既有同名容器`);
        }
      } else {
        const decoyResidual = listContainersByName(LEGACY_CONTAINER_NAME);
        if (decoyResidual.length > 0) {
          throw new Error(`故障注入 ${mode} 后反例容器未清理：${decoyResidual.join(',')}`);
        }
      }
      if (!containerIdOf(sentinelId)) {
        throw new Error(`故障注入 ${mode} 误删了既有资源哨兵`);
      }
      countPassed();
    }
  } finally {
    const removal = removeContainerById(sentinelId);
    if (!removal.ok) noteCleanupIssue('sentinel', removal.detail);
  }
}

async function main(): Promise<void> {
  const previousPasscode = process.env[TEACHER_PASSCODE_KEY];
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const sentinelKey = 'HISTORY_TEST_DATABASE_URL';
  const previousSentinel = process.env[sentinelKey];
  process.env[sentinelKey] = 'postgresql://sentinel.invalid/never-touch';

  let failure: unknown = null;
  let passed = 0;
  let db: { url: string; containerId: string; teardown: () => CleanupResult } | null = null;
  let parentContainerId: string | null = null;
  let parentDbClosed = false;
  let setup: Client | null = null;
  const txClients: Client[] = [];
  const pendingTasks: Promise<unknown>[] = [];

  const legacyPreExistingId = containerIdOf(LEGACY_CONTAINER_NAME);
  const decoy = ensureLegacyNameDecoy();
  let decoyFinalized = false;

  function finalizeDecoy(): void {
    if (decoyFinalized) return;
    decoyFinalized = true;
    if (!decoy.id) return;
    // teardown 之后先验证反例容器仍存在，再删除自己创建的那一个
    if (!containerIdOf(decoy.id)) {
      noteCleanupIssue('decoy', '反例容器在本轮 teardown 后丢失（清理误伤）');
      return;
    }
    const removal = removeContainerById(decoy.id);
    if (!removal.ok) noteCleanupIssue('decoy-remove', removal.detail);
  }

  async function openTxClient(): Promise<Client> {
    const client = new Client({ connectionString: db!.url });
    await client.connect();
    txClients.push(client);
    return client;
  }

  async function closeTxClient(client: Client | null, label: string): Promise<void> {
    if (!client) return;
    const index = txClients.indexOf(client);
    if (index >= 0) txClients.splice(index, 1);
    try {
      await client.query('ROLLBACK');
    } catch {
      // 可能已 COMMIT 或连接已断开；不影响后续关闭
    }
    try {
      await client.end();
    } catch (error) {
      noteCleanupIssue(label, error instanceof Error ? error.message : String(error));
    }
  }

  function trackPending(task: Promise<unknown>): void {
    pendingTasks.push(
      task.then(
        () => undefined,
        () => undefined
      )
    );
  }

  async function settleWithin(task: Promise<unknown>, ms: number): Promise<'settled' | 'timeout'> {
    return Promise.race([
      task.then(() => 'settled' as const, () => 'settled' as const),
      sleep(ms).then(() => 'timeout' as const),
    ]);
  }

  /**
   * 本轮父进程资源清理（幂等）：先结束可能持锁的事务，再有界等待异步任务，
   * 再关连接池、关连接，最后按 ID 删容器并验证。步骤彼此独立，一个失败不跳过后续。
   */
  async function closeParentDatabase(): Promise<void> {
    if (parentDbClosed) return;
    parentDbClosed = true;
    for (const client of [...txClients]) {
      await closeTxClient(client, 'tx-client');
    }
    for (const [index, task] of pendingTasks.entries()) {
      const outcome = await settleWithin(task, 5000);
      if (outcome === 'timeout') noteCleanupIssue(`pending#${index}`, '未在有界时间内结束');
    }
    try {
      await globalThis.__pgPool?.end();
    } catch (error) {
      noteCleanupIssue('pg-pool', error instanceof Error ? error.message : String(error));
    }
    if (setup) {
      try {
        await setup.end();
      } catch (error) {
        noteCleanupIssue('setup-client', error instanceof Error ? error.message : String(error));
      }
      setup = null;
    }
    if (db) {
      const removal = db.teardown();
      if (!removal.ok) noteCleanupIssue('container', removal.detail);
      db = null;
    }
  }

  try {
    checkDateSemantics();
    passed += 1;
    checkSemesterBoundary();
    passed += 1;
    await checkClientParsing();
    passed += 1;
    checkMigrationAndSchema();
    passed += 1;

    db = await startTestDatabase();
    parentContainerId = db.containerId;
    process.env.DATABASE_URL = db.url;
    setup = new Client({ connectionString: db.url });
    await setup.connect();
    process.env[TEACHER_PASSCODE_KEY] = 'history-offline-passcode';
    if (FAULT_MODE === 'init') throw new Error('注入故障：初始化阶段失败');

    await applySql(setup, 'initialize-demo-db.sql');
    const coreBefore = await snapshotCore();
    await applySql(setup, 'upgrade-guide-evidence-v1.sql');
    await applySql(setup, 'upgrade-guide-evidence-v1.sql');
    assert.deepEqual(await snapshotCore(), coreBefore);

    const columns = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'observations'
          AND column_name IN ('class_context_snapshot', 'guide_evidence')
        ORDER BY column_name`
    );
    assert.deepEqual(columns.map((c) => c.column_name), ['class_context_snapshot', 'guide_evidence']);

    const nullSnapshots = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM observations WHERE class_context_snapshot IS NOT NULL`
    );
    assert.equal(nullSnapshots?.count, 0, '迁移后旧观察快照必须保持 NULL');
    const demoObservations = (await listObservations()).filter((o) => o.is_demo);
    assert.equal(demoObservations.length, 3);
    for (const obs of demoObservations) {
      assert.equal(obs.class_context_snapshot, null);
      assert.equal(obs.guide_evidence, null);
    }
    passed += 1;

    const corruptedTarget = demoObservations[0];
    await query(`UPDATE observations SET guide_evidence = '"not-an-object"'::jsonb WHERE id = $1`, [
      corruptedTarget.id,
    ]);
    const corrupted = await getObservation(corruptedTarget.id);
    assert.equal(corrupted?.guide_evidence, 'not-an-object');
    await query(
      `UPDATE observations SET guide_evidence = '{"revision":1,"links":[{"id":"fixture"}]}'::jsonb WHERE id = $1`,
      [corruptedTarget.id]
    );
    const structured = await getObservation(corruptedTarget.id);
    assert.deepEqual(structured?.guide_evidence, { revision: 1, links: [{ id: 'fixture' }] });
    await query(`UPDATE observations SET guide_evidence = NULL WHERE id = $1`, [corruptedTarget.id]);
    passed += 1;

    await insertClass({ id: ID.classSmall, name: '历史小班', stage: 'small', school_year: '2030-2031' });
    await insertClass({ id: ID.classMiddle, name: '历史中班', stage: 'middle', school_year: '2030-2031' });
    await insertClass({ id: ID.classOverlapA, name: '重叠一班', stage: 'small', school_year: '2031-2032' });
    await insertClass({ id: ID.classOverlapB, name: '重叠二班', stage: 'middle', school_year: '2031-2032' });
    await insertClass({ id: ID.classFresh, name: '未使用新班', stage: 'small', school_year: '2030-2031' });
    await insertClass({ id: ID.classTransferFrom, name: '转出前班', stage: 'small', school_year: '2031-2032' });
    await insertClass({ id: ID.classTransferTo, name: '转出后班', stage: 'middle', school_year: '2031-2032' });
    await insertClass({ id: ID.classEnrollmentOnly, name: '仅分班班', stage: 'large', school_year: '2033-2034' });
    await insertClass({ id: ID.classObservationOnly, name: '仅观察班', stage: 'small', school_year: '2033-2034' });
    await insertClass({ id: ID.classRace, name: '竞态班级', stage: 'small', school_year: '2035-2036' });
    await insertClass({ id: ID.classConflict, name: '前提冲突班', stage: 'small', school_year: '2037-2038' });
    await insertClass({ id: ID.classEnrollConflict, name: '归属改名班', stage: 'small', school_year: '2038-2039' });
    await insertClass({ id: ID.classBackdatedFrom, name: '补录转出班', stage: 'small', school_year: '2039-2040' });
    await insertClass({ id: ID.classBackdatedTo, name: '补录转入班', stage: 'middle', school_year: '2039-2040' });
    await insertClass({ id: ID.classWindow, name: '窗口班级', stage: 'small', school_year: '2040-2041' });
    await insertClass({ id: ID.classDateCheck, name: '日期口径班', stage: 'small', school_year: '2026-2027' });
    await insertChild(ID.childBackfill, '补录幼儿');
    await insertChild(ID.childOverlap, '重叠幼儿');
    await insertChild(ID.childBroken, '异常幼儿');
    await insertChild(ID.childTransfer, '转班幼儿');
    await insertChild(ID.childEnrollmentOnly, '仅分班幼儿');
    await insertChild(ID.childObservationOnly, '仅观察幼儿');
    await insertChild(ID.childRace, '竞态幼儿');
    await insertChild(ID.childConflict, '前提冲突幼儿');
    await insertChild(ID.childEnrollConflict, '归属改名幼儿');
    await insertChild(ID.childBackdated, '补录转班幼儿');
    await insertChild(ID.childWindow, '窗口幼儿');
    await insertEnrollment({
      id: ID.enrollBackfillA,
      child_id: ID.childBackfill,
      class_id: ID.classSmall,
      start_date: '2030-09-01',
      end_date: '2030-09-20',
    });
    await insertEnrollment({
      id: ID.enrollBackfillB,
      child_id: ID.childBackfill,
      class_id: ID.classMiddle,
      start_date: '2030-09-21',
      end_date: null,
    });
    await insertEnrollment({
      id: ID.enrollOverlapA,
      child_id: ID.childOverlap,
      class_id: ID.classOverlapA,
      start_date: '2031-09-01',
      end_date: '2031-09-20',
    });
    await insertEnrollment({
      id: ID.enrollOverlapB,
      child_id: ID.childOverlap,
      class_id: ID.classOverlapB,
      start_date: '2031-09-10',
      end_date: '2031-09-30',
    });
    await insertEnrollment({
      id: ID.enrollBroken,
      child_id: ID.childBroken,
      class_id: ID.classOverlapA,
      start_date: '2032-05-10',
      end_date: '2032-05-01',
    });
    await insertEnrollment({
      id: ID.enrollTransferFrom,
      child_id: ID.childTransfer,
      class_id: ID.classTransferFrom,
      start_date: '2031-01-05',
      end_date: null,
    });
    await insertEnrollment({
      id: ID.enrollEnrollmentOnly,
      child_id: ID.childEnrollmentOnly,
      class_id: ID.classEnrollmentOnly,
      start_date: '2033-01-01',
      end_date: null,
    });
    await insertEnrollment({
      id: ID.enrollEnrollConflict,
      child_id: ID.childEnrollConflict,
      class_id: ID.classEnrollConflict,
      start_date: '2038-01-01',
      end_date: null,
    });
    await insertEnrollment({
      id: ID.enrollBackdated,
      child_id: ID.childBackdated,
      class_id: ID.classBackdatedFrom,
      start_date: '2039-01-01',
      end_date: null,
    });
    await query(
      `INSERT INTO observations (child_id, class_id, observed_at, raw_text)
       VALUES ($1, $2, '2033-06-01', '仅观察班级的历史观察原文，用于验证观察引用同样受学段保护。')`,
      [ID.childObservationOnly, ID.classObservationOnly]
    );

    // 1) 补录转班前 / 转班当天 / 转班后 / 缺失归属
    const beforeTransfer = await resolveClassContextAt(ID.childBackfill, '2030-09-15');
    assert.ok(beforeTransfer.status === 'resolved');
    assert.equal(beforeTransfer.class.id, ID.classSmall);
    assert.equal(beforeTransfer.enrollment_id, ID.enrollBackfillA);
    const lastOldDay = await resolveClassContextAt(ID.childBackfill, '2030-09-20');
    assert.ok(lastOldDay.status === 'resolved');
    assert.equal(lastOldDay.class.id, ID.classSmall, '旧归属末日含首尾');
    const transferDay = await resolveClassContextAt(ID.childBackfill, '2030-09-21');
    assert.ok(transferDay.status === 'resolved');
    assert.equal(transferDay.class.id, ID.classMiddle, '转班当天归新班级');
    const beforeStart = await resolveClassContextAt(ID.childBackfill, '2030-08-31');
    assert.ok(beforeStart.status === 'needs_confirmation');
    assert.equal(beforeStart.reason, 'no_attribution');
    passed += 1;

    // 2) 重叠 / 异常历史都必须要求教师确认
    const overlap = await resolveClassContextAt(ID.childOverlap, '2031-09-15');
    assert.ok(overlap.status === 'needs_confirmation');
    assert.equal(overlap.reason, 'overlapping_attribution');
    assert.equal(overlap.candidates.length, 2);
    for (const candidate of overlap.candidates) {
      assert.ok(candidate.class_name.length > 0, '候选班级名称不能为空');
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(candidate.start_date), '候选归属日期必须为 YYYY-MM-DD');
    }
    const broken = await resolveClassContextAt(ID.childBroken, '2032-05-05');
    assert.ok(broken.status === 'needs_confirmation');
    assert.equal(broken.reason, 'unreliable_history');
    passed += 1;

    // 3) 路由 handler
    const { POST: createObservationHandler } = await import('@/app/api/observations/route');
    const { GET: classContextHandler } = await import(
      '@/app/api/children/[id]/class-context/route'
    );
    const { GET: getClassHandler, PATCH: patchClassHandler } = await import(
      '@/app/api/classes/[id]/route'
    );
    const { POST: createChildHandler } = await import('@/app/api/children/route');
    const cookie = `${TEACHER_COOKIE}=${createSessionToken().token}`;
    const postObservation = (body: unknown) =>
      createObservationHandler(apiRequest('/api/observations', { method: 'POST', body, cookie }));
    const getClassContext = (childId: string, observedAt: string) =>
      classContextHandler(
        apiRequest(
          `/api/children/${childId}/class-context?observed_at=${encodeURIComponent(observedAt)}`,
          { method: 'GET' }
        ),
        { params: Promise.resolve({ id: childId }) }
      );
    const patchClass = (id: string, body: unknown) =>
      patchClassHandler(
        apiRequest(`/api/classes/${id}`, { method: 'PATCH', body, cookie }),
        { params: Promise.resolve({ id }) }
      );

    const lookupRes = await getClassContext(ID.childBackfill, '2030-09-15');
    assert.equal(lookupRes.status, 200);
    const lookupBody = (await lookupRes.json()) as ApiBody;
    assert.equal(lookupBody.status, 'resolved');
    assert.equal(lookupBody.class?.name, '历史小班');
    assert.equal(lookupBody.class?.stage, 'small');
    assert.equal((await getClassContext(ID.childBackfill, '2025-02-29')).status, 400);
    assert.equal(
      (await getClassContext('c9c90000-0000-4000-8000-000000000000', '2030-09-15')).status,
      404
    );
    passed += 1;

    // 4) 创建观察：按发生时班级写快照（补录转班前）
    const backfillRes = await postObservation({
      child_id: ID.childBackfill,
      observed_at: '2030-09-15',
      context: '补录转班前',
      raw_text: '补录的观察原文：幼儿在旧班级的积木区搭了一座小桥，并请同伴一起推小车过桥。',
    });
    assert.equal(backfillRes.status, 201);
    const backfillObs = ((await backfillRes.json()) as ApiBody).observation as Observation;
    assert.equal(backfillObs.class_id, ID.classSmall);
    assert.equal(backfillObs.class_context_snapshot?.class_id, ID.classSmall);
    assert.equal(backfillObs.class_context_snapshot?.class_name, '历史小班');
    assert.equal(backfillObs.class_context_snapshot?.stage, 'small');
    assert.equal(backfillObs.class_context_snapshot?.school_year, '2030-2031');
    assert.equal(backfillObs.class_context_snapshot?.source, 'enrollment_lookup');
    assert.equal(backfillObs.class_context_snapshot?.enrollment_id, ID.enrollBackfillA);
    assert.ok(backfillObs.class_context_snapshot?.captured_at);
    assert.equal(backfillObs.guide_evidence, null, '新观察默认未关联 guide_evidence');
    assert.ok(backfillObs.raw_text.startsWith('补录的观察原文'));

    const transferDayRes = await postObservation({
      child_id: ID.childBackfill,
      observed_at: '2030-09-21',
      raw_text: '转班当天的观察原文：幼儿到新班级后主动和同伴打招呼，并找到放书包的位置。',
    });
    assert.equal(transferDayRes.status, 201);
    const transferDayObs = ((await transferDayRes.json()) as ApiBody).observation as Observation;
    assert.equal(transferDayObs.class_context_snapshot?.class_id, ID.classMiddle);
    assert.equal(transferDayObs.class_context_snapshot?.source, 'enrollment_lookup');
    passed += 1;

    // 5) 无效观察日期与非法输入被拒
    assert.equal(
      (await postObservation({
        child_id: ID.childBackfill,
        observed_at: '2030-02-30',
        raw_text: '非法日期的观察原文，长度足够但仍应被拒绝。',
      })).status,
      400
    );
    assert.equal(
      (await postObservation({
        child_id: ID.childBackfill,
        observed_at: '2030-09-15',
        raw_text: '短',
      })).status,
      400
    );
    passed += 1;

    // 6) 缺失/重叠归属：409 要求确认，不偷偷写默认班级；带确认后 teacher_confirmed
    const needsRes = await postObservation({
      child_id: ID.childOverlap,
      observed_at: '2031-09-15',
      raw_text: '重叠归属的观察原文：幼儿在活动区用积木和同伴合作搭了一条很长的火车轨道。',
    });
    assert.equal(needsRes.status, 409);
    const needsBody = (await needsRes.json()) as ApiBody;
    assert.equal(needsBody.error, 'class_context_confirmation_required');
    assert.equal(needsBody.reason, 'overlapping_attribution');
    assert.ok(needsBody.message);
    const notWritten = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM observations WHERE child_id = $1`,
      [ID.childOverlap]
    );
    assert.equal(notWritten?.count, 0, '未确认前不得写入观察');

    const confirmedRes = await postObservation({
      child_id: ID.childOverlap,
      observed_at: '2031-09-15',
      raw_text: '教师确认班级后的观察原文：幼儿在活动中主动邀请同伴一起收拾材料并分类摆放。',
      confirmed_class_id: ID.classOverlapB,
      class_context_snapshot: {
        class_id: ID.classOverlapB,
        class_name: '伪造班级名',
        stage: 'large',
        school_year: '2099-2100',
        captured_at: '2000-01-01T00:00:00.000Z',
        source: 'legacy_import',
      },
    });
    assert.equal(confirmedRes.status, 201);
    const confirmedObs = ((await confirmedRes.json()) as ApiBody).observation as Observation;
    assert.equal(confirmedObs.class_context_snapshot?.source, 'teacher_confirmed');
    assert.equal(confirmedObs.class_context_snapshot?.class_name, '重叠二班');
    assert.equal(confirmedObs.class_context_snapshot?.stage, 'middle');
    assert.equal(confirmedObs.class_context_snapshot?.school_year, '2031-2032');
    assert.ok(confirmedObs.class_context_snapshot?.confirmed_at);
    assert.equal(confirmedObs.class_context_snapshot?.enrollment_id, null);

    const missingClassRes = await postObservation({
      child_id: ID.childOverlap,
      observed_at: '2031-09-15',
      raw_text: '确认班级不存在时应当被拒绝，而不是接受任意标识写入快照。',
      confirmed_class_id: 'c9c90000-0000-4000-8000-000000000000',
    });
    assert.equal(missingClassRes.status, 400);
    const missingClassBody = (await missingClassRes.json()) as ApiBody;
    assert.equal(missingClassBody.error, 'class_context_unreliable');
    passed += 1;

    // 7) 转班 API 后：转出前后日期分别解析到对应班级
    const { POST: enrollHandler } = await import('@/app/api/classes/[id]/children/route');
    const transferRes = await enrollHandler(
      apiRequest(`/api/classes/${ID.classTransferTo}/children`, {
        method: 'POST',
        body: { child_id: ID.childTransfer, start_date: '2031-02-01' },
        cookie,
      }),
      { params: Promise.resolve({ id: ID.classTransferTo }) }
    );
    assert.equal(transferRes.status, 200);
    const dayBefore = await resolveClassContextAt(ID.childTransfer, '2031-01-31');
    assert.ok(dayBefore.status === 'resolved');
    assert.equal(dayBefore.class.id, ID.classTransferFrom);
    const onTransfer = await resolveClassContextAt(ID.childTransfer, '2031-02-01');
    assert.ok(onTransfer.status === 'resolved');
    assert.equal(onTransfer.class.id, ID.classTransferTo);
    passed += 1;

    // 8) 班级改名后快照不变（旧观察仍保留改名前的班级语境）
    const renameRes = await patchClass(ID.classSmall, { name: '历史小班（改名后）' });
    assert.equal(renameRes.status, 200);
    const renamedObs = await getObservation(backfillObs.id);
    assert.equal(renamedObs?.class_context_snapshot?.class_name, '历史小班');
    assert.equal(renamedObs?.class_context_snapshot?.stage, 'small');
    assert.equal(renamedObs?.class_context_snapshot?.school_year, '2030-2031');
    assert.equal(renamedObs?.observed_class?.name, '历史小班（改名后）', '实时班级跟随改名');
    assert.equal(renamedObs?.raw_text, backfillObs.raw_text);
    passed += 1;

    // 9) 已有历史的班级保护：禁止改学段/学年；改名与停用仍可用；未使用班级可改
    const stageChange = await patchClass(ID.classSmall, { stage: 'middle' });
    assert.equal(stageChange.status, 409);
    const stageBody = (await stageChange.json()) as ApiBody;
    assert.equal(stageBody.error, 'class_history_protected');
    assert.ok(stageBody.message?.includes('建立新学年'));
    const yearChange = await patchClass(ID.classSmall, { school_year: '2031-2032' });
    assert.equal(yearChange.status, 409);
    const stillSmall = await queryOne<{ stage: string; school_year: string }>(
      `SELECT stage, school_year FROM classes WHERE id = $1`,
      [ID.classSmall]
    );
    assert.deepEqual(stillSmall, { stage: 'small', school_year: '2030-2031' });
    const deactivate = await patchClass(ID.classSmall, { is_active: false });
    assert.equal(deactivate.status, 200);
    const enrollmentOnlyChange = await patchClass(ID.classEnrollmentOnly, { stage: 'middle' });
    assert.equal(enrollmentOnlyChange.status, 409, '只有分班历史也必须保护');
    const observationOnlyChange = await patchClass(ID.classObservationOnly, { stage: 'middle' });
    assert.equal(observationOnlyChange.status, 409, '只有观察引用也必须保护');
    const freshChange = await patchClass(ID.classFresh, { stage: 'middle', school_year: '2031-2032' });
    assert.equal(freshChange.status, 200, '无历史班级允许纠错修改');
    const freshDetail = await getClassHandler(
      apiRequest(`/api/classes/${ID.classFresh}`, { method: 'GET' }),
      { params: Promise.resolve({ id: ID.classFresh }) }
    );
    assert.equal(freshDetail.status, 200);
    assert.equal(((await freshDetail.json()) as ApiBody).history?.enrollment_count, 0);
    const smallDetail = await getClassHandler(
      apiRequest(`/api/classes/${ID.classSmall}`, { method: 'GET' }),
      { params: Promise.resolve({ id: ID.classSmall }) }
    );
    const smallHistory = ((await smallDetail.json()) as ApiBody).history;
    assert.ok((smallHistory?.enrollment_count ?? 0) >= 1);
    assert.ok((smallHistory?.observation_count ?? 0) >= 1);
    passed += 1;

    // 10) 受控双连接竞争：未提交的分班写入会阻塞学段修改，提交后必须拒绝，且班级未被改动
    const racer = await openTxClient();
    await racer.query('BEGIN');
    if (FAULT_MODE === 'begin') throw new Error('注入故障：BEGIN 后失败');
    await racer.query(
      `INSERT INTO child_class_enrollments (id, child_id, class_id, start_date, end_date)
       VALUES ($1, $2, $3, '2035-01-05', NULL)`,
      [ID.enrollRace, ID.childRace, ID.classRace]
    );
    if (FAULT_MODE === 'insert') throw new Error('注入故障：INSERT 后、COMMIT 前失败');
    const raceUpdate = updateClass(ID.classRace, { stage: 'middle' });
    trackPending(raceUpdate);
    const early = await Promise.race([
      raceUpdate.then(
        () => 'settled',
        () => 'settled'
      ),
      sleep(700).then(() => 'blocked'),
    ]);
    assert.equal(early, 'blocked', '学段修改必须等待未提交的分班写入，而不是先通过检查再更新');
    await racer.query('COMMIT');
    if (FAULT_MODE === 'race-assert') {
      throw new Error('注入故障：竞争断言失败（保留未等待的 updateClass）');
    }
    await assert.rejects(raceUpdate, (error: unknown) => error instanceof ClassHistoryProtectedError);
    await closeTxClient(racer, 'racer');
    const raceState = await queryOne<{ stage: string }>(
      `SELECT stage FROM classes WHERE id = $1`,
      [ID.classRace]
    );
    assert.equal(raceState?.stage, 'small', '竞争失败后不得留下学段修改');
    const raceEnrollment = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM child_class_enrollments WHERE class_id = $1`,
      [ID.classRace]
    );
    assert.equal(raceEnrollment?.count, 1);
    passed += 1;

    // 11) 已复现缺陷：教师确认前提读取后、保存前班级学段被合法修改（无历史），旧快照必须被拒
    const conflictPremiseClass = await getReliableClass(ID.classConflict);
    assert.ok(conflictPremiseClass);
    const staleSnapshot = buildTeacherConfirmedSnapshot(conflictPremiseClass);
    const changedClass = await updateClass(ID.classConflict, { stage: 'middle' });
    assert.equal(changedClass?.stage, 'middle', '无历史班级允许修改学段（复现前提）');
    await assert.rejects(
      createObservation({
        child_id: ID.childConflict,
        observed_at: '2037-03-01',
        context: null,
        raw_text: '前提冲突的观察原文：幼儿在活动中持续专注地完成拼图并主动帮助同伴。',
        is_demo: false,
        class_context_snapshot: staleSnapshot,
        premise: {
          class_id: conflictPremiseClass.id,
          class_name: conflictPremiseClass.name,
          stage: conflictPremiseClass.stage,
          school_year: conflictPremiseClass.school_year,
          enrollment_id: null,
          observed_at: '2037-03-01',
        },
      }),
      (error: unknown) => error instanceof ObservationContextConflictError
    );
    const conflictCount = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM observations WHERE child_id = $1`,
      [ID.childConflict]
    );
    assert.equal(conflictCount?.count, 0, '前提变化后不得落入旧快照');
    // 重新读取后可正常保存（服务端以新学段生成快照）
    const freshPremiseClass = await getReliableClass(ID.classConflict);
    assert.ok(freshPremiseClass && freshPremiseClass.stage === 'middle');
    const savedAfterConflict = await createObservation({
      child_id: ID.childConflict,
      observed_at: '2037-03-01',
      context: null,
      raw_text: '重新核对后的观察原文：幼儿在活动中持续专注地完成拼图并主动帮助同伴。',
      is_demo: false,
      class_context_snapshot: buildTeacherConfirmedSnapshot(freshPremiseClass),
      premise: {
        class_id: freshPremiseClass.id,
        class_name: freshPremiseClass.name,
        stage: freshPremiseClass.stage,
        school_year: freshPremiseClass.school_year,
        enrollment_id: null,
        observed_at: '2037-03-01',
      },
    });
    assert.equal(savedAfterConflict.class_context_snapshot?.stage, 'middle');
    passed += 1;

    // 12) 分班历史路径：解析后班级改名，旧快照必须被拒；重新解析后可保存
    const enrollConflictLookup = await resolveClassContextAt(ID.childEnrollConflict, '2038-03-01');
    assert.ok(enrollConflictLookup.status === 'resolved');
    const enrollStaleSnapshot = buildEnrollmentSnapshot(
      enrollConflictLookup.class,
      enrollConflictLookup.enrollment_id
    );
    const enrollRename = await updateClass(ID.classEnrollConflict, { name: '归属改名班（改名后）' });
    assert.equal(enrollRename?.name, '归属改名班（改名后）');
    await assert.rejects(
      createObservation({
        child_id: ID.childEnrollConflict,
        observed_at: '2038-03-01',
        context: null,
        raw_text: '归属改名冲突的观察原文：幼儿在角色区与同伴协商分配角色并完成表演。',
        is_demo: false,
        class_context_snapshot: enrollStaleSnapshot,
        premise: {
          class_id: enrollConflictLookup.class.id,
          class_name: enrollConflictLookup.class.name,
          stage: enrollConflictLookup.class.stage,
          school_year: enrollConflictLookup.class.school_year,
          enrollment_id: enrollConflictLookup.enrollment_id,
          observed_at: '2038-03-01',
        },
      }),
      (error: unknown) => error instanceof ObservationContextConflictError
    );
    const enrollConflictCount = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM observations WHERE child_id = $1`,
      [ID.childEnrollConflict]
    );
    assert.equal(enrollConflictCount?.count, 0);
    const enrollFreshLookup = await resolveClassContextAt(ID.childEnrollConflict, '2038-03-01');
    assert.ok(enrollFreshLookup.status === 'resolved');
    assert.equal(enrollFreshLookup.class.name, '归属改名班（改名后）');
    const enrollSaved = await createObservation({
      child_id: ID.childEnrollConflict,
      observed_at: '2038-03-01',
      context: null,
      raw_text: '重新解析后的观察原文：幼儿在角色区与同伴协商分配角色并完成表演。',
      is_demo: false,
      class_context_snapshot: buildEnrollmentSnapshot(
        enrollFreshLookup.class,
        enrollFreshLookup.enrollment_id
      ),
      premise: {
        class_id: enrollFreshLookup.class.id,
        class_name: enrollFreshLookup.class.name,
        stage: enrollFreshLookup.class.stage,
        school_year: enrollFreshLookup.class.school_year,
        enrollment_id: enrollFreshLookup.enrollment_id,
        observed_at: '2038-03-01',
      },
    });
    assert.equal(enrollSaved.class_context_snapshot?.class_name, '归属改名班（改名后）');
    passed += 1;

    // 13) 分班历史路径：解析后补录转班（归属区间变化），旧快照必须被拒；重新解析可保存
    const backdatedLookup = await resolveClassContextAt(ID.childBackdated, '2039-03-01');
    assert.ok(backdatedLookup.status === 'resolved');
    assert.equal(backdatedLookup.class.id, ID.classBackdatedFrom);
    const backdatedStale = buildEnrollmentSnapshot(
      backdatedLookup.class,
      backdatedLookup.enrollment_id
    );
    const backdatedTransfer = await enrollHandler(
      apiRequest(`/api/classes/${ID.classBackdatedTo}/children`, {
        method: 'POST',
        body: { child_id: ID.childBackdated, start_date: '2039-02-01' },
        cookie,
      }),
      { params: Promise.resolve({ id: ID.classBackdatedTo }) }
    );
    assert.equal(backdatedTransfer.status, 200);
    await assert.rejects(
      createObservation({
        child_id: ID.childBackdated,
        observed_at: '2039-03-01',
        context: null,
        raw_text: '补录转班冲突的观察原文：幼儿在新班级的阅读区安静翻阅图书并复述故事。',
        is_demo: false,
        class_context_snapshot: backdatedStale,
        premise: {
          class_id: backdatedLookup.class.id,
          class_name: backdatedLookup.class.name,
          stage: backdatedLookup.class.stage,
          school_year: backdatedLookup.class.school_year,
          enrollment_id: backdatedLookup.enrollment_id,
          observed_at: '2039-03-01',
        },
      }),
      (error: unknown) => error instanceof ObservationContextConflictError
    );
    const backdatedFresh = await resolveClassContextAt(ID.childBackdated, '2039-03-01');
    assert.ok(backdatedFresh.status === 'resolved');
    assert.equal(backdatedFresh.class.id, ID.classBackdatedTo, '补录转班后应解析到新班级');
    const backdatedSaved = await createObservation({
      child_id: ID.childBackdated,
      observed_at: '2039-03-01',
      context: null,
      raw_text: '重新解析后的观察原文：幼儿在新班级的阅读区安静翻阅图书并复述故事。',
      is_demo: false,
      class_context_snapshot: buildEnrollmentSnapshot(
        backdatedFresh.class,
        backdatedFresh.enrollment_id
      ),
      premise: {
        class_id: backdatedFresh.class.id,
        class_name: backdatedFresh.class.name,
        stage: backdatedFresh.class.stage,
        school_year: backdatedFresh.class.school_year,
        enrollment_id: backdatedFresh.enrollment_id,
        observed_at: '2039-03-01',
      },
    });
    assert.equal(backdatedSaved.class_context_snapshot?.class_id, ID.classBackdatedTo);
    passed += 1;

    // 14) 受控交错 B（并发版）：班级行被未提交的学段修改占用时，保存必须先等待再核验
    const windowPremise = await getReliableClass(ID.classWindow);
    assert.ok(windowPremise);
    const windowBlocker = await openTxClient();
    await windowBlocker.query('BEGIN');
    await windowBlocker.query(`UPDATE classes SET stage = 'middle' WHERE id = $1`, [
      ID.classWindow,
    ]);
    const windowSave = createObservation({
      child_id: ID.childWindow,
      observed_at: '2040-03-01',
      context: null,
      raw_text: '窗口交错的观察原文：幼儿在户外活动中连续拍球并数出拍球次数。',
      is_demo: false,
      class_context_snapshot: buildTeacherConfirmedSnapshot(windowPremise),
      premise: {
        class_id: windowPremise.id,
        class_name: windowPremise.name,
        stage: windowPremise.stage,
        school_year: windowPremise.school_year,
        enrollment_id: null,
        observed_at: '2040-03-01',
      },
    });
    trackPending(windowSave);
    const windowEarly = await Promise.race([
      windowSave.then(
        () => 'settled',
        () => 'settled'
      ),
      sleep(700).then(() => 'blocked'),
    ]);
    assert.equal(windowEarly, 'blocked', '保存必须先等班级行锁，而不是直接插入旧快照');
    await windowBlocker.query('COMMIT');
    await closeTxClient(windowBlocker, 'windowBlocker');
    await assert.rejects(windowSave, (error: unknown) => error instanceof ObservationContextConflictError);
    const windowCount = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM observations WHERE child_id = $1`,
      [ID.childWindow]
    );
    assert.equal(windowCount?.count, 0, '交错 B 不得成功落入旧快照');
    passed += 1;

    // 15) 缺失/非法学段：不得生成默认小班快照；教师确认也必须拒绝
    await query('ALTER TABLE classes DROP CONSTRAINT classes_stage_check');
    await insertClass({
      id: ID.classBrokenRecord,
      name: '资料损坏班',
      stage: '',
      school_year: '2034-2035',
    });
    await insertChild(ID.childBrokenRecord, '资料损坏幼儿');
    await insertEnrollment({
      id: ID.enrollBrokenRecord,
      child_id: ID.childBrokenRecord,
      class_id: ID.classBrokenRecord,
      start_date: '2034-01-05',
      end_date: null,
    });
    const brokenRecordLookup = await resolveClassContextAt(ID.childBrokenRecord, '2034-03-01');
    assert.ok(brokenRecordLookup.status === 'needs_confirmation');
    assert.equal(brokenRecordLookup.reason, 'unreliable_class_record');
    const brokenRecordRes = await postObservation({
      child_id: ID.childBrokenRecord,
      observed_at: '2034-03-01',
      raw_text: '资料损坏班级的观察原文：幼儿在活动中持续专注地完成拼图并主动帮助同伴。',
    });
    assert.equal(brokenRecordRes.status, 409);
    const brokenRecordBody = (await brokenRecordRes.json()) as ApiBody;
    assert.equal(brokenRecordBody.reason, 'unreliable_class_record');
    const brokenConfirmRes = await postObservation({
      child_id: ID.childBrokenRecord,
      observed_at: '2034-03-01',
      raw_text: '教师手动确认损坏班级时也必须被拒绝而不是写入小班快照。',
      confirmed_class_id: ID.classBrokenRecord,
    });
    assert.equal(brokenConfirmRes.status, 400);
    const brokenConfirmBody = (await brokenConfirmRes.json()) as ApiBody;
    assert.equal(brokenConfirmBody.error, 'class_context_unreliable');
    const brokenWritten = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM observations WHERE child_id = $1`,
      [ID.childBrokenRecord]
    );
    assert.equal(brokenWritten?.count, 0, '资料不可核实前不得写入任何观察');
    passed += 1;

    // 16) 建档首次分班使用上海日历日（数据库为 UTC 的反例环境）
    const dateChildRes = await createChildHandler(
      apiRequest('/api/children', {
        method: 'POST',
        body: {
          name: '上海日期幼儿',
          gender: '女',
          birth_date: '2022-01-01',
          class_id: ID.classDateCheck,
        },
        cookie,
      })
    );
    assert.equal(dateChildRes.status, 201);
    const dateChild = ((await dateChildRes.json()) as ApiBody).child as Child;
    const dateEnrollments = await listEnrollments(dateChild.id);
    assert.equal(dateEnrollments.length, 1);
    const shanghaiToday = isoDateInShanghai(new Date());
    assert.equal(
      dateEnrollments[0].start_date,
      shanghaiToday,
      '首次分班日期必须等于服务端上海日历日'
    );
    passed += 1;

    // 17) 快照数量与旧记录 NULL、三件套未变
    const snapshotCount = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM observations WHERE class_context_snapshot IS NOT NULL`
    );
    assert.equal(
      snapshotCount?.count,
      6,
      '快照数应为 6 条：补录/转班当天/教师确认/前提重核/归属改名重存/补录转班重存；被拒交错不落库'
    );
    const demoStillNull = await query<{ id: string }>(
      `SELECT id FROM observations
        WHERE is_demo AND class_context_snapshot IS NOT NULL`
    );
    assert.equal(demoStillNull.length, 0);
    assert.deepEqual(await snapshotCore(), coreBefore);
    passed += 1;

    // 18) 成功路径资源安全：反例容器在本轮容器 teardown 后仍存在（先验证，后清理）
    if (decoy.id) {
      assert.ok(containerIdOf(decoy.id), '反例容器被误删：清理必须只针对本轮容器 ID');
    } else {
      assert.ok(containerIdOf(LEGACY_CONTAINER_NAME), '已有同名容器必须保持不动');
    }
    passed += 1;

    // 19) 故障注入子进程（仅成功路径拉起；先完整关闭父进程数据库，再让子进程独占验证清理）
    if (!FAULT_MODE) {
      finalizeDecoy();
      await closeParentDatabase();
      await runFaultChildren(legacyPreExistingId, () => {
        passed += 1;
      });
    }

    console.log(
      JSON.stringify({
        passed,
        total: passed,
        database: 'disposable-local-postgres (identity-verified before DDL)',
        resource_safety: {
          run_id: RUN_ID,
          container: parentContainerId?.slice(0, 12) ?? '(cleaned)',
          cleanup: 'by-container-id-only',
          external_url_mode: 'removed',
          decoy_container_preserved: true,
          failure_paths: ['init', 'begin', 'insert', 'race-assert'],
        },
        simulated_responses: 'client parser covered offline; browser interception is separate',
      })
    );
  } catch (error) {
    failure = error;
  } finally {
    await closeParentDatabase();
    // teardown 之后再验证反例容器，然后清理自己创建的那一个
    finalizeDecoy();
    // 恢复环境变量
    if (previousPasscode === undefined) delete process.env[TEACHER_PASSCODE_KEY];
    else process.env[TEACHER_PASSCODE_KEY] = previousPasscode;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousSentinel === undefined) delete process.env[sentinelKey];
    else process.env[sentinelKey] = previousSentinel;
  }

  if (failure) {
    if (cleanupIssues.length > 0) {
      console.error(`清理问题：${cleanupIssues.join('；')}`);
    }
    throw failure;
  }
  if (cleanupIssues.length > 0) {
    throw new Error(`本轮资源清理失败（自有残留已列出）：${cleanupIssues.join('；')}`);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
