import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { NextRequest } from 'next/server';
import { Client } from 'pg';

import {
  assertCleanupComplete,
  modelGuardEnv,
  runCleanupSteps,
  startIsolatedPostgres,
  startModelRequestGuard,
  type CleanupReport,
  type CleanupStep,
  type IsolatedPostgres,
  type ModelRequestGuard,
} from './harness-safety';
import { TEACHER_COOKIE, createSessionToken, requireTeacher } from '../src/lib/auth';
import {
  listChildren,
  listClasses,
  listEnrollments,
  listObservations,
} from '../src/lib/queries';
import type { Child, Observation, SchoolClass } from '../src/lib/types';
import { CLASS_STAGES } from '../src/lib/types';
import { query, queryOne } from '../src/storage/database/pg-client';
import {
  createChildSchema,
  createClassSchema,
  enrollChildSchema,
} from '../src/lib/validation';

const TEACHER_PASSCODE_KEY = 'TEACHER_PASSCODE';
/** 本轮唯一标识：容器名、库名、所有权标签都由它派生，杜绝固定名互踩 */
const RUN_ID = `${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
const OWNERSHIP_LABEL = 'child-growth-agent.check-classes.run';
const CONTAINER_NAME = `cga-classes-check-${RUN_ID}`;
const DATABASE_NAME = `cga_check_${RUN_ID.replace(/-/g, '_')}`;
const TOTAL_CHECKS = 15;
/** 反例注入开关：只由安全反例自检显式指定，用于验证失败路径同样完成自有资源清理 */
const FAULT_STAGE = (process.env.CHECK_CLASSES_FAULT ?? '').trim();

interface ApiBody {
  message?: string;
  error?: string;
  reason?: string;
  classes?: SchoolClass[];
  class?: SchoolClass;
  children?: Child[];
  child?: Child;
  observation?: Observation;
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * 启动并核验本轮一次性本地 Postgres：容器 ID、回环端口映射、数据库身份与空库
 * 全部由 harness-safety 核验通过后才返回。本函数不读取任何外部连接串。
 */
export async function startClassesHarnessDatabase(
  noteIssue: (label: string, detail: string) => void
): Promise<IsolatedPostgres> {
  return startIsolatedPostgres({
    runId: RUN_ID,
    containerName: CONTAINER_NAME,
    dbName: DATABASE_NAME,
    labelKey: OWNERSHIP_LABEL,
    noteIssue,
  });
}

/**
 * 最小结构化资源报告：父检查据此在本轮子任务超时/异常退出、来不及执行 finally 时，
 * 按已核实容器 ID + 所有权标签做补偿清理。只含运行标记与容器引用，不含连接串/口令/Cookie。
 */
interface HarnessResourceReport {
  resource: 'classes-harness';
  run_id: string;
  container_name: string;
  container_id: string;
  label_key: string;
  phase: string;
}

function reportHarnessResource(containerId: string, phase: string): void {
  const report: HarnessResourceReport = {
    resource: 'classes-harness',
    run_id: RUN_ID,
    container_name: CONTAINER_NAME,
    container_id: containerId,
    label_key: OWNERSHIP_LABEL,
    phase,
  };
  console.log(JSON.stringify(report));
}

/** 反例注入：容器已创建并登记后确定性挂起，父检查用短超时验证进程树核验与补偿清理 */
async function injectHang(): Promise<void> {
  if (FAULT_STAGE !== 'hang-after-container') return;
  await new Promise<void>(() => {
    setInterval(() => undefined, 1000);
  });
}

async function endPool(): Promise<CleanupReport> {
  const pool = globalThis.__pgPool;
  if (!pool) return { ok: true, detail: '本轮未创建连接池' };
  await pool.end();
  return { ok: true, detail: '连接池已关闭' };
}

async function endClient(client: Client | null): Promise<CleanupReport> {
  if (!client) return { ok: true, detail: '本轮未建立数据库客户端连接' };
  await client.end();
  return { ok: true, detail: '数据库客户端连接已关闭' };
}

/** 反例注入：初始化阶段 / 断言阶段失败，用于安全反例自检的失败路径验证 */
function injectFault(fault: 'init' | 'assert'): void {
  if (FAULT_STAGE !== fault) return;
  if (fault === 'init') throw new Error('[CHECK_CLASSES_FAULT] 初始化阶段失败注入');
  assert.fail('[CHECK_CLASSES_FAULT] 断言阶段失败注入');
}

/** 输出脱敏：连接串与会话 Cookie 一律不外泄 */
function redactOutput(text: string): string {
  return text
    .replace(/postgresql?:\/\/[^\s'"`)]+/gi, '<redacted-connection-string>')
    .replace(new RegExp(`${TEACHER_COOKIE}=[^;"\\s]+`, 'g'), '<redacted-cookie>');
}

