import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { NextRequest } from 'next/server';
import { Client } from 'pg';

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

const CONTAINER = 'cga-classes-check';
const TEACHER_PASSCODE_KEY = 'TEACHER_PASSCODE';

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function docker(args: string[]): { status: number; output: string } {
  const res = spawnSync('docker', args, { encoding: 'utf8' });
  return { status: res.status ?? 1, output: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() };
}

/** 起一个一次性本地 Postgres（不连线上库）；也可用 CLASSES_TEST_DATABASE_URL 指向现成测试库 */
async function startTestDatabase(): Promise<{ url: string; teardown: () => void }> {
  const external = process.env.CLASSES_TEST_DATABASE_URL?.trim();
  if (external) return { url: external, teardown: () => undefined };

  const probe = docker(['version']);
  if (probe.status !== 0) {
    throw new Error(
      `未检测到可用的 Docker：班级自检需要一次性本地 Postgres，或设置 CLASSES_TEST_DATABASE_URL 指向测试库（${probe.output}）`
    );
  }

  docker(['rm', '-f', CONTAINER]);
  const run = docker([
    'run', '-d', '--name', CONTAINER,
    '-e', 'POSTGRES_PASSWORD=postgres',
    '-e', 'POSTGRES_DB=cga_check',
    '-p', '127.0.0.1::5432',
    'postgres:16-alpine',
  ]);
  if (run.status !== 0) throw new Error(`启动测试数据库失败：${run.output}`);

  const mapped = docker(['port', CONTAINER, '5432/tcp']).output.split('\n')[0] ?? '';
  const hostPort = mapped.split(':').pop()?.trim();
  if (!hostPort) throw new Error(`无法读取测试数据库端口：${mapped}`);
  const url = `postgresql://postgres:postgres@127.0.0.1:${hostPort}/cga_check`;

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

  return {
    url,
    teardown: () => {
      docker(['rm', '-f', CONTAINER]);
    },
  };
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
  const previousPasscode = process.env[TEACHER_PASSCODE_KEY];

  try {
    // ————————————————————————— 离线部分：不连数据库 —————————————————————————
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
    const { url, teardown } = await startTestDatabase();
    process.env.DATABASE_URL = url;
    const setup = new Client({ connectionString: url });
    await setup.connect();

    try {
      await applySql(setup, 'initialize-demo-db.sql');
      const before = await snapshotCore();
      // 迁移执行两遍：幂等且不改动 raw_text / ai_draft / confirmed_content 与演示数据
      await applySql(setup, 'upgrade-classes.sql');
      await applySql(setup, 'upgrade-classes.sql');
      assert.deepEqual(await snapshotCore(), before);
      assert.equal(before.counts?.demo_children, 6);
      assert.equal(before.counts?.demo_observations, 3);
      passed += 1;

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
      const firstObsRes = await createObservationHandler(
        apiRequest('/api/observations', {
          method: 'POST',
          body: {
            child_id: createdChild.id,
            observed_at: enrollmentStart,
            context: '自检区域活动',
            raw_text: '自检幼儿在积木区把三块长积木并排搭成小桥，桥上放了一个小汽车，桥没有倒。',
          },
          cookie,
        })
      );
      assert.equal(firstObsRes.status, 201);
      const firstObs = ((await firstObsRes.json()) as ApiBody).observation as Observation;
      assert.equal(firstObs.class_id, created.small.id);
      assert.equal(firstObs.observed_class?.name, '自检小班');
      assert.equal(firstObs.class_context_snapshot?.source, 'enrollment_lookup');
      assert.equal(firstObs.class_context_snapshot?.class_id, created.small.id);

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

      const secondObsRes = await createObservationHandler(
        apiRequest('/api/observations', {
          method: 'POST',
          body: {
            child_id: createdChild.id,
            observed_at: transferStart,
            context: '转班当天',
            raw_text: '转班之后的观察原文，需要超过十个字以便通过校验规则。',
          },
          cookie,
        })
      );
      assert.equal(secondObsRes.status, 201);
      const secondObs = ((await secondObsRes.json()) as ApiBody).observation as Observation;
      assert.equal(secondObs.class_id, created.middle.id);
      assert.equal(secondObs.observed_class?.name, '自检中班');
      assert.equal(secondObs.class_context_snapshot?.source, 'enrollment_lookup');
      assert.equal(secondObs.class_context_snapshot?.class_id, created.middle.id);

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

      console.log(JSON.stringify({ passed, total: passed }));
    } finally {
      // 先关掉连接再销毁容器，避免空闲连接被容器终止时报错
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
