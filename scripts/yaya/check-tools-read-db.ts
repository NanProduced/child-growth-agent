import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

import {
  assertCleanupComplete,
  modelGuardEnv,
  runCleanupSteps,
  startIsolatedPostgres,
  startModelRequestGuard,
  type IsolatedPostgres,
} from '../harness-safety';
import { createSessionToken } from '../../src/lib/accounts/session';
import { listGuideItems } from '../../src/lib/guide/catalog';
import { GUIDE_CATALOG_VERSION } from '../../src/lib/guide/types';
import type { ObservationDraft } from '../../src/lib/types';
import { createYayaReadRegistry } from '../../src/lib/yaya/tools/read/registry';
import type { YayaReadPayload } from '../../src/lib/yaya/tools/read/types';

/**
 * TOOLS-READ1 隔离库检查：真实 registry/dispatcher + 一次性 PostgreSQL。
 *
 * 通过真实现有授权链（AUTH 会话 + scoped 读取）验证：正常、越权、空任教、
 * 撤会话、撤任教、转班后的读取投影，以及管理员/教师差异与失败/空态分离。
 * 不读 .env、不连托管库、不调用真实 provider/搜索/S3；模型出口由 harness 守门。
 */

const RUN = `tools-read-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ORIGIN = 'http://tools-read-check.invalid';
const T1 = '2026-09-10T02:00:00.000Z';

const ids = {
  classA: randomUUID(),
  classB: randomUUID(),
  classC: randomUUID(),
  childA: randomUUID(),
  childB: randomUUID(),
  moved: randomUUID(),
  enrA: randomUUID(),
  enrB: randomUUID(),
  enrMovedOld: randomUUID(),
  enrMovedNew: randomUUID(),
  obsA: randomUUID(),
  obsB: randomUUID(),
  obsMovedOld: randomUUID(),
};

const draft: ObservationDraft = {
  domain: '科学',
  sub_domain: '科学探究',
  objective_description: '幼儿把积木放在一起。',
  highlights: ['幼儿把积木放在一起。'],
  support_suggestions: ['继续观察摆放过程。'],
  highlight_quote: '把积木放在一起',
};

let passed = 0;
function check(condition: unknown, label: string): void {
  assert.ok(condition, label);
  passed += 1;
}

type Outcome = Awaited<ReturnType<ReturnType<typeof createYayaReadRegistry>['dispatch']>>;

function payloadOf(outcome: Outcome): YayaReadPayload<unknown> {
  assert.ok(outcome.ok, 'expected ok outcome');
  return outcome.data as YayaReadPayload<unknown>;
}

function dataOf<T>(outcome: Outcome): T {
  return payloadOf(outcome).data as T;
}

const carrier = (token: string | null) => ({
  headers: new Headers(token === null ? {} : { cookie: `cga_session=${token}` }),
});

async function main(): Promise<void> {
  check(globalThis.__pgPool === undefined, 'fresh process must not reuse a database pool');
  const guard = await startModelRequestGuard();
  Object.assign(process.env, modelGuardEnv(guard));
  let isolated: IsolatedPostgres | null = null;
  let db: Client | null = null;
  let competitor: Client | null = null;
  const cleanupIssues: string[] = [];
  let failure: unknown;
  try {
    isolated = await startIsolatedPostgres({
      runId: RUN,
      containerName: `cga-${RUN}`,
      dbName: 'cga_tools_read_check',
      labelKey: 'cga.tools.read.check',
      noteIssue: (label, detail) => cleanupIssues.push(`${label}: ${detail}`),
    });
    process.env.DATABASE_URL = isolated.url;
    delete process.env.PGDATABASE_URL;
    process.env.AUTH_TRUSTED_ORIGINS = ORIGIN;
    db = new Client({ connectionString: isolated.url });
    competitor = new Client({ connectionString: isolated.url });
    await db.connect();
    await competitor.connect();
    await db.query(fs.readFileSync(`${ROOT}scripts/initialize-demo-db.sql`, 'utf8'));
    await db.query(fs.readFileSync(`${ROOT}scripts/upgrade-auth-v1.sql`, 'utf8'));

    const item = (await listGuideItems()).find(
      (entry) => entry.product_rules.evidence_type === 'behavior',
    );
    assert.ok(item, 'catalog must provide a behavior item');

    for (const [id, name] of [
      [ids.classA, '读取检查A班'],
      [ids.classB, '读取检查B班'],
      [ids.classC, '读取检查C班'],
    ]) {
      await db.query(
        "INSERT INTO classes (id,name,stage,school_year,is_active,is_demo) VALUES ($1,$2,'small','2026-2027',true,false)",
        [id, name],
      );
    }
    for (const [id, name] of [
      [ids.childA, '读取幼儿甲'],
      [ids.childB, '读取幼儿乙'],
      [ids.moved, '读取幼儿丙'],
    ]) {
      await db.query(
        "INSERT INTO children (id,name,gender,birth_date,class_name,note,is_demo) VALUES ($1,$2,'女','2022-01-01','fixture','private-note-must-not-leak',false)",
        [id, name],
      );
    }
    await db.query(
      "INSERT INTO child_class_enrollments (id,child_id,class_id,start_date) VALUES ($1,$2,$3,'2026-09-01')",
      [ids.enrA, ids.childA, ids.classA],
    );
    await db.query(
      "INSERT INTO child_class_enrollments (id,child_id,class_id,start_date) VALUES ($1,$2,$3,'2026-09-01')",
      [ids.enrB, ids.childB, ids.classB],
    );
    await db.query(
      "INSERT INTO child_class_enrollments (id,child_id,class_id,start_date,end_date) VALUES ($1,$2,$3,'2025-09-01','2026-08-31')",
      [ids.enrMovedOld, ids.moved, ids.classA],
    );
    await db.query(
      "INSERT INTO child_class_enrollments (id,child_id,class_id,start_date) VALUES ($1,$2,$3,'2026-09-01')",
      [ids.enrMovedNew, ids.moved, ids.classB],
    );

    const snapshotA = {
      class_id: ids.classA,
      class_name: '读取检查A班',
      stage: 'small',
      school_year: '2026-2027',
      captured_at: T1,
      source: 'enrollment_lookup',
      enrollment_id: ids.enrA,
      confirmed_at: null,
    };
    const guideEvidence = {
      revision: 1,
      links: [
        {
          id: 'read1-link-1',
          item_id: item.id,
          catalog_version: GUIDE_CATALOG_VERSION,
          origin: 'manual',
          status: 'confirmed_clue',
          support: 'clue_only',
          adult_help_used: false,
          basis: [
            {
              observation_id: ids.obsA,
              observed_at: '2026-09-10',
              quote: '把积木放在一起',
              quote_source: 'raw_text',
              quote_field: null,
              class_context: snapshotA,
              source_confirmed_at: T1,
            },
          ],
          ai_reason: null,
          teacher_note: null,
          revision: 1,
          created_at: T1,
          decided_at: T1,
          withdrawn_at: null,
          withdrawn_reason: null,
        },
      ],
    };
    await db.query(
      `INSERT INTO observations
         (id, child_id, class_id, observed_at, context, raw_text, status, ai_draft, ai_model,
          ai_organized_at, confirmed_content, confirmed_at, class_context_snapshot, guide_evidence, is_demo)
       VALUES ($1,$2,$3,'2026-09-10','区域活动','幼儿把积木放在一起。','confirmed',$4::jsonb,
               'offline-substitute',$5,$4::jsonb,$5,$6::jsonb,$7::jsonb,false)`,
      [ids.obsA, ids.childA, ids.classA, JSON.stringify(draft), T1, JSON.stringify(snapshotA), JSON.stringify(guideEvidence)],
    );
    await db.query(
      `INSERT INTO observations
         (id, child_id, class_id, observed_at, context, raw_text, status, ai_draft, agent_context,
          class_context_snapshot, guide_evidence, is_demo)
       VALUES ($1,$2,$3,'2026-09-12','区域活动','幼儿把积木收进筐里。','ai_organized',$4::jsonb,
               '{"private_profile":"must-not-leak"}'::jsonb,$5::jsonb,
               '{"revision":0,"links":[],"private_cross_class":"must-not-leak"}'::jsonb,false)`,
      [ids.obsMovedOld, ids.moved, ids.classA, JSON.stringify(draft), JSON.stringify(snapshotA)],
    );
    await db.query(
      `INSERT INTO observations (id, child_id, class_id, observed_at, context, raw_text, status, is_demo)
       VALUES ($1,$2,$3,'2026-09-11','户外活动','幼儿在户外奔跑。','draft',false)`,
      [ids.obsB, ids.childB, ids.classB],
    );
    const growthProfile = {
      summary: '离线小结',
      recent_change: '',
      development_clues: [],
      next_support: '',
      next_focus: '',
      source_observation_ids: [ids.obsA],
      ai_model: 'offline-substitute',
      updated_at: T1,
      is_fallback: true,
      activity_support: {
        suggestions: [],
        source_observation_ids: [ids.obsA],
        ai_model: 'offline-substitute',
        generated_at: T1,
      },
    };
    await db.query('UPDATE children SET growth_profile = $2::jsonb WHERE id = $1', [
      ids.childA,
      JSON.stringify(growthProfile),
    ]);

    const session = async (name: string, role: 'teacher' | 'admin', classes: string[]) => {
      const accountId = randomUUID();
      const token = createSessionToken();
      await db!.query(
        "INSERT INTO app_accounts (id,username,display_name,password_hash,role) VALUES ($1,$2,$2,'test-never-logged-in',$3)",
        [accountId, `${RUN}-${name}`, role],
      );
      await db!.query(
        "INSERT INTO app_sessions (account_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '1 day')",
        [accountId, token.tokenHash],
      );
      for (const classId of classes) {
        await db!.query(
          'INSERT INTO teacher_class_assignments (account_id,class_id) VALUES ($1,$2)',
          [accountId, classId],
        );
      }
      return { accountId, ...token };
    };

    const teacherA = await session('teacher-a', 'teacher', [ids.classA]);
    const teacherB = await session('teacher-b', 'teacher', [ids.classB]);
    const teacherAB = await session('teacher-ab', 'teacher', [ids.classA, ids.classB]);
    const teacherC = await session('teacher-c', 'teacher', [ids.classC]);
    const emptyTeacher = await session('teacher-empty', 'teacher', []);
    const admin = await session('admin', 'admin', []);
    const revoked = await session('revoked', 'teacher', [ids.classA]);

    const registry = createYayaReadRegistry();
    const run = (token: string | null, tool: string, params: unknown = {}) =>
      registry.dispatch({ tool, params }, { request: carrier(token) });

    /* ------------------------------ 身份与范围 ------------------------------ */

    const anonymous = await run(null, 'list_children');
    check(!anonymous.ok && anonymous.code === 'unauthenticated', 'anonymous read is unauthenticated');
    check(!('data' in anonymous), 'unauthenticated read returns no data');

    const scoped = await run(teacherA.token, 'list_children');
    const scopedChildren = dataOf<{ children: Array<{ child_id: string }> }>(scoped).children;
    assert.deepEqual(scopedChildren.map((child) => child.child_id), [ids.childA]);
    passed += 1;
    check(!JSON.stringify(scoped).includes('private-note-must-not-leak'), 'list read omits teacher-private note');

    const emptyScope = await run(emptyTeacher.token, 'list_children');
    check(!emptyScope.ok && emptyScope.code === 'empty_scope', 'empty assignment is empty_scope, not the whole school');

    const adminChildren = dataOf<{ children: Array<{ child_id: string }> }>(
      await run(admin.token, 'list_children'),
    ).children.map((child) => child.child_id);
    check(adminChildren.includes(ids.childB) && adminChildren.includes(ids.moved), 'admin reads the whole school');

    /* ------------------------------ 目录与业务范围 ------------------------------ */

    const businessClasses = dataOf<{ catalog: boolean; classes: Array<{ id: string }> }>(
      await run(teacherA.token, 'list_classes'),
    );
    assert.deepEqual(businessClasses.classes.map((klass) => klass.id), [ids.classA]);
    passed += 1;
    const catalogClasses = dataOf<{ classes: Array<{ id: string }> }>(
      await run(teacherA.token, 'list_classes', { catalog: true }),
    ).classes.map((klass) => klass.id);
    check(catalogClasses.includes(ids.classB) && catalogClasses.includes(ids.classC), 'catalog covers the school directory');
    check(
      !JSON.stringify(await run(teacherA.token, 'list_classes', { catalog: true })).includes('children'),
      'catalog carries no roster',
    );

    /* ------------------------------ 班级详情/名单/历史 ------------------------------ */

    const classBundle = dataOf<{
      class: { id: string };
      children: Array<{ child_id: string }>;
      history: { enrollment_count: number; observation_count: number };
    }>(await run(teacherA.token, 'get_class', { class_id: ids.classA }));
    check(classBundle.class.id === ids.classA, 'class detail returns the class');
    assert.deepEqual(classBundle.children.map((child) => child.child_id), [ids.childA]);
    passed += 1;
    check(
      classBundle.history.enrollment_count === 2 && classBundle.history.observation_count === 2,
      'class detail returns real history counts',
    );
    const crossClass = await run(teacherA.token, 'get_class', { class_id: ids.classB });
    check(!crossClass.ok && crossClass.code === 'out_of_scope', 'teacher cannot read another class');
    const missingClass = await run(teacherA.token, 'get_class', { class_id: randomUUID() });
    check(!missingClass.ok && missingClass.code === 'out_of_scope', 'scope denial precedes existence disclosure');
    check((await run(admin.token, 'get_class', { class_id: ids.classB })).ok, 'admin reads any class');

    const emptyClass = dataOf<{ children: unknown[]; history: { observation_count: number } }>(
      await run(teacherC.token, 'get_class', { class_id: ids.classC }),
    );
    check(emptyClass.children.length === 0 && emptyClass.history.observation_count === 0, 'real empty class stays ok');

    /* ------------------------------ 指定日期归属 ------------------------------ */

    const resolved = dataOf<{ status: string; class: { id: string } | null }>(
      await run(teacherB.token, 'resolve_child_class', { child_id: ids.moved, observed_at: '2025-10-01' }),
    );
    check(resolved.status === 'resolved' && resolved.class?.id === ids.classA, 'historical attribution resolves to the original class');
    const noAttribution = dataOf<{ status: string; reason: string | null; class: unknown }>(
      await run(teacherB.token, 'resolve_child_class', { child_id: ids.moved, observed_at: '2024-01-01' }),
    );
    check(
      noAttribution.status === 'needs_confirmation' && noAttribution.reason === 'no_attribution' && noAttribution.class === null,
      'missing attribution is not guessed',
    );
    const formerTeacher = await run(teacherA.token, 'resolve_child_class', { child_id: ids.moved, observed_at: '2025-10-01' });
    check(!formerTeacher.ok && formerTeacher.code === 'out_of_scope', 'former teacher cannot read the transferred child');

    /* ------------------------------ 观察列表/详情与历史投影 ------------------------------ */

    const fullDetail = payloadOf(await run(teacherA.token, 'get_observation', { observation_id: ids.obsA }));
    const fullData = fullDetail.data as {
      observation: { access_projection: string; guide_evidence: unknown; raw_text: string };
    };
    check(fullData.observation.access_projection === 'full', 'current teacher reads a full observation');
    check(fullData.observation.guide_evidence !== null, 'full observation keeps guide evidence');
    check(fullData.observation.raw_text.includes('幼儿把积木放在一起'), 'full observation keeps raw text');

    const historicalDetail = payloadOf(await run(teacherA.token, 'get_observation', { observation_id: ids.obsMovedOld }));
    const historicalData = historicalDetail.data as {
      observation: {
        access_projection: string;
        can_write: boolean;
        guide_evidence: unknown;
        agent_context: unknown;
        ai_draft: unknown;
      };
    };
    check(historicalData.observation.access_projection === 'historical_read_only', 'former teacher gets the historical projection');
    check(historicalData.observation.can_write === false, 'historical projection cannot write');
    check(
      historicalData.observation.guide_evidence === null &&
        historicalData.observation.agent_context === null &&
        historicalData.observation.ai_draft === null,
      'historical projection strips cross-class details',
    );
    check(!JSON.stringify(historicalDetail.data).includes('must-not-leak'), 'historical projection leaks no private workflow data');

    const currentTeacherDetail = dataOf<{ observation: { access_projection: string; can_write: boolean; agent_context: unknown } }>(
      await run(teacherB.token, 'get_observation', { observation_id: ids.obsMovedOld }),
    );
    check(
      currentTeacherDetail.observation.access_projection === 'full' && currentTeacherDetail.observation.can_write,
      'current teacher reads the complete record',
    );
    check(currentTeacherDetail.observation.agent_context !== null, 'full record keeps workflow context for the current teacher');

    const observationList = dataOf<{ observations: Array<{ observation_id: string; access_projection: string }> }>(
      await run(teacherA.token, 'list_observations'),
    ).observations;
    check(
      observationList.some((entry) => entry.observation_id === ids.obsA && entry.access_projection === 'full'),
      'observation list includes the current-class record as full',
    );
    check(
      observationList.some((entry) => entry.observation_id === ids.obsMovedOld && entry.access_projection === 'historical_read_only'),
      'observation list includes the original-class record as historical',
    );
    check(!observationList.some((entry) => entry.observation_id === ids.obsB), 'observation list excludes other classes');

    /* ------------------------------ 成长档案与活动支持 ------------------------------ */

    const profile = dataOf<{
      growth_profile: { source: string; basis_observation_ids: string[] } | null;
      activity_support: { source: string } | null;
    }>(await run(teacherA.token, 'get_child_growth_profile', { child_id: ids.childA }));
    check(profile.growth_profile?.source === 'fallback', 'fallback profile is labelled');
    check(profile.activity_support?.source === 'ai_summary', 'activity support is labelled as AI summary');
    check(profile.growth_profile?.basis_observation_ids.includes(ids.obsA) === true, 'profile keeps its basis observations');
    const profileDenied = await run(teacherA.token, 'get_child_growth_profile', { child_id: ids.childB });
    check(!profileDenied.ok && profileDenied.code === 'out_of_scope', 'profile read is scoped');

    /* ------------------------------ 证据册/班级概览 ------------------------------ */

    const book = payloadOf(await run(teacherA.token, 'get_child_evidence_book', { child_id: ids.childA, scope: 'all_history' }));
    const bookData = dataOf<{
      evidence_book: { status_counts: { has_clues: number }; roster?: unknown };
    }>(await run(teacherA.token, 'get_child_evidence_book', { child_id: ids.childA, scope: 'all_history' }));
    check(bookData.evidence_book.status_counts.has_clues >= 1, 'evidence book counts the confirmed clue');
    const bookRefs = book.source_refs.map((entry) => entry.ref_id);
    check(bookRefs.includes(`child:${ids.childA}`), 'evidence book keeps the child dependency');
    check(bookRefs.includes(`observation:${ids.obsA}`), 'evidence book keeps the observation dependency');
    check(bookRefs.includes(`guide_item:${item.id}`), 'evidence book keeps the guide item dependency');
    check(!JSON.stringify(book.data).includes('"catalog":'), 'evidence book does not duplicate the static catalog');
    const bookDenied = await run(teacherA.token, 'get_child_evidence_book', { child_id: ids.childB });
    check(!bookDenied.ok && bookDenied.code === 'out_of_scope', 'evidence book read is scoped');

    const overview = payloadOf(await run(teacherA.token, 'get_class_evidence_overview', { class_id: ids.classA, scope: 'all_history' }));
    const overviewData = dataOf<{ evidence_overview: { roster: { child_count: number } } }>(
      await run(teacherA.token, 'get_class_evidence_overview', { class_id: ids.classA, scope: 'all_history' }),
    );
    check(overviewData.evidence_overview.roster.child_count === 1, 'class overview denominator is the current roster');
    const overviewRefs = overview.source_refs.map((entry) => entry.ref_id);
    check(overviewRefs.includes(`class:${ids.classA}`), 'class overview keeps the class dependency');
    check(overviewRefs.includes(`child:${ids.childA}`), 'class overview keeps the roster dependency');
    const overviewDenied = await run(teacherA.token, 'get_class_evidence_overview', { class_id: ids.classB });
    check(!overviewDenied.ok && overviewDenied.code === 'out_of_scope', 'class overview read is scoped');

    /* ------------------------------ 静态教育参考 ------------------------------ */

    const guideForUnassigned = await run(emptyTeacher.token, 'list_guide_items');
    check(guideForUnassigned.ok, 'unassigned but valid account reads static reference');
    const guideAnonymous = await run(null, 'list_guide_items');
    check(!guideAnonymous.ok && guideAnonymous.code === 'unauthenticated', 'static reference still requires login');
    const guideDetail = payloadOf(await run(emptyTeacher.token, 'get_guide_item', { item_id: item.id }));
    check(guideDetail.source_refs[0].kind === 'guide_catalog', 'guide item is catalog provenance');

    /* ------------------------------ 管理员/教师差异 ------------------------------ */

    const teacherListDenied = await run(teacherA.token, 'list_teacher_accounts');
    check(!teacherListDenied.ok && teacherListDenied.code === 'forbidden_role', 'teacher account list denies teachers');
    const adminList = payloadOf(await run(admin.token, 'list_teacher_accounts'));
    check(!JSON.stringify(adminList).includes('password'), 'teacher list carries no secret fields');
    check(
      (adminList.data as { teachers: unknown[] }).teachers.length >= 5,
      'admin list returns the real teacher accounts',
    );

    /* ------------------------------ 撤会话：不缓存 Principal ------------------------------ */

    check((await run(revoked.token, 'list_children')).ok, 'revoked-check account can read before revocation');
    await competitor.query('UPDATE app_sessions SET revoked_at = now() WHERE account_id = $1', [revoked.accountId]);
    const afterRevoke = await run(revoked.token, 'list_children');
    check(!afterRevoke.ok && afterRevoke.code === 'unauthenticated', 'revoked session is rejected without cached identity');

    /* ------------------------------ 撤任教 ------------------------------ */

    check((await run(teacherAB.token, 'get_class', { class_id: ids.classA })).ok, 'assigned teacher reads before unassignment');
    await competitor.query(
      'UPDATE teacher_class_assignments SET removed_at = now() WHERE account_id = $1 AND class_id = $2',
      [teacherAB.accountId, ids.classA],
    );
    const afterUnassign = await run(teacherAB.token, 'get_class', { class_id: ids.classA });
    check(!afterUnassign.ok && afterUnassign.code === 'out_of_scope', 'unassigned class is out_of_scope');
    const afterUnassignChildren = dataOf<{ children: Array<{ child_id: string }> }>(
      await run(teacherAB.token, 'list_children'),
    ).children.map((child) => child.child_id);
    check(
      !afterUnassignChildren.includes(ids.childA) && afterUnassignChildren.includes(ids.childB),
      'unassignment shrinks the list without turning it into an error or the whole school',
    );

    /* ------------------------------ 转班读取 ------------------------------ */

    await competitor.query(
      "UPDATE child_class_enrollments SET end_date = '2026-10-05' WHERE child_id = $1 AND end_date IS NULL",
      [ids.childA],
    );
    await competitor.query(
      "INSERT INTO child_class_enrollments (child_id,class_id,start_date) VALUES ($1,$2,'2026-10-06')",
      [ids.childA, ids.classB],
    );
    const formerProfile = await run(teacherA.token, 'get_child_growth_profile', { child_id: ids.childA });
    check(!formerProfile.ok && formerProfile.code === 'out_of_scope', 'former teacher loses current-responsibility reads after transfer');
    const formerObservation = dataOf<{ observation: { access_projection: string } }>(
      await run(teacherA.token, 'get_observation', { observation_id: ids.obsA }),
    );
    check(formerObservation.observation.access_projection === 'historical_read_only', 'former teacher keeps historical read-only access');
    const newTeacherChildren = dataOf<{ children: Array<{ child_id: string }> }>(
      await run(teacherB.token, 'list_children'),
    ).children.map((child) => child.child_id);
    check(newTeacherChildren.includes(ids.childA), 'new teacher reads the transferred child');
    check((await run(teacherB.token, 'get_child_growth_profile', { child_id: ids.childA })).ok, 'new teacher reads the profile');
    const emptiedClass = dataOf<{ children: unknown[] }>(
      await run(teacherA.token, 'get_class', { class_id: ids.classA }),
    );
    check(emptiedClass.children.length === 0, 'transferred roster becomes a real empty list, not an error');

    check(guard.hits === 0, 'zero provider network requests');
  } catch (error) {
    failure = error;
  } finally {
    await runCleanupSteps(
      [
        { label: 'competitor', run: async () => { await competitor?.end(); } },
        { label: 'fixture-client', run: async () => { await db?.end(); } },
        { label: 'owned-pool', run: async () => { await globalThis.__pgPool?.end(); } },
        { label: 'owned-container', run: () => isolated?.teardown() ?? { ok: true, detail: 'not created' } },
        { label: 'model-guard', run: () => guard.close() },
      ],
      (label, detail) => cleanupIssues.push(`${label}: ${detail}`),
    );
  }
  assertCleanupComplete(cleanupIssues);
  if (failure) throw failure;
  console.log(
    JSON.stringify({
      passed,
      total: passed,
      database: 'unique owned isolated PostgreSQL; immutable harness',
      auth_chain: 'real AUTH sessions/scoped reads through registry.dispatch',
      real_model_requests: guard.hits,
      cleanup: 'verified',
      NOT_RUN: ['real LLM/provider/search/S3', 'hosted DB', 'Next HTTP/browser', 'deployment/security certification'],
    }),
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'tools read db check failed');
  process.exitCode = 1;
});