async function applySql(client: Client, file: string): Promise<void> {
  await client.query(readFileSync(new URL(`../scripts/${file}`, import.meta.url), 'utf8'));
}

/** 演示数据与三件套（raw_text / ai_draft / confirmed_content）的快照：只覆盖演示观察，便于迁移前后比对 */
async function snapshotCore() {
  const rows = await query<{
    id: string;
    raw_text: string;
    ai_draft: unknown;
    confirmed_content: unknown;
    agent_context: unknown;
  }>(
    `SELECT id, raw_text, ai_draft, confirmed_content, agent_context
       FROM observations WHERE is_demo ORDER BY id`
  );
  const counts = await queryOne<{
    demo_children: number;
    demo_observations: number;
  }>(
    `SELECT (SELECT count(*) FROM children WHERE is_demo)::int AS demo_children,
            (SELECT count(*) FROM observations WHERE is_demo)::int AS demo_observations`
  );
  return { rows, counts };
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

async function main(): Promise<void> {
  let passed = 0;
  let phase = 'startup';
  let failure: { phase: string; message: string } | null = null;
  let guard: ModelRequestGuard | null = null;
  let database: IsolatedPostgres | null = null;
  let setup: Client | null = null;
  const cleanupIssues: string[] = [];
  const noteIssue = (label: string, detail: string): void => {
    cleanupIssues.push(`${label}: ${detail}`);
  };
  // 各清理步骤相互独立：单步失败只记录，不跳过后续自有资源清理
  const cleanupSteps: CleanupStep[] = [
    { label: 'connection-pool', run: () => endPool() },
    { label: 'setup-client', run: () => endClient(setup) },
    {
      label: 'postgres-container',
      run: () => database?.teardown() ?? { ok: true, detail: '本轮未启动数据库容器' },
    },
    { label: 'model-guard', run: () => (guard ? guard.close() : undefined) },
  ];
  const previousPasscode = process.env[TEACHER_PASSCODE_KEY];
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousPlatformUrl = process.env.PGDATABASE_URL;

  try {
    phase = 'model-guard';
    guard = await startModelRequestGuard();
    Object.assign(process.env, modelGuardEnv(guard));

    // ————————————————————————— 离线部分：不连数据库 —————————————————————————
    phase = 'offline';
    const upgradeSql = readFileSync(new URL('../scripts/upgrade-classes.sql', import.meta.url), 'utf8');
    const initSql = readFileSync(
      new URL('../scripts/initialize-demo-db.sql', import.meta.url),
      'utf8'
    );

    // 1) 迁移脚本：幂等标记、不删表、不动三件套、保留 class_name、一个儿童一条未结束归属
    assert.ok(upgradeSql.includes('CREATE TABLE IF NOT EXISTS classes'));
    assert.ok(upgradeSql.includes('CREATE TABLE IF NOT EXISTS child_class_enrollments'));
    assert.ok(upgradeSql.includes('ADD COLUMN IF NOT EXISTS class_id'));
    assert.ok(upgradeSql.includes('enrollments_current_child_idx'));
    assert.ok(upgradeSql.includes('WHERE end_date IS NULL'));
    assert.ok(upgradeSql.includes('ON CONFLICT (id) DO NOTHING'));
    assert.ok(!/DROP\s+TABLE/i.test(upgradeSql));
    assert.ok(!/DROP\s+COLUMN/i.test(upgradeSql));
    assert.ok(!/raw_text\s*=/i.test(upgradeSql));
    assert.ok(!/ai_draft\s*=/i.test(upgradeSql));
    assert.ok(!/confirmed_content\s*=/i.test(upgradeSql));
    assert.ok(upgradeSql.includes('children.class_name'));
    for (const name of ['向日葵班', '彩虹班', '蒲公英班']) {
      assert.ok(upgradeSql.includes(name), `迁移脚本缺少演示班级 ${name}`);
    }
    // 新库初始化脚本与 schema.ts 保持同构（建表 + 索引），演示数据映射与迁移一致
    assert.ok(initSql.includes('CREATE TABLE IF NOT EXISTS classes'));
    assert.ok(initSql.includes('CREATE TABLE IF NOT EXISTS child_class_enrollments'));
    assert.ok(initSql.includes('ADD COLUMN IF NOT EXISTS class_id'));
    assert.ok(initSql.includes("'蒲公英班', 'large'"));
    passed += 1;

    // 2) Zod：三个学段、非法学年 / 学段被拒、幼儿必须带班级（不再默认向日葵班）
    for (const stage of CLASS_STAGES) {
      const parsed = createClassSchema.safeParse({
        name: `学段${stage}`,
        stage,
        school_year: '2026-2027',
      });
      assert.equal(parsed.success, true);
    }
    assert.equal(
      createClassSchema.safeParse({ name: 'X', stage: 'college', school_year: '2026' }).success,
      false
    );
    assert.equal(
      createChildSchema.safeParse({
        name: '小明',
        gender: '男',
        birth_date: '2022-01-01',
      }).success,
      false
    );
    assert.equal(
      createChildSchema.safeParse({
        name: '小明',
        gender: '男',
        birth_date: '2022-01-01',
        class_id: 'c3c30000-0000-4000-8000-000000000001',
      }).success,
      true
    );
    assert.equal(
      enrollChildSchema.safeParse({ child_id: 'not-a-uuid', start_date: '2026-09-01' }).success,
      false
    );
    passed += 1;

    // 3) 未登录写操作 401；未配置口令 503
    process.env[TEACHER_PASSCODE_KEY] = 'offline-class-passcode';
    assert.equal(requireTeacher(apiRequest('/api/classes', { method: 'POST' }))?.status, 401);
    delete process.env[TEACHER_PASSCODE_KEY];
    assert.equal(requireTeacher(apiRequest('/api/classes', { method: 'POST' }))?.status, 503);
    process.env[TEACHER_PASSCODE_KEY] = 'offline-class-passcode';
    passed += 1;

    // ————————————————————————— 本地一次性 Postgres —————————————————————————
    phase = 'database-start';
    database = await startClassesHarnessDatabase(noteIssue);
    // 容器身份核验通过后立即登记资源报告；此后的挂起/崩溃由父检查补偿清理
    reportHarnessResource(database.containerId, 'database-start');
    await injectHang();
    // 数据访问前绑定：只认本轮已核验目标，且不回退到 .env / 平台注入的数据库
    process.env.DATABASE_URL = database.url;
    delete process.env.PGDATABASE_URL;
    assert.ok(process.env.DATABASE_URL === database.url, '数据库配置未绑定到本轮已核验目标');
    const bound = await queryOne<{ db: string }>('SELECT current_database() AS db');
    assert.equal(bound?.db, DATABASE_NAME, '应用侧数据访问未指向本轮目标库');

    phase = 'database-init';
    const client = new Client({ connectionString: database.url });
    await client.connect();
    setup = client;
    injectFault('init');
    await applySql(client, 'initialize-demo-db.sql');
    const before = await snapshotCore();
    // 迁移执行两遍：幂等且不改动 raw_text / ai_draft / confirmed_content 与演示数据
    phase = 'migration';
    await applySql(setup, 'upgrade-classes.sql');
    await applySql(setup, 'upgrade-classes.sql');
    assert.deepEqual(await snapshotCore(), before);
    assert.equal(before.counts?.demo_children, 6);
    assert.equal(before.counts?.demo_observations, 3);
    passed += 1;

    phase = 'checks';
    injectFault('assert');

    // 4) 演示班级覆盖三个学段；6 名演示儿童都有明确班级、学段、学年
    const demoClasses = (await listClasses()).filter((c) => c.is_demo);
    assert.equal(demoClasses.length, 3);
    for (const stage of CLASS_STAGES) {
      assert.ok(
        demoClasses.some((c) => c.stage === stage),
        `演示班级缺少学段 ${stage}`
      );
    }
    const demoChildren = (await listChildren()).filter((c) => c.is_demo);
    assert.equal(demoChildren.length, 6);
    for (const child of demoChildren) {
      assert.ok(child.class_id, `${child.name} 没有班级归属`);
      assert.ok(child.class_stage, `${child.name} 没有学段`);
      assert.ok(child.class_school_year, `${child.name} 没有学年`);
      assert.equal(child.current_class?.name, child.class_name);
    }
    assert.equal(demoChildren.find((c) => c.name === '糖糖')?.current_class?.name, '向日葵班');
    assert.equal(demoChildren.find((c) => c.name === '果果')?.current_class?.name, '彩虹班');
    assert.equal(demoChildren.find((c) => c.name === '石头')?.current_class?.name, '蒲公英班');
    assert.equal(demoChildren.find((c) => c.name === '石头')?.class_stage, 'large');
    passed += 1;

    // 5) 石头的转班历史保留：旧归属只写 end_date，不删除
    const stone = demoChildren.find((c) => c.name === '石头');
    assert.ok(stone);
    const stoneEnrollments = await listEnrollments(stone.id);
    assert.equal(stoneEnrollments.length, 2);
    assert.equal(stoneEnrollments[0].class_id, 'c3c30000-0000-4000-8000-000000000001');
    assert.equal(stoneEnrollments[0].end_date, '2026-09-20');
    assert.equal(stoneEnrollments[1].end_date, null);
    assert.equal(stoneEnrollments[1].class_id, 'c3c30000-0000-4000-8000-000000000003');
    passed += 1;

    // 6) 演示观察都带发生时班级快照（按观察日期落在的归属回填）
    const demoObservations = (await listObservations()).filter((o) => o.is_demo);
    assert.equal(demoObservations.length, 3);
    const observationClasses = new Map(
      demoObservations.map((o) => [o.child_id, o.observed_class?.name])
    );
    assert.equal(observationClasses.get('a1c10000-0000-4000-8000-000000000001'), '向日葵班');
    assert.equal(observationClasses.get('a1c10000-0000-4000-8000-000000000002'), '彩虹班');
    assert.equal(observationClasses.get('a1c10000-0000-4000-8000-000000000003'), '向日葵班');
    passed += 1;

    // 7) API 路由
    const { GET: listClassesHandler, POST: createClassHandler } = await import(
      '@/app/api/classes/route'
    );
    const { GET: getClassHandler, PATCH: patchClassHandler } = await import(
      '@/app/api/classes/[id]/route'
    );
    const { POST: enrollHandler } = await import('@/app/api/classes/[id]/children/route');
    const { POST: createChildHandler } = await import('@/app/api/children/route');
    const { POST: createObservationHandler } = await import('@/app/api/observations/route');

    const cookie = `${TEACHER_COOKIE}=${createSessionToken().token}`;
    const post = (path: string, body: unknown, withCookie = false) =>
      createClassHandler(
        apiRequest(path, { method: 'POST', body, cookie: withCookie ? cookie : undefined })
      );
    const postAsTeacher = (path: string, body: unknown) => post(path, body, true);

    // 8) GET 只读开放；未登录写操作 401
    const listed = await listClassesHandler();
    assert.equal(listed.status, 200);
    const listedBody = (await listed.json()) as ApiBody;
    assert.ok(Array.isArray(listedBody.classes) && listedBody.classes.length >= 3);
    assert.equal((await post('/api/classes', { name: '未登录班', stage: 'small', school_year: '2031-2032' })).status, 401);
    passed += 1;

    // 9) 创建三个学段班级 + 重名 409 + 非法输入 400
    const created: Record<string, SchoolClass> = {};
    const stageNames: Record<string, string> = { small: '自检小班', middle: '自检中班', large: '自检大班' };
    for (const stage of CLASS_STAGES) {
      const res = await postAsTeacher('/api/classes', {
        name: stageNames[stage],
        stage,
        school_year: '2031-2032',
      });
      const text = await res.text();
      assert.equal(res.status, 201, `${stageNames[stage]} -> ${text}`);
      const body = JSON.parse(text) as ApiBody;
      assert.equal(body.class?.stage, stage);
      created[stage] = body.class as SchoolClass;
    }
    assert.equal(
      (await postAsTeacher('/api/classes', { name: '自检小班', stage: 'small', school_year: '2031-2032' }))
        .status,
      409
    );
    const invalid = await postAsTeacher('/api/classes', {
      name: '  ',
      stage: 'college',
      school_year: '2031',
    });
    assert.equal(invalid.status, 400);
    assert.ok(((await invalid.json()) as ApiBody).message);
    passed += 1;

    // 10) 班级详情（只读）返回当前在班儿童；PATCH 未登录 401
    const sunflowerId = 'c3c30000-0000-4000-8000-000000000001';
    const detail = await getClassHandler(apiRequest(`/api/classes/${sunflowerId}`, { method: 'GET' }), {
      params: Promise.resolve({ id: sunflowerId }),
    });
    assert.equal(detail.status, 200);
    const detailBody = (await detail.json()) as ApiBody;
    assert.equal(detailBody.class?.name, '向日葵班');
    assert.equal(detailBody.children?.length, 3);
    assert.equal(
      (
        await patchClassHandler(
          apiRequest(`/api/classes/${sunflowerId}`, { method: 'PATCH', body: { is_active: false } }),
          { params: Promise.resolve({ id: sunflowerId }) }
        )
      ).status,
      401
    );
    passed += 1;

    // 11) 新建儿童：class_id 分班 / class_name 匹配已存在班级 / 无班级与未知班级明确报错
    const childRes = await createChildHandler(
      apiRequest('/api/children', {
        method: 'POST',
        body: {
          name: '自检幼儿',
          gender: '女',
          birth_date: '2022-04-04',
          class_id: created.small.id,
        },
        cookie,
      })
    );
    assert.equal(childRes.status, 201);
    const createdChild = ((await childRes.json()) as ApiBody).child as Child;
    assert.equal(createdChild.class_id, created.small.id);
    assert.equal(createdChild.class_stage, 'small');
    assert.equal(createdChild.current_class?.name, '自检小班');

    const byNameRes = await createChildHandler(
      apiRequest('/api/children', {
        method: 'POST',
        body: { name: '按名称建档', gender: '男', birth_date: '2022-06-06', class_name: '彩虹班' },
        cookie,
      })
    );
    assert.equal(byNameRes.status, 201);
    assert.equal(((await byNameRes.json()) as ApiBody).child?.class_id, 'c3c30000-0000-4000-8000-000000000002');

    const noClassRes = await createChildHandler(
      apiRequest('/api/children', {
        method: 'POST',
        body: { name: '没班级', gender: '男', birth_date: '2022-07-07' },
        cookie,
      })
    );
    assert.equal(noClassRes.status, 400);
    assert.ok(((await noClassRes.json()) as ApiBody).message?.includes('班级'));

    const unknownClassRes = await createChildHandler(
      apiRequest('/api/children', {
        method: 'POST',
        body: { name: '未知班级', gender: '男', birth_date: '2022-08-08', class_name: '草莓班' },
        cookie,
      })
    );
    assert.equal(unknownClassRes.status, 400);
    assert.ok(((await unknownClassRes.json()) as ApiBody).message?.includes('未找到班级'));

    assert.equal(
      (
        await createChildHandler(
          apiRequest('/api/children', {
            method: 'POST',
            body: { name: '未登录建档', gender: '男', birth_date: '2022-09-09', class_id: created.small.id },
          })
        )
      ).status,
      401
    );
    passed += 1;

    // 12) 新观察保存发生时班级快照；未登录写操作 401；无归属儿童要求教师确认（不套默认班级）
    // 观察日期不早于入班日期时，按分班历史解析（早于入班的日期需要教师确认，见 G2 自检）
    const createdEnrollments = await listEnrollments(createdChild.id);
    assert.equal(createdEnrollments.length, 1);
    const enrollmentStart = createdEnrollments[0].start_date;
    const firstRawText =
      '自检幼儿在积木区把三块长积木并排搭成小桥，桥上放了一个小汽车，桥没有倒。';
    const firstObsRes = await createObservationHandler(
      apiRequest('/api/observations', {
        method: 'POST',
        body: {
          child_id: createdChild.id,
          observed_at: enrollmentStart,
          context: '自检区域活动',
          raw_text: firstRawText,
        },
        cookie,
      })
    );
    assert.equal(firstObsRes.status, 201);
    const firstObs = ((await firstObsRes.json()) as ApiBody).observation as Observation;
    // 创建响应以持久化快照为准：observed_class 是读取路径的动态联表投影，创建响应不承诺该字段
    assert.equal(firstObs.class_id, created.small.id);
    assert.equal(firstObs.observed_at, enrollmentStart);
    assert.equal(firstObs.raw_text, firstRawText);
    assert.ok(firstObs.class_context_snapshot, '创建响应必须携带发生时班级快照');
    assert.equal(firstObs.class_context_snapshot?.source, 'enrollment_lookup');
    assert.equal(firstObs.class_context_snapshot?.class_id, created.small.id);
    assert.equal(firstObs.class_context_snapshot?.class_name, '自检小班');
    assert.equal(firstObs.class_context_snapshot?.stage, 'small');
    assert.equal(firstObs.class_context_snapshot?.school_year, '2031-2032');
    // 回读同一观察（真实读取路径）保留联表投影验证，并与创建响应对齐持久化快照
    const firstObsRead = (await listObservations({ childId: createdChild.id })).find(
      (o) => o.id === firstObs.id
    );
    assert.ok(firstObsRead, '回读第一条观察失败');
    assert.equal(firstObsRead.class_id, firstObs.class_id);
    assert.equal(firstObsRead.observed_at, firstObs.observed_at);
    assert.equal(firstObsRead.raw_text, firstObs.raw_text);
    assert.equal(firstObsRead.observed_class?.name, '自检小班');
    assert.deepEqual(firstObsRead.class_context_snapshot, firstObs.class_context_snapshot);

    assert.equal(
      (
        await createObservationHandler(
          apiRequest('/api/observations', {
            method: 'POST',
            body: { child_id: createdChild.id, observed_at: '2026-09-28', raw_text: '未登录写入的观察原文，长度需要超过十个字。' },
          })
        )
      ).status,
      401
    );

    const orphan = await queryOne<{ id: string }>(
      `INSERT INTO children (name, gender, birth_date, class_name)
       VALUES ('游离幼儿', '男', '2022-02-02', '向日葵班')
       RETURNING id`
    );
    assert.ok(orphan);
    const orphanRes = await createObservationHandler(
      apiRequest('/api/observations', {
        method: 'POST',
        body: {
          child_id: orphan.id,
          observed_at: enrollmentStart,
          raw_text: '没有班级归属的儿童写观察，应当要求教师确认当时班级而不是套用默认班级。',
        },
        cookie,
      })
    );
    assert.equal(orphanRes.status, 409);
    const orphanBody = (await orphanRes.json()) as ApiBody;
    assert.equal(orphanBody.error, 'class_context_confirmation_required');
    assert.equal(orphanBody.reason, 'no_attribution');
    passed += 1;

    // 13) 转班：旧归属保留、旧观察快照不变、新观察写入新班级、重复分班 409
    const beforeTransfer = await listEnrollments(createdChild.id);
    assert.equal(beforeTransfer.length, 1);
    const transferStart = addDays(beforeTransfer[0].start_date, 1);
    const transferRes = await enrollHandler(
      apiRequest(`/api/classes/${created.middle.id}/children`, {
        method: 'POST',
        body: { child_id: createdChild.id, start_date: transferStart },
        cookie,
      }),
      { params: Promise.resolve({ id: created.middle.id }) }
    );
    assert.equal(transferRes.status, 200);
    const enrollments = await listEnrollments(createdChild.id);
    assert.equal(enrollments.length, 2);
    assert.equal(enrollments[0].class_id, created.small.id);
    assert.equal(enrollments[0].end_date, beforeTransfer[0].start_date);
    assert.equal(enrollments[1].end_date, null);
    assert.equal(enrollments[1].class_id, created.middle.id);

    const afterTransfer = await listChildren();
    const transferred = afterTransfer.find((c) => c.id === createdChild.id);
    assert.equal(transferred?.current_class?.name, '自检中班');
    assert.equal(transferred?.class_name, '自检中班');

    const oldObs = (await listObservations({ childId: createdChild.id })).find(
      (o) => o.id === firstObs.id
    );
    assert.equal(oldObs?.class_id, created.small.id);
    assert.equal(oldObs?.observed_class?.name, '自检小班');
    assert.equal(oldObs?.raw_text, firstObs.raw_text);
    // 转班不改写历史：旧观察的持久化快照与创建时完全一致
    assert.deepEqual(oldObs?.class_context_snapshot, firstObs.class_context_snapshot);

    const secondRawText = '转班之后的观察原文，需要超过十个字以便通过校验规则。';
    const secondObsRes = await createObservationHandler(
      apiRequest('/api/observations', {
        method: 'POST',
        body: {
          child_id: createdChild.id,
          observed_at: transferStart,
          context: '转班当天',
          raw_text: secondRawText,
        },
        cookie,
      })
    );
    assert.equal(secondObsRes.status, 201);
    const secondObs = ((await secondObsRes.json()) as ApiBody).observation as Observation;
    // 新观察记录新的发生时班级：创建响应以持久化快照为准
    assert.equal(secondObs.class_id, created.middle.id);
    assert.equal(secondObs.observed_at, transferStart);
    assert.equal(secondObs.raw_text, secondRawText);
    assert.ok(secondObs.class_context_snapshot, '创建响应必须携带发生时班级快照');
    assert.equal(secondObs.class_context_snapshot?.source, 'enrollment_lookup');
    assert.equal(secondObs.class_context_snapshot?.class_id, created.middle.id);
    assert.equal(secondObs.class_context_snapshot?.class_name, '自检中班');
    assert.equal(secondObs.class_context_snapshot?.stage, 'middle');
    assert.equal(secondObs.class_context_snapshot?.school_year, '2031-2032');
    const secondObsRead = (await listObservations({ childId: createdChild.id })).find(
      (o) => o.id === secondObs.id
    );
    assert.ok(secondObsRead, '回读第二条观察失败');
    assert.equal(secondObsRead.class_id, secondObs.class_id);
    assert.equal(secondObsRead.observed_at, secondObs.observed_at);
    assert.equal(secondObsRead.raw_text, secondObs.raw_text);
    assert.equal(secondObsRead.observed_class?.name, '自检中班');
    assert.deepEqual(secondObsRead.class_context_snapshot, secondObs.class_context_snapshot);

    assert.equal(
      (
        await enrollHandler(
          apiRequest(`/api/classes/${created.middle.id}/children`, {
            method: 'POST',
            body: { child_id: createdChild.id },
            cookie,
          }),
          { params: Promise.resolve({ id: created.middle.id }) }
        )
      ).status,
      409
    );
    passed += 1;

    // 14) 班级停用：历史观察不受影响，停用后不再接受分班与建档
    const beforeDeactivate = (await listObservations({ childId: createdChild.id })).length;
    const patchRes = await patchClassHandler(
      apiRequest(`/api/classes/${created.small.id}`, {
        method: 'PATCH',
        body: { is_active: false },
        cookie,
      }),
      { params: Promise.resolve({ id: created.small.id }) }
    );
    assert.equal(patchRes.status, 200);
    assert.equal(((await patchRes.json()) as ApiBody).class?.is_active, false);

    const afterDeactivate = await listObservations({ childId: createdChild.id });
    assert.equal(afterDeactivate.length, beforeDeactivate);
    const keptOld = afterDeactivate.find((o) => o.id === firstObs.id);
    assert.equal(keptOld?.class_id, created.small.id);
    assert.equal(keptOld?.observed_class?.name, '自检小班');
    assert.equal(keptOld?.raw_text, firstObs.raw_text);
    assert.equal(keptOld?.confirmed_content, null);
    // 停用班级不改写历史观察的持久化快照
    assert.deepEqual(keptOld?.class_context_snapshot, firstObs.class_context_snapshot);

    assert.equal(
      (
        await enrollHandler(
          apiRequest(`/api/classes/${created.small.id}/children`, {
            method: 'POST',
            body: { child_id: createdChild.id, start_date: '2026-09-30' },
            cookie,
          }),
          { params: Promise.resolve({ id: created.small.id }) }
        )
      ).status,
      400
    );
    const intoInactive = await createChildHandler(
      apiRequest('/api/children', {
        method: 'POST',
        body: { name: '进停用班', gender: '女', birth_date: '2022-05-05', class_id: created.small.id },
        cookie,
      })
    );
    assert.equal(intoInactive.status, 400);
    assert.ok(((await intoInactive.json()) as ApiBody).message?.includes('已停用'));
    passed += 1;

    // 15) 收尾复核：演示数据未被删除，三件套与迁移前完全一致
    const finalSnapshot = await snapshotCore();
    assert.deepEqual(finalSnapshot, before);
    assert.equal(finalSnapshot.counts?.demo_children, 6);
    assert.equal(finalSnapshot.counts?.demo_observations, 3);
    const finalClasses = await listClasses();
    assert.equal(finalClasses.filter((c) => c.is_demo).length, 3);
    passed += 1;

    phase = 'no-model-call';
    if (guard && guard.hits > 0) {
      throw new Error(`检测到 ${guard.hits} 次模型出站请求，本轮自检禁止调用模型`);
    }
    assert.equal(passed, TOTAL_CHECKS, `检查项未全部完成（${passed}/${TOTAL_CHECKS}）`);
  } catch (error) {
    failure = { phase, message: error instanceof Error ? error.message : String(error) };
  } finally {
    await runCleanupSteps(cleanupSteps, noteIssue);
    if (previousPasscode === undefined) delete process.env[TEACHER_PASSCODE_KEY];
    else process.env[TEACHER_PASSCODE_KEY] = previousPasscode;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousPlatformUrl === undefined) delete process.env.PGDATABASE_URL;
    else process.env.PGDATABASE_URL = previousPlatformUrl;
  }

  // 清理闸门：任一清理步骤失败都不得报告 PASS
  try {
    assertCleanupComplete(cleanupIssues);
  } catch (error) {
    failure = failure ?? {
      phase: 'cleanup',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (failure) {
    console.error(
      redactOutput(
        JSON.stringify({
          result: 'FAIL',
          phase: failure.phase,
          message: failure.message,
          passed,
          total: TOTAL_CHECKS,
          container: database?.containerId ?? null,
          cleanupIssues,
        })
      )
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    JSON.stringify({
      result: 'PASS',
      passed,
      total: TOTAL_CHECKS,
      container: database?.containerId ?? null,
    })
  );
}

void main().catch((error: unknown) => {
  console.error(
    redactOutput(error instanceof Error ? (error.stack ?? error.message) : String(error))
  );
  process.exitCode = 1;
});
