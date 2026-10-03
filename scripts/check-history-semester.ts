import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { NextRequest } from 'next/server';
import { Client } from 'pg';

import { TEACHER_COOKIE, createSessionToken } from '../src/lib/auth';
import { resolveClassContextAt } from '../src/lib/class-context';
import { getObservation, listObservations } from '../src/lib/queries';
import {
  getCurrentSemester,
  getSemester,
  listSemesters,
  resolveEvidenceScope,
} from '../src/lib/semester';
import { query, queryOne } from '../src/storage/database/pg-client';
import type { Observation, SchoolClass } from '../src/lib/types';

/**
 * G2 历史归属与学期底座自检：
 * - 离线：学期显式配置/范围解析/日期边界/迁移与初始化同构；
 * - 实库：一次性本地 Postgres（或 HISTORY_TEST_DATABASE_URL），验证迁移幂等、
 *   分班历史解析（补录转班前 / 转班当天 / 重叠 / 缺失 / 异常）、教师确认快照、
 *   班级改名后快照不变、已有历史班级的学段/学年保护、旧快照保持 NULL、
 *   损坏 guide_evidence 不被静默归为 NULL、三件套（raw_text / ai_draft / confirmed_content）不变。
 * 不连接 .env 托管库或线上库；不调用真实模型。
 */

const CONTAINER = 'cga-history-check';
const TEACHER_PASSCODE_KEY = 'TEACHER_PASSCODE';

interface ApiBody {
  message?: string;
  error?: string;
  reason?: string;
  status?: string;
  class?: SchoolClass | null;
  candidates?: unknown[];
  history?: { enrollment_count: number; observation_count: number };
  observation?: Observation;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function docker(args: string[]): { status: number; output: string } {
  const res = spawnSync('docker', args, { encoding: 'utf8' });
  return { status: res.status ?? 1, output: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() };
}

async function startTestDatabase(): Promise<{ url: string; teardown: () => void }> {
  const external = process.env.HISTORY_TEST_DATABASE_URL?.trim();
  if (external) return { url: external, teardown: () => undefined };

  const probe = docker(['version']);
  if (probe.status !== 0) {
    throw new Error(
      `未检测到可用的 Docker：历史自检需要一次性本地 Postgres，或设置 HISTORY_TEST_DATABASE_URL 指向隔离测试库（${probe.output}）`
    );
  }

  docker(['rm', '-f', CONTAINER]);
  const run = docker([
    'run', '-d', '--name', CONTAINER,
    '-e', 'POSTGRES_PASSWORD=postgres',
    '-e', 'POSTGRES_DB=cga_history',
    '-p', '127.0.0.1::5432',
    'postgres:16-alpine',
  ]);
  if (run.status !== 0) throw new Error(`启动测试数据库失败：${run.output}`);

  const mapped = docker(['port', CONTAINER, '5432/tcp']).output.split('\n')[0] ?? '';
  const hostPort = mapped.split(':').pop()?.trim();
  if (!hostPort) throw new Error(`无法读取测试数据库端口：${mapped}`);
  const url = `postgresql://postgres:postgres@127.0.0.1:${hostPort}/cga_history`;

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
      if (Date.now() > deadline) throw new Error('测试数据库启动超时');
      await sleep(500);
    }
  }

  return { url, teardown: () => docker(['rm', '-f', CONTAINER]) };
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
  childBackfill: 'b0000000-0000-4000-8000-000000000001',
  childOverlap: 'b0000000-0000-4000-8000-000000000002',
  childBroken: 'b0000000-0000-4000-8000-000000000003',
  childTransfer: 'b0000000-0000-4000-8000-000000000004',
  childEnrollmentOnly: 'b0000000-0000-4000-8000-000000000005',
  enrollBackfillA: 'e0000000-0000-4000-8000-000000000001',
  enrollBackfillB: 'e0000000-0000-4000-8000-000000000002',
  enrollOverlapA: 'e0000000-0000-4000-8000-000000000003',
  enrollOverlapB: 'e0000000-0000-4000-8000-000000000004',
  enrollBroken: 'e0000000-0000-4000-8000-000000000005',
  enrollTransferFrom: 'e0000000-0000-4000-8000-000000000006',
  enrollEnrollmentOnly: 'e0000000-0000-4000-8000-000000000007',
} as const;

