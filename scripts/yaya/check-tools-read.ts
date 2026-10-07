import assert from 'node:assert/strict';

import { AccountsError } from '../../src/lib/accounts/errors';
import type { Principal, TeacherAccountSummary } from '../../src/lib/accounts/types';
import { projectObservation } from '../../src/lib/accounts/scoped-queries';
import type { ScopedObservation } from '../../src/lib/accounts/scoped-queries';
import { listEducationSuggestions, listGuideItems } from '../../src/lib/guide/catalog';
import {
  buildChildEvidenceBook,
  buildClassEvidenceOverview,
  parseEvidenceFilters,
} from '../../src/lib/guide/read-model';
import type { EvidenceLoadResult } from '../../src/lib/guide/read-model';
import type { ClassEvidenceOverview, ChildEvidenceBook } from '../../src/lib/guide/view-types';
import { GUIDE_CATALOG_VERSION } from '../../src/lib/guide/types';
import { resolveEvidenceScope } from '../../src/lib/semester';
import type { Child, Observation, ObservationDraft, SchoolClass } from '../../src/lib/types';
import { runYayaAgent } from '../../src/lib/yaya/agent/engine';
import type { YayaAgentDependencies, YayaCurrentIdentity } from '../../src/lib/yaya/agent/types';
import type { YayaSourceRef } from '../../src/lib/yaya/types';
import { createYayaReadRegistry } from '../../src/lib/yaya/tools/read/registry';
import type {
  YayaChildClassContext,
  YayaChildProfileRecord,
  YayaClassBundle,
  YayaReadPayload,
  YayaReadPorts,
} from '../../src/lib/yaya/tools/read/types';

/**
 * TOOLS-READ1 离线检查：真实 registry/dispatcher + 替身端口。
 * 不连数据库、不读 .env、不调用模型、不发网络请求。
 * 覆盖：白名单/参数非法、目录与业务范围区分、空范围、历史投影、管理员/教师差异、
 * 失败与空态、聚合来源依赖、Zod 描述与校验同源。
 */

let passed = 0;
function check(condition: unknown, label: string): void {
  assert.ok(condition, label);
  passed += 1;
}

const CLASS_A = '11111111-1111-4111-8111-111111111111';
const CLASS_B = '22222222-2222-4222-8222-222222222222';
const CHILD_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHILD_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OBS_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OBS_B = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const TEACHER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const T0 = '2026-09-10T02:00:00.000Z';

function makeClass(id: string, name: string): SchoolClass {
  return {
    id,
    name,
    stage: 'small',
    school_year: '2026-2027',
    is_active: true,
    is_demo: false,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: null,
  };
}

function makeChild(id: string, name: string, classId: string | null): Child {
  return {
    id,
    name,
    gender: '女',
    birth_date: '2022-01-01',
    class_name: classId === null ? '' : `班级-${classId}`,
    class_id: classId,
    current_class: classId === null ? null : makeClass(classId, `班级-${classId}`),
    class_stage: classId === null ? null : 'small',
    class_school_year: classId === null ? null : '2026-2027',
    avatar_emoji: null,
    note: '教师私有备注，不应出现在列表工具结果',
    growth_profile: null,
    is_demo: false,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: null,
  };
}

const draft: ObservationDraft = {
  domain: '科学',
  sub_domain: '科学探究',
  objective_description: '幼儿把积木放在一起。',
  highlights: ['幼儿把积木放在一起。'],
  support_suggestions: ['继续观察摆放过程。'],
  highlight_quote: '把积木放在一起',
};

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: OBS_A,
    child_id: CHILD_A,
    class_id: CLASS_A,
    observed_class: makeClass(CLASS_A, '班级-A'),
    observed_at: '2026-09-10',
    context: '区域活动',
    raw_text: '幼儿把积木放在一起。',
    status: 'ai_organized',
    agent_context: { follow_up: { round: 1, question: 'q', reason: 'r', answers: [], stopped: false } },
    ai_draft: draft,
    ai_model: 'offline-substitute',
    ai_organized_at: T0,
    confirmed_content: null,
    confirmed_at: null,
    class_context_snapshot: null,
    guide_evidence: { revision: 1, links: [] },
    is_demo: false,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

function scoped(observation: Observation, projection: 'full' | 'historical_read_only'): ScopedObservation {
  return { ...observation, access_projection: projection, can_write: projection === 'full' };
}

const principal: Principal = {
  account_id: 'acct-teacher',
  username: 'teacher',
  display_name: '教师',
  role: 'teacher',
  account_status: 'active',
  scope: { kind: 'classes', class_ids: [CLASS_A] },
};
const unassignedPrincipal: Principal = {
  account_id: 'acct-unassigned',
  username: 'unassigned',
  display_name: '未分配教师',
  role: 'teacher',
  account_status: 'active',
  scope: { kind: 'classes', class_ids: [] },
};

const fullObservation = scoped(makeObservation(), 'full');
/** 历史只读用真实投影函数生成（与 scoped-queries 相同口径），不是手改标记 */
const historicalObservation = projectObservation(
  makeObservation({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }),
  'historical_read_only',
  principal,
);

interface FakeState {
  children: Child[];
  classes: { business: SchoolClass[]; catalog: SchoolClass[] };
  classBundle: YayaClassBundle | null;
  childClass: YayaChildClassContext | null;
  observations: ScopedObservation[];
  observation: ScopedObservation | null;
  profile: YayaChildProfileRecord | null;
  book: EvidenceLoadResult<ChildEvidenceBook>;
  overview: EvidenceLoadResult<ClassEvidenceOverview>;
  teachers: TeacherAccountSummary[];
  referencePrincipal: Principal | null;
  errors: Record<string, unknown>;
  calls: string[];
  classInputs: boolean[];
}

