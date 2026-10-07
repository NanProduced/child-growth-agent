import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isValidElement, type ReactElement } from 'react';

import type { Child, Observation, ObservationDraft, SchoolClass } from '../src/lib/types';
import type { Principal } from '../src/lib/accounts/types';

/**
 * 班级详情 / 成长回顾的隔离 fixture 检查：
 * 每个场景在独立子进程里显式替换授权与原始/范围查询，调用页面并遍历 JSX 树。
 * 仅证明 JSX 业务语义，不连接数据库/模型、不渲染客户端组件、不证明真实认证。
 * 真实认证另由主任务的 19 Next HTTP / 107 DB 检查覆盖。
 */

const CLASS: SchoolClass = {
  id: 'class-1',
  name: '向日葵班',
  stage: 'middle',
  school_year: '2026-2027',
  is_active: true,
  is_demo: false,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: null,
};

const OTHER_CLASS: SchoolClass = {
  id: 'class-2',
  name: '蒲公英班',
  stage: 'large',
  school_year: '2026-2027',
  is_active: true,
  is_demo: false,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: null,
};

const CONFIRMED_DRAFT: ObservationDraft = {
  domain: '社会',
  sub_domain: '人际交往',
  objective_description: '幼儿在角色游戏中主动邀请同伴一起照顾娃娃。',
  highlights: ['邀请同伴一起照顾娃娃。'],
  support_suggestions: ['继续提供角色游戏材料。'],
  highlight_quote: '你当姐姐，一起照顾她吧。',
};

function makeChild(overrides: Partial<Child> & Pick<Child, 'id' | 'name'>): Child {
  return {
    gender: '女',
    birth_date: '2022-01-01',
    class_name: CLASS.name,
    class_id: CLASS.id,
    current_class: CLASS,
    class_stage: CLASS.stage,
    class_school_year: CLASS.school_year,
    avatar_emoji: '🌱',
    note: null,
    growth_profile: null,
    is_demo: false,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: null,
    ...overrides,
  };
}

function makeObservation(
  overrides: Partial<Observation> & Pick<Observation, 'id' | 'child_id' | 'status'>,
): Observation {
  return {
    class_id: CLASS.id,
    observed_class: CLASS,
    observed_at: '2026-09-20',
    context: '建构区',
    raw_text: '幼儿在建构区把积木搭成小桥。',
    agent_context: null,
    ai_draft: null,
    ai_model: null,
    ai_organized_at: null,
    confirmed_content: null,
    confirmed_at: null,
    is_demo: false,
    created_at: '2026-09-20T00:00:00.000Z',
    updated_at: null,
    ...overrides,
  };
}

function elementProps(element: ReactElement): Record<string, unknown> {
  return element.props as Record<string, unknown>;
}

function collectStrings(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, out);
    return out;
  }
  if (isValidElement(node)) {
    for (const value of Object.values(elementProps(node))) {
      if (typeof value === 'function' || typeof value === 'symbol') continue;
      collectStrings(value, out);
    }
  }
  return out;
}

function findElements(
  node: unknown,
  predicate: (element: ReactElement) => boolean,
  out: ReactElement[] = [],
): ReactElement[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (Array.isArray(node)) {
    for (const item of node) findElements(item, predicate, out);
    return out;
  }
  if (isValidElement(node)) {
    if (predicate(node)) out.push(node);
    for (const value of Object.values(elementProps(node))) {
      if (typeof value === 'function' || typeof value === 'symbol') continue;
      findElements(value, predicate, out);
    }
  }
  return out;
}

const treeText = (tree: unknown): string => collectStrings(tree).join(' ');

const findClassFormDialogs = (tree: unknown): ReactElement[] =>
  findElements(tree, (element) => elementProps(element).label === '编辑班级');

const findSectionTitles = (tree: unknown, title: string): ReactElement[] =>
  findElements(tree, (element) => elementProps(element).title === title);