async function main(): Promise<void> {
  let passed = 0;
  const previousPasscode = process.env[TEACHER_PASSCODE_KEY];

  try {
    // ————————————————————————— 离线：学期配置与范围解析 —————————————————————————
    const semesters = listSemesters();
    assert.ok(semesters.length >= 6, '学期配置应覆盖多个学年');
    assert.equal(new Set(semesters.map((s) => s.id)).size, semesters.length, '学期 id 必须唯一');
    for (const period of semesters) {
      assert.ok(period.start_date <= period.end_date, `${period.id} 起止日期顺序错误`);
      assert.ok(
        /^\d{4}-\d{2}-\d{2}$/.test(period.start_date) && /^\d{4}-\d{2}-\d{2}$/.test(period.end_date),
        `${period.id} 日期格式错误`
      );
      assert.ok(period.label.includes('项目演示校历'), '演示校历必须在标签中注明是项目配置');
    }
    assert.equal(getSemester('2026-2027-1')?.school_year, '2026-2027');
    assert.equal(getSemester('不存在-1'), null);
    const configSource = readFileSync(
      new URL('../src/lib/semester/config.ts', import.meta.url),
      'utf8'
    );
    assert.ok(configSource.includes('不是全国统一学期'), '配置须注明不是全国统一学期');

    // 首尾含端点、跨年、当前学期
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

    // semester_id 优先于 from/to，且不因 from/to 不合法而报错
    const priority = resolveEvidenceScope({
      semester_id: '2026-2027-1',
      from: 'not-a-date',
      to: 'also-bad',
    });
    assert.ok(priority.ok);
    assert.equal(priority.scope.semester_id, '2026-2027-1');

    // 闰日合法、非法日期被拒
    const leap = resolveEvidenceScope({ from: '2024-02-29', to: '2024-03-01' });
    assert.ok(leap.ok);
    assert.deepEqual(
      [leap.scope.start_date, leap.scope.end_date],
      ['2024-02-29', '2024-03-01']
    );
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

    // 缺省当前学期；配置缺失时 semester_config_missing（409）
    const current = resolveEvidenceScope({}, { today: '2026-10-03' });
    assert.ok(current.ok);
    assert.equal(current.scope.semester_id, '2026-2027-1');
    const missing = resolveEvidenceScope({}, { semesters: [], today: '2026-10-03' });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error, 'semester_config_missing');
    const missingToday = resolveEvidenceScope({}, { today: '2020-01-01' });
    assert.equal(missingToday.ok, false);
    if (!missingToday.ok) assert.equal(missingToday.error, 'semester_config_missing');
    passed += 1;

    // ————————————————————————— 离线：迁移与初始化同构 —————————————————————————
    const migrationSql = readFileSync(
      new URL('../scripts/upgrade-guide-evidence-v1.sql', import.meta.url),
      'utf8'
    );
    // 只检查可执行语句：注释里说明“不伪造 legacy_import”不应触发禁令
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
    passed += 1;

    // ————————————————————————— 实库（一次性本地 Postgres） —————————————————————————
    const { url, teardown } = await startTestDatabase();
    process.env.DATABASE_URL = url;
    const setup = new Client({ connectionString: url });
    await setup.connect();

    process.env[TEACHER_PASSCODE_KEY] = 'history-offline-passcode';

    try {
      await applySql(setup, 'initialize-demo-db.sql');
      const coreBefore = await snapshotCore();
      // 迁移执行两遍：幂等，且不改变三件套与旧记录的 NULL 快照
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

      // 旧记录：class_id 有历史回填，但快照/证据保持 NULL（不用 classes.stage 反推）
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

      // 损坏 guide_evidence 不得在映射层被静默转为 NULL（原样透传，留给 G5 显式识别）
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

      // 建测试数据：直接 SQL 精确控制分班历史日期
      await insertClass({ id: ID.classSmall, name: '历史小班', stage: 'small', school_year: '2030-2031' });
      await insertClass({ id: ID.classMiddle, name: '历史中班', stage: 'middle', school_year: '2030-2031' });
      await insertClass({ id: ID.classOverlapA, name: '重叠一班', stage: 'small', school_year: '2031-2032' });
      await insertClass({ id: ID.classOverlapB, name: '重叠二班', stage: 'middle', school_year: '2031-2032' });
      await insertClass({ id: ID.classFresh, name: '未使用新班', stage: 'small', school_year: '2030-2031' });
      await insertClass({ id: ID.classTransferFrom, name: '转出前班', stage: 'small', school_year: '2031-2032' });
      await insertClass({ id: ID.classTransferTo, name: '转出后班', stage: 'middle', school_year: '2031-2032' });
      await insertClass({ id: ID.classEnrollmentOnly, name: '仅分班班', stage: 'large', school_year: '2033-2034' });
      await insertChild(ID.childBackfill, '补录幼儿');
      await insertChild(ID.childOverlap, '重叠幼儿');
      await insertChild(ID.childBroken, '异常幼儿');
      await insertChild(ID.childTransfer, '转班幼儿');
      await insertChild(ID.childEnrollmentOnly, '仅分班幼儿');
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
      // end < start：异常历史，必须要求教师确认
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
        // 伪造完整快照：必须被忽略，快照一律由服务端核实
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

      // 10) 新快照数量 = 本自检写入的观察数；旧记录仍全部为 NULL；三件套未变
      const snapshotCount = await queryOne<{ count: number }>(
        `SELECT count(*)::int AS count FROM observations WHERE class_context_snapshot IS NOT NULL`
      );
      assert.equal(snapshotCount?.count, 3, '写入 3 条观察：补录转班前 / 转班当天 / 教师确认各一');
      const demoStillNull = await query<{ id: string }>(
        `SELECT id FROM observations
          WHERE is_demo AND class_context_snapshot IS NOT NULL`
      );
      assert.equal(demoStillNull.length, 0);
      assert.deepEqual(await snapshotCore(), coreBefore);

      console.log(JSON.stringify({ passed, total: passed, database: 'isolated-local-postgres' }));
    } finally {
      await globalThis.__pgPool?.end();
      await setup.end();
      teardown();
    }
  } finally {
    if (previousPasscode === undefined) delete process.env[TEACHER_PASSCODE_KEY];
    else process.env[TEACHER_PASSCODE_KEY] = previousPasscode;
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