function makeFakeState(): FakeState {
  return {
    children: [makeChild(CHILD_A, '幼儿甲', CLASS_A)],
    classes: { business: [makeClass(CLASS_A, '班级-A')], catalog: [makeClass(CLASS_A, '班级-A'), makeClass(CLASS_B, '班级-B')] },
    classBundle: { klass: makeClass(CLASS_A, '班级-A'), children: [makeChild(CHILD_A, '幼儿甲', CLASS_A)], history: { enrollment_count: 2, observation_count: 3 } },
    childClass: {
      child: makeChild(CHILD_A, '幼儿甲', CLASS_A),
      lookup: { status: 'resolved', reason: null, enrollment_id: 'enr-1', class: makeClass(CLASS_A, '班级-A'), candidates: [] },
    },
    observations: [fullObservation, historicalObservation],
    observation: fullObservation,
    profile: null,
    book: { ok: true, value: buildChildEvidenceBookFixture() },
    overview: { ok: true, value: buildClassOverviewFixture() },
    teachers: [
      {
        account_id: TEACHER_ID,
        username: 'teacher-a',
        display_name: '教师甲',
        role: 'teacher',
        status: 'active',
        class_ids: [CLASS_A],
        created_at: T0,
        updated_at: null,
      },
    ],
    referencePrincipal: unassignedPrincipal,
    errors: {},
    calls: [],
    classInputs: [],
  };
}

function guideFixture() {
  const item = listGuideItemsSync()[0];
  assert.ok(item, 'catalog must provide at least one item');
  const observation: Observation = makeObservation({
    status: 'confirmed',
    confirmed_content: draft,
    confirmed_at: T0,
    guide_evidence: {
      revision: 1,
      links: [
        {
          id: 'link-1',
          item_id: item.id,
          catalog_version: GUIDE_CATALOG_VERSION,
          origin: 'manual',
          status: 'confirmed_clue',
          support: 'clue_only',
          adult_help_used: false,
          basis: [
            {
              observation_id: OBS_A,
              observed_at: '2026-09-10',
              quote: '把积木放在一起',
              quote_source: 'raw_text',
              quote_field: null,
              class_context: {
                class_id: CLASS_A,
                class_name: '班级-A',
                stage: 'small',
                school_year: '2026-2027',
                captured_at: T0,
                source: 'enrollment_lookup',
                enrollment_id: 'enr-1',
                confirmed_at: null,
              },
              source_confirmed_at: T0,
            },
          ],
          ai_reason: null,
          teacher_note: null,
          revision: 1,
          created_at: T0,
          decided_at: T0,
          withdrawn_at: null,
          withdrawn_reason: null,
        },
      ],
    },
  });
  return { item, observation };
}

let catalogCache: Awaited<ReturnType<typeof listGuideItems>> | null = null;
function listGuideItemsSync() {
  if (catalogCache === null) throw new Error('catalog not loaded');
  return catalogCache;
}

function buildChildEvidenceBookFixture(): ChildEvidenceBook {
  const { observation } = guideFixture();
  const scope = resolveEvidenceScope({ scope: 'all_history' });
  assert.ok(scope.ok, 'all_history scope must resolve');
  const filters = parseEvidenceFilters({});
  assert.ok(filters.ok, 'empty filters must parse');
  return buildChildEvidenceBook({
    child: makeChild(CHILD_A, '幼儿甲', CLASS_A),
    observations: [observation],
    scope: scope.scope,
    filters: filters.filters,
  });
}

function buildClassOverviewFixture(): ClassEvidenceOverview {
  const { observation } = guideFixture();
  const scope = resolveEvidenceScope({ scope: 'all_history' });
  assert.ok(scope.ok, 'all_history scope must resolve');
  const filters = parseEvidenceFilters({});
  assert.ok(filters.ok, 'empty filters must parse');
  const child = makeChild(CHILD_A, '幼儿甲', CLASS_A);
  return buildClassEvidenceOverview({
    klass: makeClass(CLASS_A, '班级-A'),
    roster: [child],
    observationsByChild: new Map([[child.id, [observation]]]),
    scope: scope.scope,
    filters: filters.filters,
  });
}

function makeFakePorts(state: FakeState): YayaReadPorts {
  const fail = (key: string): void => {
    const error = state.errors[key];
    if (error !== undefined) throw error;
  };
  return {
    listChildren: async () => {
      state.calls.push('listChildren');
      fail('children');
      return state.children;
    },
    listClasses: async (input) => {
      state.calls.push('listClasses');
      state.classInputs.push(input.catalog);
      fail('classes');
      return input.catalog ? state.classes.catalog : state.classes.business;
    },
    getClassBundle: async () => {
      state.calls.push('getClassBundle');
      fail('classBundle');
      return state.classBundle;
    },
    resolveChildClass: async () => {
      state.calls.push('resolveChildClass');
      fail('childClass');
      return state.childClass;
    },
    listObservations: async () => {
      state.calls.push('listObservations');
      fail('observations');
      return state.observations;
    },
    getObservation: async () => {
      state.calls.push('getObservation');
      fail('observation');
      return state.observation;
    },
    getChildProfile: async () => {
      state.calls.push('getChildProfile');
      fail('profile');
      return state.profile;
    },
    loadChildEvidenceBook: async () => {
      state.calls.push('loadChildEvidenceBook');
      fail('book');
      return state.book;
    },
    loadClassEvidenceOverview: async () => {
      state.calls.push('loadClassEvidenceOverview');
      fail('overview');
      return state.overview;
    },
    listTeacherAccounts: async () => {
      state.calls.push('listTeacherAccounts');
      fail('teachers');
      return state.teachers;
    },
    requireReferenceAccess: async () => {
      state.calls.push('requireReferenceAccess');
      fail('reference');
      if (state.referencePrincipal === null) {
        throw new AccountsError('unauthenticated', '请先登录园所账号。');
      }
      return state.referencePrincipal;
    },
  };
}