const findObservationLinks = (tree: unknown): string[] =>
  findElements(tree, (element) => {
    const href = elementProps(element).href;
    return typeof href === 'string' && href.startsWith('/observations/');
  }).map((element) => String(elementProps(element).href));

const findChildLinks = (tree: unknown): string[] =>
  findElements(tree, (element) => {
    const href = elementProps(element).href;
    return typeof href === 'string' && href.startsWith('/children/');
  }).map((element) => String(elementProps(element).href));

type ModuleMock = {
  module: (specifier: string, options: { exports: Record<string, unknown> }) => void;
};

async function mockQueries(exports: Record<string, unknown>, role: "teacher" | "admin" = "teacher"): Promise<void> {
  const { mock } = await import('node:test');
  const modules = mock as unknown as ModuleMock;
  const { AccountsError } = await import('../src/lib/accounts/errors');
  const { mapAccountsError } = await import('../src/lib/accounts/guards');
  const principal: Principal = role === "admin"
    ? {
        account_id: 'offline-admin', username: 'offline-admin', display_name: '离线管理员',
        role: 'admin', account_status: 'active', scope: { kind: 'school', school_id: 'offline-school' },
      }
    : {
        account_id: 'offline-teacher', username: 'offline-teacher', display_name: '离线教师',
        role: 'teacher', account_status: 'active', scope: { kind: 'classes', class_ids: [CLASS.id, OTHER_CLASS.id] },
      };
  const authorizedRead = async <T>(_request: unknown, ...args: [unknown, unknown, (viewer: Principal) => Promise<T>]) => {
    void _request;
    return args[2](principal);
  };
  const authorizedAccess = {
    requireServerAccess: async () => principal,
    withBusinessRead: authorizedRead,
    resolveServerAuth: async () => ({
      state: { kind: "authenticated", principal },
      session: null,
      csrf: null,
      token: null,
    }),
  };
  modules.module('@/lib/auth', { exports: { ...authorizedAccess, AccountsError, mapAccountsError } });
  modules.module('@/lib/accounts/access', { exports: authorizedAccess });
  modules.module('@/lib/queries', { exports });
  modules.module('@/lib/accounts/scoped-queries', {
    exports: {
      scopedGetClass: exports.getClass,
      scopedGetClassChildren: exports.getClassChildren,
      scopedListChildren: exports.listChildren,
      scopedListObservations: async (...args: unknown[]) => {
        const list = exports.listObservations as (...queryArgs: unknown[]) => Promise<Observation[]>;
        return (await list(...args)).map((observation) => ({
          ...observation, access_projection: 'full', can_write: true,
        }));
      },
    },
  });
}

async function renderClassPage(queries: Record<string, unknown>, role: "teacher" | "admin" = "teacher"): Promise<unknown> {
  await mockQueries({
    getClass: async () => CLASS,
    getClassChildren: async () => [],
    listChildren: async () => [],
    listObservations: async () => [],
    ...queries,
  }, role);
  const page = (await import('@/app/classes/[id]/page')).default as (props: {
    params: Promise<{ id: string }>;
  }) => Promise<unknown>;
  return page({ params: Promise.resolve({ id: CLASS.id }) });
}

async function renderReportsPage(
  childParam: string | undefined,
  queries: Record<string, unknown>,
): Promise<unknown> {
  await mockQueries({
    listChildren: async () => [],
    listObservations: async () => [],
    ...queries,
  });
  const page = (await import('@/app/reports/page')).default as (props: {
    searchParams: Promise<{ child?: string }>;
  }) => Promise<unknown>;
  return page({ searchParams: Promise.resolve({ child: childParam }) });
}

const memberA = makeChild({ id: 'member-a', name: '成员甲' });
const childA = makeChild({ id: 'child-a', name: '幼儿甲' });

const SCENARIOS: Record<string, () => Promise<void>> = {
  'class-members-come-from-class-query': async () => {
    // 全园样本遗漏在班幼儿时，名单与人数仍以 getClassChildren 为准
    const tree = await renderClassPage({
      getClassChildren: async () => [memberA],
      listChildren: async () => [],
    });
    const text = treeText(tree);
    assert.ok(!text.includes('这个班级还没有成长档案'), '不应显示无成员空状态');
    assert.ok(text.includes('共 1 份') || findChildLinks(tree).includes('/children/member-a'));
    assert.equal(findChildLinks(tree).filter((href) => href === '/children/member-a').length, 1);
  },

  'class-membership-failure-keeps-management': async () => {
    const tree = await renderClassPage({
      getClassChildren: async () => {
        throw new Error('班级成员查询失败');
      },
    }, "admin");
    const text = treeText(tree);
    assert.ok(text.includes('班级数据暂不可用'), '应显示数据不可用提示');
    assert.ok(text.includes('读取暂未完成'), '读取失败应为可重试提示而非原始错误');
    assert.equal(findClassFormDialogs(tree).length, 1, '班级管理入口必须保留');
    assert.equal(findSectionTitles(tree, '成长档案').length, 0, '成员区块不应渲染');
  },

  'class-get-failure-hides-management': async () => {
    const tree = await renderClassPage({
      getClass: async () => {
        throw new Error('数据库连接失败');
      },
    });
    const text = treeText(tree);
    assert.ok(text.includes('数据库暂不可用'));
    assert.equal(findClassFormDialogs(tree).length, 0, '班级实体未加载时不应出现管理入口');
  },

  'class-history-author-and-context': async () => {
    // 转班后的旧观察留在发生班级，作者与历史语境仍可显示
    const leaver = makeChild({
      id: 'leaver-1',
      name: '石头',
      class_name: OTHER_CLASS.name,
      class_id: OTHER_CLASS.id,
      current_class: OTHER_CLASS,
      class_stage: OTHER_CLASS.stage,
      class_school_year: OTHER_CLASS.school_year,
    });
    const observation = makeObservation({
      id: 'obs-1',
      child_id: 'leaver-1',
      status: 'confirmed',
      confirmed_content: CONFIRMED_DRAFT,
    });
    const tree = await renderClassPage({
      getClassChildren: async () => [memberA],
      listChildren: async () => [memberA, leaver],
      listObservations: async () => [observation],
    });
    const text = treeText(tree);
    assert.ok(text.includes('石头'), '历史观察应显示作者');
    assert.ok(text.includes('当时在 中班 · 向日葵班'), '应保留发生时班级语境');
    assert.equal(
      findChildLinks(tree).includes('/children/leaver-1'),
      false,
      '转走的幼儿不应进入当前班级名单',
    );
    assert.equal(
      findChildLinks(tree).includes('/children/member-a'),
      true,
      '当前成员应出现在名单中',
    );
  },

  'class-management-appears-once': async () => {
    const tree = await renderClassPage({
      getClassChildren: async () => [memberA],
      listObservations: async () => [
        makeObservation({ id: 'obs-2', child_id: 'member-a', status: 'draft' }),
      ],
    }, "admin");
    assert.equal(findClassFormDialogs(tree).length, 1, '正常状态下管理区只出现一次');
    assert.equal(findSectionTitles(tree, '成长档案').length, 1);
  },

  'reports-entry-prefers-ai-organized': async () => {
    // 最新记录是 draft，但较旧记录已 ai_organized：入口必须指向 ai_organized
    const tree = await renderReportsPage(childA.id, {
      listChildren: async () => [childA],
      listObservations: async () => [
        makeObservation({
          id: 'draft-1',
          child_id: childA.id,
          status: 'draft',
          created_at: '2026-09-30T00:00:00.000Z',
        }),
        makeObservation({
          id: 'organized-1',
          child_id: childA.id,
          status: 'ai_organized',
          created_at: '2026-09-20T00:00:00.000Z',
        }),
      ],
    });
    const text = treeText(tree);
    assert.ok(text.includes('先确认一条观察'));
    assert.ok(!text.includes('继续整理观察'));
    assert.deepEqual(findObservationLinks(tree), ['/observations/organized-1/review']);
  },

  'reports-entry-needs-input-before-draft': async () => {
    const tree = await renderReportsPage(childA.id, {
      listChildren: async () => [childA],
      listObservations: async () => [
        makeObservation({
          id: 'draft-1',
          child_id: childA.id,
          status: 'draft',
          created_at: '2026-09-30T00:00:00.000Z',
        }),
        makeObservation({
          id: 'needs-input-1',
          child_id: childA.id,
          status: 'needs_input',
          created_at: '2026-09-20T00:00:00.000Z',
        }),
      ],
    });
    const text = treeText(tree);
    assert.ok(text.includes('继续整理观察'));
    assert.deepEqual(findObservationLinks(tree), ['/observations/needs-input-1/review']);
  },

  'reports-entry-draft-only': async () => {
    const tree = await renderReportsPage(childA.id, {
      listChildren: async () => [childA],
      listObservations: async () => [
        makeObservation({ id: 'draft-1', child_id: childA.id, status: 'draft' }),
      ],
    });
    assert.ok(treeText(tree).includes('继续整理观察'));
    assert.deepEqual(findObservationLinks(tree), ['/observations/draft-1/review']);
  },

  'reports-entry-no-pending-records': async () => {
    const tree = await renderReportsPage(childA.id, {
      listChildren: async () => [childA],
      listObservations: async () => [],
    });
    assert.ok(treeText(tree).includes('记录一次观察'));
    assert.deepEqual(findObservationLinks(tree), ['/observations/new?child_id=child-a']);
  },

  'reports-confirmed-observations-render': async () => {
    const tree = await renderReportsPage(childA.id, {
      listChildren: async () => [childA],
      listObservations: async () => [
        makeObservation({
          id: 'confirmed-1',
          child_id: childA.id,
          status: 'confirmed',
          confirmed_content: CONFIRMED_DRAFT,
          confirmed_at: '2026-09-21T00:00:00.000Z',
        }),
      ],
    });
    const text = treeText(tree);
    for (const section of ['成长小结', '最近变化', '观察到的线索', '活动支持摘要', '观察证据时间线']) {
      assert.ok(text.includes(section), `应展示「${section}」`);
    }
    assert.ok(text.includes(CONFIRMED_DRAFT.objective_description));
    assert.ok(!text.includes('记录一次观察'));
  },

  'reports-invalid-child-falls-back': async () => {
    const tree = await renderReportsPage('missing-child', {
      listChildren: async () => [childA],
      listObservations: async () => [
        makeObservation({
          id: 'confirmed-1',
          child_id: childA.id,
          status: 'confirmed',
          confirmed_content: CONFIRMED_DRAFT,
          confirmed_at: '2026-09-21T00:00:00.000Z',
        }),
      ],
    });
    const text = treeText(tree);
    assert.ok(text.includes('成长小结'), '无效 child 参数应回退到有已确认观察的档案');
    assert.ok(text.includes(CONFIRMED_DRAFT.objective_description));
  },
};

async function main(): Promise<void> {
  const scenarioName = process.argv[2];
  if (scenarioName) {
    const scenario = SCENARIOS[scenarioName];
    if (!scenario) throw new Error(`未知场景：${scenarioName}`);
    await scenario();
    console.log(`ok ${scenarioName}`);
    return;
  }

  const scriptPath = fileURLToPath(import.meta.url);
  const names = Object.keys(SCENARIOS);
  const failures: string[] = [];
  for (const name of names) {
    const result = spawnSync(
      process.execPath,
      ['--experimental-test-module-mocks', '--no-warnings', '--import', 'tsx', scriptPath, name],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) failures.push(name);
  }
  if (failures.length > 0) {
    throw new Error(`失败场景：${failures.join('、')}`);
  }
  console.log(JSON.stringify({ passed: names.length, total: names.length, jsx_fixtures: true, authorization_substituted: true, real_auth: false }));
}

void main();