function payloadOf(outcome: Awaited<ReturnType<ReturnType<typeof createYayaReadRegistry>['dispatch']>>): YayaReadPayload<unknown> {
  assert.ok(outcome.ok, 'expected ok outcome');
  return outcome.data as YayaReadPayload<unknown>;
}

const identity: YayaCurrentIdentity = {
  run_id: 'offline-run',
  identity_state: 'authenticated',
  principal: unassignedPrincipal,
  session_valid: true,
};

async function main(): Promise<void> {
  catalogCache = await listGuideItems();
  let suggestionGoal: string | null = null;
  for (const item of catalogCache) {
    if ((await listEducationSuggestions(item.goal_id)).length > 0) {
      suggestionGoal = item.goal_id;
      break;
    }
  }
  assert.ok(suggestionGoal, 'catalog must have at least one goal with education suggestions');
  const expectedTools = [
    'get_child_evidence_book',
    'get_child_growth_profile',
    'get_class',
    'get_class_evidence_overview',
    'get_guide_item',
    'get_observation',
    'list_children',
    'list_classes',
    'list_education_suggestions',
    'list_guide_items',
    'list_observations',
    'list_teacher_accounts',
    'resolve_child_class',
  ];

  /* ------------------------------ 定义与协议同源 ------------------------------ */

  const state = makeFakeState();
  const registry = createYayaReadRegistry({ ports: makeFakePorts(state) });
  const names = registry.definitions.map((definition) => definition.tool);
  assert.deepEqual([...names].sort(), expectedTools);
  passed += 1;
  check(new Set(names).size === names.length, 'tool names are unique');
  check(
    registry.definitions.every((definition) => definition.description.trim().length > 0),
    'every tool has a non-empty description',
  );
  check(
    registry.definitions.every((definition) => definition.public_search !== true),
    'no public search tool is registered',
  );
  for (const definition of registry.definitions) {
    const described = definition.params.describe().json_schema as Record<string, unknown>;
    check(
      typeof described === 'object' && described !== null && Object.keys(described).length > 0,
      `${definition.tool}: params JSON Schema is non-empty`,
    );
  }
  const guideDefinitions = registry.registrations.filter(
    (entry) => entry.definition.scope_policy === 'authenticated_reference',
  );
  assert.deepEqual(
    guideDefinitions.map((entry) => entry.definition.tool).sort(),
    ['get_guide_item', 'list_education_suggestions', 'list_guide_items'],
  );
  passed += 1;
  check(
    registry.registrations
      .filter((entry) => entry.definition.scope_policy === 'business_scope')
      .every((entry) => entry.auth.kind === 'scope_query' || entry.auth.kind === 'action'),
    'business tools declare scope_query or AUTH action dependencies',
  );

  const observationDefinition = registry.definitions.find(
    (definition) => definition.tool === 'get_observation',
  );
  assert.ok(observationDefinition, 'get_observation is registered');
  const observationSchema = observationDefinition.params.describe().json_schema as Record<string, unknown>;
  assert.deepEqual(observationSchema.required, ['observation_id']);
  check(observationSchema.additionalProperties === false, 'get_observation schema is strict');
  check(!observationDefinition.params.validate({}).ok, 'get_observation rejects missing observation_id');
  check(observationDefinition.params.validate({ observation_id: OBS_A }).ok, 'get_observation accepts valid params');
  check(
    !observationDefinition.params.validate({ observation_id: OBS_A, extra: 1 }).ok,
    'get_observation rejects unknown fields',
  );

  const listClassesDefinition = registry.definitions.find(
    (definition) => definition.tool === 'list_classes',
  );
  assert.ok(listClassesDefinition, 'list_classes is registered');
  check(!listClassesDefinition.params.validate({ catalog: 'yes' }).ok, 'list_classes rejects wrong type');
  check(listClassesDefinition.params.validate({}).ok, 'list_classes accepts empty params');

  const listChildrenDefinition = registry.definitions.find(
    (definition) => definition.tool === 'list_children',
  );
  assert.ok(listChildrenDefinition, 'list_children is registered');
  check(listChildrenDefinition.params.validate({}).ok, 'list_children accepts empty params');
  check(!listChildrenDefinition.params.validate({ extra: 1 }).ok, 'list_children rejects unknown fields');

  const childClassDefinition = registry.definitions.find(
    (definition) => definition.tool === 'resolve_child_class',
  );
  assert.ok(childClassDefinition, 'resolve_child_class is registered');
  check(
    !childClassDefinition.params.validate({ child_id: CHILD_A, observed_at: '2025-02-29' }).ok,
    'resolve_child_class rejects impossible calendar dates',
  );
  check(
    childClassDefinition.params.validate({ child_id: CHILD_A, observed_at: '2024-02-29' }).ok,
    'resolve_child_class accepts real leap dates',
  );

  const listObservationsDefinition = registry.definitions.find(
    (definition) => definition.tool === 'list_observations',
  );
  assert.ok(listObservationsDefinition, 'list_observations is registered');
  check(!listObservationsDefinition.params.validate({ status: 'bogus' }).ok, 'list_observations rejects unknown status');
  check(!listObservationsDefinition.params.validate({ limit: 0 }).ok, 'list_observations rejects limit 0');
  check(!listObservationsDefinition.params.validate({ limit: 1001 }).ok, 'list_observations rejects limit above 1000');
  check(listObservationsDefinition.params.validate({ limit: 50 }).ok, 'list_observations accepts limit 50');

  const guideListDefinition = registry.definitions.find(
    (definition) => definition.tool === 'list_guide_items',
  );
  assert.ok(guideListDefinition, 'list_guide_items is registered');
  check(!guideListDefinition.params.validate({ domain_code: 'unknown' }).ok, 'guide list rejects unknown domain');

  /* ------------------------------ dispatcher 白名单/参数 ------------------------------ */

  const unknown = await registry.dispatch({ tool: 'run_sql', params: {} });
  check(!unknown.ok && unknown.code === 'denied', 'unknown tool is denied');
  check(!('data' in unknown), 'unknown tool returns no data');

  state.calls.length = 0;
  const invalid = await registry.dispatch({ tool: 'get_observation', params: {} });
  check(!invalid.ok && invalid.code === 'failed', 'invalid params fail without touching services');
  check(state.calls.length === 0, 'invalid params never reach the read ports');

  /* ------------------------------ 业务范围读取 ------------------------------ */

  const children = payloadOf(await registry.dispatch({ tool: 'list_children', params: {} }));
  const childData = children.data as { children: Array<Record<string, unknown>> };
  check(childData.children.length === 1 && childData.children[0].child_id === CHILD_A, 'list_children returns scoped child');
  check(!JSON.stringify(children).includes('教师私有备注'), 'list_children omits teacher-private note');
  check(!JSON.stringify(children).includes('growth_profile'), 'list_children omits growth profile');
  check(children.scope_policy === 'business_scope', 'list_children is business scope');

  state.children = [];
  const emptyChildren = await registry.dispatch({ tool: 'list_children', params: {} });
  check(emptyChildren.ok && (emptyChildren.data as YayaReadPayload<{ children: unknown[] }>).data.children.length === 0, 'real empty list stays ok');
  state.children = [makeChild(CHILD_A, '幼儿甲', CLASS_A)];

  state.errors.children = new AccountsError('empty_scope', '尚未分配任教班级。');
  const emptyScope = await registry.dispatch({ tool: 'list_children', params: {} });
  check(!emptyScope.ok && emptyScope.code === 'empty_scope', 'empty scope is an explicit failure, not an empty list');
  check(!('data' in emptyScope), 'empty scope returns no fabricated data');
  state.errors.children = new AccountsError('unauthenticated', '请先登录园所账号。');
  const unauthenticated = await registry.dispatch({ tool: 'list_children', params: {} });
  check(!unauthenticated.ok && unauthenticated.code === 'unauthenticated', 'unauthenticated maps to unauthenticated');
  state.errors.children = new AccountsError('identity_unavailable', '身份服务暂时不可用。');
  const unavailable = await registry.dispatch({ tool: 'list_children', params: {} });
  check(!unavailable.ok && unavailable.code === 'identity_unavailable', 'identity service failure stays distinct');
  state.errors.children = new Error('database exploded');
  const failed = await registry.dispatch({ tool: 'list_children', params: {} });
  check(!failed.ok && failed.code === 'failed', 'unexpected read failure maps to failed');
  delete state.errors.children;

  /* ------------------------------ 目录与业务范围区分 ------------------------------ */

  state.classInputs.length = 0;
  const businessClasses = payloadOf(await registry.dispatch({ tool: 'list_classes', params: {} }));
  check((businessClasses.data as { catalog: boolean }).catalog === false, 'list_classes defaults to assigned classes');
  check((businessClasses.data as { classes: SchoolClass[] }).classes.length === 1, 'assigned list has one class');
  const catalogClasses = payloadOf(await registry.dispatch({ tool: 'list_classes', params: { catalog: true } }));
  check((catalogClasses.data as { classes: SchoolClass[] }).classes.length === 2, 'catalog includes the school directory');
  check(!JSON.stringify(catalogClasses.data).includes('children'), 'catalog carries no roster');
  assert.deepEqual(state.classInputs, [false, true]);
  passed += 1;

  /* ------------------------------ 班级/归属/观察 ------------------------------ */

  const classBundle = payloadOf(await registry.dispatch({ tool: 'get_class', params: { class_id: CLASS_A } }));
  const bundleData = classBundle.data as { class: SchoolClass; children: unknown[]; history: { observation_count: number } };
  check(bundleData.class.id === CLASS_A && bundleData.children.length === 1, 'get_class returns class and roster');
  check(bundleData.history.observation_count === 3, 'get_class returns real history counts');
  state.classBundle = null;
  const missingClass = await registry.dispatch({ tool: 'get_class', params: { class_id: CLASS_A } });
  check(!missingClass.ok && missingClass.code === 'not_found', 'missing class maps to not_found');
  state.classBundle = { klass: makeClass(CLASS_A, '班级-A'), children: [makeChild(CHILD_A, '幼儿甲', CLASS_A)], history: { enrollment_count: 2, observation_count: 3 } };

  const resolved = payloadOf(await registry.dispatch({ tool: 'resolve_child_class', params: { child_id: CHILD_A, observed_at: '2026-09-10' } }));
  check((resolved.data as { status: string }).status === 'resolved', 'resolve_child_class resolves a unique attribution');
  state.childClass = {
    child: makeChild(CHILD_A, '幼儿甲', CLASS_A),
    lookup: {
      status: 'needs_confirmation',
      reason: 'overlapping_attribution',
      enrollment_id: null,
      class: null,
      candidates: [
        { enrollment_id: 'e1', class_id: CLASS_A, class_name: '班级-A', stage: 'small', school_year: '2026-2027', start_date: '2026-09-01', end_date: null },
        { enrollment_id: 'e2', class_id: CLASS_B, class_name: '班级-B', stage: 'small', school_year: '2026-2027', start_date: '2026-09-01', end_date: null },
      ],
    },
  };
  const ambiguous = payloadOf(await registry.dispatch({ tool: 'resolve_child_class', params: { child_id: CHILD_A, observed_at: '2026-09-10' } }));
  const ambiguousData = ambiguous.data as { status: string; class: unknown; candidates: unknown[] };
  check(ambiguousData.status === 'needs_confirmation' && ambiguousData.class === null, 'ambiguous attribution is not auto-picked');
  check(ambiguousData.candidates.length === 2, 'ambiguous attribution returns readable candidates');

  const observationList = payloadOf(await registry.dispatch({ tool: 'list_observations', params: {} }));
  const listData = observationList.data as { observations: Array<Record<string, unknown>> };
  check(listData.observations.length === 2, 'list_observations returns index entries');
  check(!JSON.stringify(listData).includes('幼儿把积木放在一起'), 'list_observations does not forward raw text');
  check(
    listData.observations.some((entry) => entry.access_projection === 'historical_read_only'),
    'list_observations preserves the historical projection marker',
  );

  const detail = payloadOf(await registry.dispatch({ tool: 'get_observation', params: { observation_id: OBS_A } }));
  check(JSON.stringify(detail.data).includes('幼儿把积木放在一起'), 'get_observation returns full raw text for a readable record');
  check(detail.citable_source.kind === 'tool_result', 'observation envelope is tool_result, not child_fact');
  check(detail.citable_source.ref_id === `observation:${OBS_A}`, 'observation citable source is the record');
  const detailData = detail.data as {
    content_sources: {
      raw_text: { kind: string; label: string | null } | null;
      confirmed_content: { kind: string } | null;
      ai_draft: { kind: string } | null;
      workflow: { kind: string } | null;
      guide_evidence: { kind: string } | null;
    };
    formal_evidence_eligible: boolean;
  };
  check(detailData.content_sources.raw_text?.kind === 'child_fact', 'saved raw text carries child_fact semantics');
  check(detailData.content_sources.ai_draft?.kind === 'model_text', 'AI draft carries model_text semantics');
  check(detailData.content_sources.workflow?.kind === 'tool_result', 'workflow context is platform data');
  check(detailData.content_sources.guide_evidence?.kind === 'tool_result', 'guide evidence ledger is platform data');
  check(detailData.formal_evidence_eligible === false, 'ai_organized observation is not formal evidence');

  for (const fixture of [
    { status: 'draft', eligible: false, label: '未经确认' },
    { status: 'needs_input', eligible: false, label: '未经确认' },
    { status: 'ai_organized', eligible: false, label: '未经确认' },
    { status: 'confirmed', eligible: true, label: '已确认' },
  ] as const) {
    state.observation = scoped(
      makeObservation({
        status: fixture.status,
        confirmed_content: fixture.status === 'confirmed' ? draft : null,
        confirmed_at: fixture.status === 'confirmed' ? T0 : null,
      }),
      'full',
    );
    const fixturePayload = payloadOf(
      await registry.dispatch({ tool: 'get_observation', params: { observation_id: OBS_A } }),
    );
    const fixtureData = fixturePayload.data as {
      content_sources: { raw_text: { label: string | null } | null; confirmed_content: unknown };
      formal_evidence_eligible: boolean;
    };
    check(
      fixtureData.formal_evidence_eligible === fixture.eligible,
      `${fixture.status}: formal evidence eligibility`,
    );
    check(
      fixtureData.content_sources.raw_text?.label?.includes(fixture.label) === true,
      `${fixture.status}: raw text label reflects confirmation state`,
    );
  }

  state.observation = historicalObservation;
  const historicalDetail = payloadOf(await registry.dispatch({ tool: 'get_observation', params: { observation_id: historicalObservation.id } }));
  check(
    historicalDetail.citable_source.label?.includes('原班历史观察') === true,
    'historical detail is labelled',
  );
  const historicalDetailData = historicalDetail.data as {
    content_sources: {
      raw_text: { label: string | null } | null;
      confirmed_content: unknown;
      ai_draft: unknown;
      workflow: unknown;
      guide_evidence: unknown;
    };
    formal_evidence_eligible: boolean;
  };
  check(
    historicalDetailData.content_sources.raw_text?.label?.includes('原班历史') === true &&
      historicalDetailData.content_sources.ai_draft === null &&
      historicalDetailData.content_sources.workflow === null &&
      historicalDetailData.content_sources.guide_evidence === null,
    'historical projection only exposes the read-only raw text source',
  );
  check(historicalDetailData.formal_evidence_eligible === false, 'historical unconfirmed record is not formal evidence');
  state.observation = fullObservation;
  state.observation = null;
  const missingObservation = await registry.dispatch({ tool: 'get_observation', params: { observation_id: OBS_A } });
  check(!missingObservation.ok && missingObservation.code === 'not_found', 'missing observation maps to not_found');
  state.observation = fullObservation;

  /* ------------------------------ 历史投影（真实纯函数） ------------------------------ */

  const projected = projectObservation(makeObservation(), 'historical_read_only', principal);
  check(projected.guide_evidence === null && projected.agent_context === null && projected.ai_draft === null, 'historical projection strips cross-class details');
  check(projected.ai_model === null && projected.ai_organized_at === null, 'historical projection strips model metadata');
  check(projected.access_projection === 'historical_read_only' && projected.can_write === false, 'historical projection is read-only');
  const fullProjected = projectObservation(makeObservation(), 'full', principal);
  check(fullProjected.guide_evidence !== null && fullProjected.ai_draft !== null, 'full projection keeps details');

  /* ------------------------------ 成长档案与活动支持 ------------------------------ */

  state.profile = {
    child: makeChild(CHILD_A, '幼儿甲', CLASS_A),
    growth_profile: {
      summary: 'AI 小结',
      recent_change: '',
      development_clues: [],
      next_support: '',
      next_focus: '',
      // 重复依据 + 缺失依据：去重且不伪造已核验事实
      source_observation_ids: [OBS_A, OBS_A, 'missing-basis-id'],
      ai_model: 'offline-substitute',
      updated_at: T0,
      is_fallback: true,
      activity_support: {
        suggestions: [],
        source_observation_ids: [OBS_B],
        ai_model: 'offline-substitute',
        generated_at: T0,
      },
    },
    activity_support: {
      suggestions: [],
      source_observation_ids: [OBS_B],
      ai_model: 'offline-substitute',
      generated_at: T0,
    },
  };
  const profile = payloadOf(await registry.dispatch({ tool: 'get_child_growth_profile', params: { child_id: CHILD_A } }));
  const profileData = profile.data as {
    growth_profile: { source: string; basis_observation_ids: string[] };
    activity_support: { source: string };
    notes: string[];
    child: Record<string, unknown>;
  };
  check(profileData.growth_profile.source === 'fallback', 'fallback profile is labelled');
  check(profileData.activity_support.source === 'ai_summary', 'activity support is labelled as AI summary');
  check(profileData.growth_profile.basis_observation_ids.includes(OBS_A), 'profile keeps its basis observation ids');
  check(profileData.notes.length > 0, 'AI summary boundary is stated in the payload');
  check(!('note' in profileData.child), 'profile payload omits teacher-private note');

  const profileRefIds = profile.recheck_dependencies.map((entry) => entry.ref_id);
  check(profileRefIds.includes(`child:${CHILD_A}`), 'profile dependencies keep the child');
  check(profileRefIds.includes(`observation:${OBS_A}`), 'profile dependencies include the summary basis observation');
  check(profileRefIds.includes(`observation:${OBS_B}`), 'profile dependencies include the activity-support basis observation');
  check(profileRefIds.includes('observation:missing-basis-id'), 'missing basis stays visible as an unverified dependency');
  check(
    profileRefIds.filter((refId) => refId === `observation:${OBS_A}`).length === 1,
    'duplicate basis observations are deduplicated',
  );
  check(
    profile.recheck_dependencies
      .filter((entry) => entry.ref_id?.startsWith('observation:'))
      .every((entry) => entry.label?.includes('未经本工具核验') === true),
    'basis dependencies are labelled as not verified by this tool',
  );

  // APP 式重核替身：按返回的依赖逐项核当前可读性；撤权依据必须能被识别
  const revokedObservationIds = new Set([OBS_B]);
  const appStyleRecheck = (deps: readonly YayaSourceRef[]) => {
    const denied = deps
      .filter(
        (entry) =>
          entry.ref_id?.startsWith('observation:') === true &&
          revokedObservationIds.has(entry.ref_id.slice('observation:'.length)),
      )
      .map((entry) => entry.ref_id as string);
    return { ok: denied.length === 0, denied };
  };
  check(
    appStyleRecheck(profile.recheck_dependencies).ok === false &&
      appStyleRecheck(profile.recheck_dependencies).denied.includes(`observation:${OBS_B}`),
    'APP-style recheck catches a revoked basis observation from the dependency list',
  );
  check(
    appStyleRecheck([profile.citable_source]).ok === true,
    'rechecking only the child would miss the revoked basis (dependencies are required)',
  );

  /* ------------------------------ 证据册/概览聚合来源 ------------------------------ */

  const book = payloadOf(await registry.dispatch({ tool: 'get_child_evidence_book', params: { child_id: CHILD_A, scope: 'all_history' } }));
  const bookRefs = book.recheck_dependencies.map((entry) => entry.ref_id);
  check(bookRefs.includes(`child:${CHILD_A}`), 'evidence book keeps the child dependency');
  check(bookRefs.includes(`observation:${OBS_A}`), 'evidence book keeps the underlying observation dependency');
  check(bookRefs.some((refId) => refId?.startsWith('guide_item:')), 'evidence book keeps the guide item dependency');
  check(!JSON.stringify(book.data).includes('"catalog":'), 'evidence book does not duplicate the static catalog');
  check(book.citable_source.ref_id === `child:${CHILD_A}`, 'evidence book primary source is the child');
  check(
    book.recheck_dependencies.find((entry) => entry.ref_id === `observation:${OBS_A}`)?.kind === 'child_fact',
    'verified evidence basis keeps child_fact provenance',
  );

  const overview = payloadOf(await registry.dispatch({ tool: 'get_class_evidence_overview', params: { class_id: CLASS_A } }));
  const overviewRefs = overview.recheck_dependencies.map((entry) => entry.ref_id);
  check(overview.citable_source.ref_id === `class:${CLASS_A}`, 'class overview primary source is the class');
  check(overviewRefs.includes(`class:${CLASS_A}`), 'class overview keeps the class dependency');
  check(overviewRefs.includes(`child:${CHILD_A}`), 'class overview keeps the roster dependency');

  state.book = {
    ok: false,
    failure: { status: 404, error: 'not_found', message: '幼儿不存在' },
  };
  const missingBook = await registry.dispatch({ tool: 'get_child_evidence_book', params: { child_id: CHILD_A } });
  check(!missingBook.ok && missingBook.code === 'not_found', 'evidence 404 maps to not_found');
  state.book = {
    ok: false,
    failure: { status: 409, error: 'semester_config_missing', message: '没有覆盖今天的学期' },
  };
  const brokenScope = await registry.dispatch({ tool: 'get_child_evidence_book', params: { child_id: CHILD_A } });
  check(!brokenScope.ok && brokenScope.code === 'failed', 'semester config failure maps to failed, not empty stats');
  state.book = { ok: true, value: buildChildEvidenceBookFixture() };

  /* ------------------------------ 静态教育参考 ------------------------------ */

  state.referencePrincipal = unassignedPrincipal;
  const guideItems = payloadOf(await registry.dispatch({ tool: 'list_guide_items', params: {} }));
  const guideItemsData = guideItems.data as { items: unknown[]; catalog_version: string };
  check(guideItemsData.items.length > 0, 'unassigned but valid account can read static guide items');
  check(guideItemsData.catalog_version === GUIDE_CATALOG_VERSION, 'guide catalog version is exposed');
  check(guideItems.scope_policy === 'authenticated_reference', 'guide items are authenticated reference');
  const realItem = listGuideItemsSync()[0];
  assert.ok(realItem, 'catalog item exists');
  const guideDetail = payloadOf(await registry.dispatch({ tool: 'get_guide_item', params: { item_id: realItem.id } }));
  check(guideDetail.citable_source.kind === 'guide_catalog', 'guide item source is guide_catalog');
  const missingGuide = await registry.dispatch({ tool: 'get_guide_item', params: { item_id: 'no-such-item' } });
  check(!missingGuide.ok && missingGuide.code === 'not_found', 'unknown guide item maps to not_found');
  const suggestions = payloadOf(await registry.dispatch({ tool: 'list_education_suggestions', params: { goal_id: suggestionGoal } }));
  check((suggestions.data as { suggestions: unknown[] }).suggestions.length > 0, 'known goal returns education suggestions');
  const missingGoal = await registry.dispatch({ tool: 'list_education_suggestions', params: { goal_id: 'no-such-goal' } });
  check(!missingGoal.ok && missingGoal.code === 'not_found', 'unknown goal is not_found, not an empty success');
  state.referencePrincipal = null;
  const anonymousGuide = await registry.dispatch({ tool: 'list_guide_items', params: {} });
  check(!anonymousGuide.ok && anonymousGuide.code === 'unauthenticated', 'static reference still requires authentication');
  check(!('data' in anonymousGuide), 'unauthenticated static reference returns no data');
  state.referencePrincipal = unassignedPrincipal;

  /* ------------------------------ 管理员/教师差异 ------------------------------ */

  state.errors.teachers = new AccountsError('forbidden_role', '该接口仅限管理员使用。');
  const teacherList = await registry.dispatch({ tool: 'list_teacher_accounts', params: {} });
  check(!teacherList.ok && teacherList.code === 'forbidden_role', 'teacher account list denies teachers explicitly');
  delete state.errors.teachers;
  const adminList = payloadOf(await registry.dispatch({ tool: 'list_teacher_accounts', params: {} }));
  check((adminList.data as { teachers: unknown[] }).teachers.length === 1, 'admin account list returns redacted summaries');
  check(!JSON.stringify(adminList).includes('password'), 'teacher list carries no secret fields');

  /* ------------------------------ readTool 适配 ------------------------------ */

  const adapted = await registry.readTool({
    run_id: 'offline-run',
    tool: 'list_children',
    params: {},
    identity,
  });
  check(adapted.ok && adapted.source.kind === 'tool_result', 'readTool adapter returns a YayaReadToolOutcome');
  const adaptedPayload = adapted.ok ? (adapted.data as YayaReadPayload<unknown>) : null;
  check(adaptedPayload !== null && adaptedPayload.tool === 'list_children', 'readTool payload carries the tool name');
  check(
    adapted.ok && adapted.source === adaptedPayload?.citable_source,
    'outcome source equals the citable source',
  );
  check(
    adaptedPayload !== null &&
      adaptedPayload.recheck_dependencies[0] === adaptedPayload.citable_source,
    'dependencies start with the citable source',
  );

  /* ---------------------- R1：所有工具的主来源非空且区分依赖 ---------------------- */

  const citationSamples: Array<[string, unknown]> = [
    ['list_children', {}],
    ['list_classes', {}],
    ['get_class', { class_id: CLASS_A }],
    ['resolve_child_class', { child_id: CHILD_A, observed_at: '2026-09-10' }],
    ['list_observations', {}],
    ['get_observation', { observation_id: OBS_A }],
    ['get_child_growth_profile', { child_id: CHILD_A }],
    ['get_child_evidence_book', { child_id: CHILD_A }],
    ['get_class_evidence_overview', { class_id: CLASS_A }],
    ['list_guide_items', {}],
    ['get_guide_item', { item_id: realItem.id }],
    ['list_education_suggestions', { goal_id: suggestionGoal }],
    ['list_teacher_accounts', {}],
  ];
  for (const [tool, params] of citationSamples) {
    const outcome = await registry.dispatch({ tool, params });
    check(outcome.ok, `${tool}: sample dispatch succeeds`);
    if (!outcome.ok) continue;
    const result = outcome.data as YayaReadPayload<unknown>;
    check(
      typeof result.citable_source.ref_id === 'string' && result.citable_source.ref_id.length > 0,
      `${tool}: citable source id is non-empty`,
    );
    check(
      outcome.source.ref_id === result.citable_source.ref_id,
      `${tool}: outcome source is the citable source`,
    );
    check(
      result.recheck_dependencies[0]?.ref_id === result.citable_source.ref_id,
      `${tool}: dependencies start with the citable source`,
    );
  }

  state.children = [];
  const emptyList = payloadOf(await registry.dispatch({ tool: 'list_children', params: {} }));
  check(
    emptyList.citable_source.ref_id === 'children:current_scope',
    'legal empty list keeps a stable citable primary',
  );
  check(
    emptyList.recheck_dependencies.length === 1 &&
      emptyList.recheck_dependencies[0] === emptyList.citable_source,
    'empty list has no fabricated dependencies',
  );
  state.children = [makeChild(CHILD_A, '幼儿甲', CLASS_A)];

  const stableFirst = payloadOf(await registry.dispatch({ tool: 'list_classes', params: {} }));
  const stableSecond = payloadOf(await registry.dispatch({ tool: 'list_classes', params: {} }));
  check(
    stableFirst.citable_source.ref_id === stableSecond.citable_source.ref_id &&
      stableFirst.citable_source.ref_id === 'classes:assigned',
    'list citable ids are stable and meaningful',
  );
  check(
    payloadOf(await registry.dispatch({ tool: 'list_classes', params: { catalog: true } })).citable_source
      .ref_id === 'classes:catalog',
    'catalog list has its own stable citable id',
  );

  /* ---------------------- R1：真实 registry + 引擎引用闭环 ---------------------- */

  const loopIdentity: YayaCurrentIdentity = {
    run_id: 'loop-run',
    identity_state: 'authenticated',
    principal: unassignedPrincipal,
    session_valid: true,
  };
  const carrier = { headers: new Headers() };
  const engineLoop = async (tool: string, params: unknown, citedRef: string) => {
    let modelCalls = 0;
    const deps: YayaAgentDependencies = {
      model: {
        generate: async () => {
          modelCalls += 1;
          return {
            provider: 'in-process-double',
            model: 'double',
            usage: null,
            content: JSON.stringify(
              modelCalls === 1
                ? { action: 'read', content: '', tool, params_json: JSON.stringify(params), source_refs: [] }
                : { action: 'answer', content: '读取结果如下。', tool: '', params_json: '', source_refs: [citedRef] },
            ),
          };
        },
      },
      resolveCurrentIdentity: async ({ run_id }) => ({ ...loopIdentity, run_id }),
      loadProjectedContext: async () => ({ history: [], sources: [], images: [], guide_catalog: null }),
      revalidateProjectedContext: async () => ({ ok: true }),
      readTool: (input) => registry.dispatch({ tool: input.tool, params: input.params }, { request: carrier }),
      proposeWrite: async () => ({ ok: false, code: 'unsupported', message: 'read-only check' }),
      queryOperation: async () => ({ kind: 'unknown', reason: 'no_receipt' }),
      publicSearchPolicy: { provider_enabled: false, scanChildIdentifiers: async () => 'unknown' },
      tools: { read_tools: registry.definitions, write_tools: [] },
    };
    const result = await runYayaAgent(deps, { run_id: `loop-${tool}-${modelCalls}`, user_text: '读取' });
    return result;
  };

  const listLoop = await engineLoop('list_children', {}, 'children:current_scope');
  check(
    listLoop.outcome.kind === 'answered' &&
      listLoop.outcome.sources.some((source) => source.ref_id === 'children:current_scope'),
    'engine loop: model cites the list citable source successfully',
  );
  state.children = [];
  const emptyListLoop = await engineLoop('list_children', {}, 'children:current_scope');
  check(
    emptyListLoop.outcome.kind === 'answered',
    'engine loop: legal empty list is still citable',
  );
  state.children = [makeChild(CHILD_A, '幼儿甲', CLASS_A)];
  const guideLoop = await engineLoop('list_guide_items', {}, 'guide_catalog:items');
  check(
    guideLoop.outcome.kind === 'answered',
    'engine loop: static catalog list is citable',
  );
  const teacherLoop = await engineLoop('list_teacher_accounts', {}, 'teacher_accounts:school');
  check(
    teacherLoop.outcome.kind === 'answered',
    'engine loop: admin list is citable',
  );
  const dependencyLoop = await engineLoop('list_children', {}, `child:${CHILD_A}`);
  check(
    dependencyLoop.outcome.kind === 'stopped' &&
      dependencyLoop.outcome.reason === 'source_mismatch',
    'engine loop: dependency ids stay non-citable and are blocked by the guard',
  );
  const unknownLoop = await engineLoop('list_children', {}, 'not-a-source');
  check(
    unknownLoop.outcome.kind === 'stopped' && unknownLoop.outcome.reason === 'source_mismatch',
    'engine loop: arbitrary ids stay blocked',
  );

  const defaultRegistry = createYayaReadRegistry();
  check(defaultRegistry.definitions.length === expectedTools.length, 'default registry builds with real ports');

  console.log(
    JSON.stringify({
      passed,
      total: passed,
      module: 'src/lib/yaya/tools/read/**',
      mode: 'real registry/dispatcher + substitute ports; no DB/env/model/network',
      tools: expectedTools,
      NOT_RUN: ['isolated PostgreSQL real auth chain (see check-tools-read-db.ts)', 'real LLM', 'real browser/HTTP'],
    }),
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'tools read check failed');
  process.exitCode = 1;
});
