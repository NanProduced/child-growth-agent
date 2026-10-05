import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { Child, Observation } from "../src/lib/types";
import type { Principal } from "../src/lib/accounts/types";

/**
 * G5 路由离线检查：confirm 扩展（applied/deferred/回滚/成长小结失败不连带）、
 * guide-evidence 操作路由（suggest 成功/失败、错误映射、401/404/400）与 GET 只读语义。
 * 授权、查询与模型均使用显式模块替身：仅证明路由业务语义，不证明真实认证。
 * 真实认证另由主任务的 19 Next HTTP / 107 DB 检查覆盖；本脚本不连接数据库/模型。
 * 运行：pnpm tsx scripts/check-guide-evidence-routes.ts
 */

type ModuleMock = {
  module: (specifier: string, options: { exports: Record<string, unknown> }) => void;
};

const DRAFT = {
  domain: "语言",
  sub_domain: "倾听与表达",
  objective_description: "这次记录中出现主动表达。",
  highlights: ["他说：请你先玩。"],
  support_suggestions: ["提供轮流表达的机会。"],
  highlight_quote: "请你先玩。",
};

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: "obs-1",
    child_id: "child-1",
    class_id: "class-1",
    observed_class: null,
    observed_at: "2026-09-20",
    context: "区域活动",
    raw_text: "他把小汽车递给同伴，说：请你先玩。",
    status: "ai_organized",
    agent_context: null,
    ai_draft: { ...DRAFT },
    ai_model: "offline-model",
    ai_organized_at: "2026-09-20T00:00:00.000Z",
    confirmed_content: null,
    confirmed_at: null,
    class_context_snapshot: null,
    guide_evidence: null,
    is_demo: false,
    created_at: "2026-09-20T00:00:00.000Z",
    updated_at: null,
    ...overrides,
  };
}

function makeChild(): Child {
  return {
    id: "child-1",
    name: "示例幼儿",
    gender: "女",
    birth_date: "2021-05-01",
    class_name: "向日葵班",
    class_id: "class-1",
    current_class: null,
    class_stage: "middle",
    class_school_year: "2026-2027",
    avatar_emoji: null,
    note: null,
    growth_profile: null,
    is_demo: false,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: null,
  };
}

async function runWithMocks(): Promise<number> {
  const { mock } = await import("node:test");
  const mockModule = mock as unknown as ModuleMock;
  const { NextRequest } = await import("next/server");
  const { AccountsError } = await import("../src/lib/accounts/errors");
  const { mapAccountsError } = await import("../src/lib/accounts/guards");
  const {
    GuideEvidenceCatalogError,
    GuideEvidenceConflictError,
    GuideEvidenceInvalidError,
    GuideEvidenceNotFoundError,
  } = await import("../src/lib/guide/decisions");
  const {
    normalizeTeacherEditContent,
    clarificationSnapshot,
    normalizeTeacherNote,
  } = await import("../src/lib/teacher-edit-review");

  const COOKIE = "offlineCookie=g5-route-fixture";
  const principal: Principal = {
    account_id: "offline-teacher", username: "offline-teacher", display_name: "离线教师",
    role: "teacher", account_status: "active", scope: { kind: "classes", class_ids: ["class-1"] },
  };
  const requireOfflineCookie = (request: InstanceType<typeof NextRequest>) => {
    if (!request.headers.get("cookie")?.split(";").some((cookie) => cookie.trim() === COOKIE)) {
      throw new AccountsError("unauthenticated", "离线路由 fixture 缺少 offlineCookie");
    }
  };
  mockModule.module("@/lib/auth", {
    exports: {
      AccountsError,
      mapAccountsError,
      runBusinessWrite: async <T>(request: InstanceType<typeof NextRequest>, ...args: [unknown, unknown, () => Promise<T>]) => {
        requireOfflineCookie(request);
        return args[2]();
      },
      withBusinessRead: async <T>(request: InstanceType<typeof NextRequest>, ...args: [unknown, unknown, (viewer: Principal) => Promise<T>]) => {
        requireOfflineCookie(request);
        return args[2](principal);
      },
    },
  });

  const state = {
    observation: makeObservation(),
    confirmError: null as Error | null,
    confirmCalls: 0,
    confirmArgs: null as unknown[] | null,
    profileCalls: 0,
    profileResult: { status: "updated", growthProfile: { summary: "小结" } } as Record<string, unknown>,
    guideResponse: { revision: 1, links: [{ link_id: "link-1" }] },
    guideResponseError: null as Error | null,
    mutationResult: { observation: makeObservation({ status: "confirmed" }), revision: 1, links: [] },
    applyCalls: 0,
    applyError: null as Error | null,
    suggestResult: null as Record<string, unknown> | null,
    suggestCalls: 0,
    saveCalls: 0,
    saveInput: null as Record<string, unknown> | null,
    bookResult: null as Record<string, unknown> | null,
    overviewResult: null as Record<string, unknown> | null,
  };

  mockModule.module("@/lib/queries", {
    exports: {
      confirmObservation: async (...args: unknown[]) => {
        state.confirmCalls += 1;
        state.confirmArgs = args;
        if (state.confirmError) throw state.confirmError;
        return makeObservation({ status: "confirmed", confirmed_content: { ...DRAFT } });
      },
      getObservation: async () => state.observation,
      getChild: async () => makeChild(),
      listObservations: async () => [],
      updateObservationAgentContext: async () => state.observation,
      buildGuideResponseLinks: async () => {
        if (state.guideResponseError) throw state.guideResponseError;
        return state.guideResponse;
      },
      applyGuideEvidenceMutation: async (...args: unknown[]) => {
        state.applyCalls += 1;
        state.confirmArgs = args;
        if (state.applyError) throw state.applyError;
        return state.mutationResult;
      },
      saveGuideEvidenceSuggestionResult: async (_id: string, input: Record<string, unknown>) => {
        state.saveCalls += 1;
        state.saveInput = input;
        return { observation: makeObservation(), revision: 2, links: [{ link_id: "suggested" }] };
      },
      listObservationsForChildren: async () => [],
      getClass: async () => null,
      getClassChildren: async () => [],
    },
  });
  mockModule.module("@/lib/growth-profile", {
    exports: {
      updateGrowthProfileSafely: async () => {
        state.profileCalls += 1;
        return state.profileResult;
      },
    },
  });
  mockModule.module("@/lib/guide/suggest", {
    exports: {
      generateGuideEvidenceSuggestions: async () => {
        state.suggestCalls += 1;
        return state.suggestResult;
      },
    },
  });
  mockModule.module("@/lib/guide/read-model", {
    exports: {
      loadChildEvidenceBook: async () => state.bookResult,
      loadClassEvidenceOverview: async () => state.overviewResult,
    },
  });

  const confirmRoute = await import("../src/app/api/observations/[id]/confirm/route");
  const mutationRoute = await import("../src/app/api/observations/[id]/guide-evidence/route");
  const bookRoute = await import("../src/app/api/children/[id]/evidence-book/route");
  const overviewRoute = await import("../src/app/api/classes/[id]/evidence-overview/route");

  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const request = (method: string, body?: unknown, cookie?: string) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (cookie) headers.cookie = cookie;
    return new NextRequest("http://localhost/api/test", {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };

  let passed = 0;
  const ok = (condition: boolean, message: string) => {
    assert.ok(condition, message);
    passed += 1;
  };

  /* ---- 1) 归档 + 关联同事务 applied ---- */
  state.observation = makeObservation();
  state.confirmError = null;
  state.confirmCalls = 0;
  state.profileCalls = 0;
  const appliedResponse = await confirmRoute.POST(
    request("POST", {
      content: { ...DRAFT },
      guide_decisions: {
        expected_guide_revision: 0,
        decisions: [
          {
            item_id: "item.moe.language.listening_speaking.1.3-4.1",
            support: "single_event",
            basis: [{ observation_id: "obs-1", quote: "请你先玩。", quote_source: "raw_text" }],
          },
        ],
      },
    }, COOKIE),
    params("obs-1"),
  );
  const appliedBody = (await appliedResponse.json()) as Record<string, unknown>;
  assert.equal(appliedResponse.status, 200, "归档 + 关联应成功");
  assert.equal(state.confirmCalls, 1, "归档调用一次");
  const plan = state.confirmArgs?.[4] as { expectedRevision: number; decisions: unknown[] };
  ok(Boolean(plan) && plan.expectedRevision === 0 && plan.decisions.length === 1, "guide 计划传入同一确认事务");
  const appliedGuide = appliedBody.guideEvidence as { status: string; revision: number; links: unknown[] };
  ok(appliedGuide?.status === "applied" && appliedGuide.revision === 1 && appliedGuide.links.length === 1, "响应含 applied 关联");
  ok(appliedBody.profileUpdateStatus === "updated", "成长小结在提交后更新");

  /* ---- 2) 未归档（clarify）返回 deferred，不应用决定 ---- */
  const submitted = { ...DRAFT, objective_description: "教师修改后的表述。" };
  const review = {
    decision: "clarify" as const,
    summary: "需要澄清",
    change_summary: [],
    fact_check: "partially_supported" as const,
    question: "这个行为出现过几次？",
    content_snapshot: normalizeTeacherEditContent(submitted),
    clarification_snapshot: clarificationSnapshot([]),
    note_snapshot: normalizeTeacherNote(undefined),
    reviewed_at: "2026-09-20T00:00:00.000Z",
  };
  state.observation = makeObservation({
    agent_context: { teacher_edit_review: review },
  });
  state.confirmCalls = 0;
  const deferredResponse = await confirmRoute.POST(
    request("POST", {
      content: submitted,
      guide_decisions: {
        expected_guide_revision: 0,
        decisions: [
          {
            item_id: "item.moe.language.listening_speaking.1.3-4.1",
            support: "single_event",
            basis: [{ observation_id: "obs-1", quote: "请你先玩。", quote_source: "raw_text" }],
          },
        ],
      },
    }, COOKIE),
    params("obs-1"),
  );
  const deferredBody = (await deferredResponse.json()) as Record<string, unknown>;
  const deferredGuide = deferredBody.guideEvidence as { status: string } | undefined;
  assert.equal(deferredResponse.status, 200, "clarify 路径返回 200");
  ok(deferredGuide?.status === "deferred", "未归档路径返回 deferred");
  ok(state.confirmCalls === 0, "deferred 不写正式关联");

  /* ---- 3) 关联决定无效 → 归档也回滚 ---- */
  state.observation = makeObservation();
  state.confirmError = new GuideEvidenceInvalidError("引用无法核对", { item_id: "item.x" });
  state.profileCalls = 0;
  const rollbackResponse = await confirmRoute.POST(
    request("POST", {
      content: { ...DRAFT },
      guide_decisions: {
        expected_guide_revision: 0,
        decisions: [
          {
            item_id: "item.moe.language.listening_speaking.1.3-4.1",
            support: "single_event",
            basis: [{ observation_id: "obs-1", quote: "请你先玩。", quote_source: "raw_text" }],
          },
        ],
      },
    }, COOKIE),
    params("obs-1"),
  );
  const rollbackBody = (await rollbackResponse.json()) as Record<string, unknown>;
  assert.equal(rollbackResponse.status, 400, "无效关联决定返回 400");
  ok(rollbackBody.error === "invalid_request", "错误码为 invalid_request");
  ok(state.profileCalls === 0, "归档失败时不更新成长小结（无半成功）");
  state.confirmError = null;

  /* ---- 4) 成长小结失败不回滚归档与关联 ---- */
  state.observation = makeObservation();
  state.profileResult = { status: "failed", message: "模型不可用" };
  const profileFailResponse = await confirmRoute.POST(
    request("POST", {
      content: { ...DRAFT },
      guide_decisions: {
        expected_guide_revision: 0,
        decisions: [
          {
            item_id: "item.moe.language.listening_speaking.1.3-4.1",
            support: "single_event",
            basis: [{ observation_id: "obs-1", quote: "请你先玩。", quote_source: "raw_text" }],
          },
        ],
      },
    }, COOKIE),
    params("obs-1"),
  );
  const profileFailBody = (await profileFailResponse.json()) as Record<string, unknown>;
  assert.equal(profileFailResponse.status, 200, "小结失败不影响归档成功");
  ok(profileFailBody.profileUpdateStatus === "failed", "如实返回小结失败");
  ok((profileFailBody.guideEvidence as { status: string })?.status === "applied", "关联仍然生效");
  state.profileResult = { status: "updated", growthProfile: { summary: "小结" } };

  /* ---- 4b) 归档与关联成功 → 响应详情补查失败仍明确表达已保存 ---- */
  state.observation = makeObservation();
  state.confirmCalls = 0;
  state.profileCalls = 0;
  state.guideResponseError = new Error("详情补查失败");
  const detailFailResponse = await confirmRoute.POST(
    request("POST", {
      content: { ...DRAFT },
      guide_decisions: {
        expected_guide_revision: 0,
        decisions: [
          {
            item_id: "item.moe.language.listening_speaking.1.3-4.1",
            support: "single_event",
            basis: [{ observation_id: "obs-1", quote: "请你先玩。", quote_source: "raw_text" }],
          },
        ],
      },
    }, COOKIE),
    params("obs-1"),
  );
  const detailFailBody = (await detailFailResponse.json()) as Record<string, unknown>;
  assert.equal(detailFailResponse.status, 200, "详情补查失败不得把已提交成功改报 500");
  ok(state.confirmCalls === 1, "归档与关联仍只提交一次");
  const detailFailGuide = detailFailBody.guideEvidence as {
    status: string;
    links?: unknown[];
    detail_unavailable?: boolean;
    message?: string;
  };
  ok(detailFailGuide?.status === "applied", "仍明确表达关联已保存");
  ok(detailFailGuide?.detail_unavailable === true, "显式标识详情暂不可读");
  ok(detailFailGuide?.links === undefined, "不得用空 links 冒充详情读取成功");
  ok(Boolean(detailFailGuide?.message?.includes("不要重复提交")), "提示不诱导重复提交");
  ok(detailFailBody.profileUpdateStatus === "updated", "详情补查失败不影响成长小结执行");
  state.guideResponseError = null;

  /* ---- 5) 未携带 guide_decisions 时行为兼容 ---- */
  state.observation = makeObservation();
  const plainResponse = await confirmRoute.POST(
    request("POST", { content: { ...DRAFT } }, COOKIE),
    params("obs-1"),
  );
  const plainBody = (await plainResponse.json()) as Record<string, unknown>;
  assert.equal(plainResponse.status, 200, "不带 guide_decisions 的确认保持兼容");
  ok(plainBody.guideEvidence === undefined, "兼容路径不新增字段");
  ok(state.confirmArgs?.[4] === undefined, "兼容路径不传 guide 计划");

  /* ---- 6) 离线授权替身：缺少 offlineCookie → 401 ---- */
  state.observation = makeObservation();
  const unauthorized = await confirmRoute.POST(request("POST", { content: { ...DRAFT } }), params("obs-1"));
  assert.equal(unauthorized.status, 401, "无 cookie 返回 401");

  /* ---- 7) guide-evidence 路由：suggest 成功 ---- */
  state.observation = makeObservation();
  state.suggestCalls = 0;
  state.saveCalls = 0;
  state.suggestResult = {
    ok: true,
    model: "offline-model",
    suggestions: [
      {
        item_id: "item.moe.language.listening_speaking.1.3-4.1",
        reason: "出现轮流表达",
        quote: "请你先玩。",
        quote_source: "raw_text",
        quote_field: null,
        source_observation_id: "obs-1",
        observed_at: "2026-09-20",
        class_context: null,
        source_confirmed_at: "2026-09-20T01:00:00.000Z",
      },
    ],
  };
  const suggestResponse = await mutationRoute.POST(request("POST", { action: "suggest" }, COOKIE), params("obs-1"));
  const suggestBody = (await suggestResponse.json()) as Record<string, unknown>;
  assert.equal(suggestResponse.status, 200, "suggest 成功返回 200");
  ok(state.suggestCalls === 1 && state.saveCalls === 1, "模型在事务外、结果统一保存");
  ok(state.saveInput?.ok === true, "保存成功结果");
  ok(suggestBody.notice === undefined, "成功不携带 ai_link_failed");
  ok(suggestBody.revision === 2, "返回保存后的 revision");

  /* ---- 8) suggest 失败 → 200 + ai_link_failed，旧关联保留 ---- */
  state.suggestResult = { ok: false, error: "引用未通过核对", model: "offline-model", suggestions: [] };
  const suggestFailResponse = await mutationRoute.POST(request("POST", { action: "suggest" }, COOKIE), params("obs-1"));
  const suggestFailBody = (await suggestFailResponse.json()) as Record<string, unknown>;
  assert.equal(suggestFailResponse.status, 200, "suggest 失败仍返回 200");
  const notice = suggestFailBody.notice as { code: string; message: string };
  ok(notice?.code === "ai_link_failed" && notice.message.includes("引用未通过核对"), "携带 ai_link_failed 与原因");
  ok(state.saveInput?.ok === false, "记录 last_attempt 失败路径");

  /* ---- 9) confirm/reject/withdraw 与错误映射 ---- */
  state.mutationResult = { observation: makeObservation({ status: "confirmed" }), revision: 3, links: [] };
  const confirmMutation = await mutationRoute.POST(
    request("POST", {
      action: "confirm",
      expected_guide_revision: 2,
      decisions: [
        {
          link_id: "link-1",
          support: "single_event",
          basis: [{ observation_id: "obs-1", quote: "请你先玩。", quote_source: "raw_text" }],
        },
      ],
    }, COOKIE),
    params("obs-1"),
  );
  assert.equal(confirmMutation.status, 200, "confirm 操作成功");

  state.mutationResult = { observation: makeObservation(), revision: 3, links: [] };
  const rejectMutation = await mutationRoute.POST(
    request("POST", { action: "reject", link_id: "link-1", expected_guide_revision: 3, reason: "不采用" }, COOKIE),
    params("obs-1"),
  );
  assert.equal(rejectMutation.status, 200, "reject 操作成功");
  const withdrawMutation = await mutationRoute.POST(
    request("POST", { action: "withdraw", link_id: "link-1", expected_guide_revision: 3 }, COOKIE),
    params("obs-1"),
  );
  assert.equal(withdrawMutation.status, 200, "withdraw 操作成功");

  // 错误映射通过替身抛出
  const applyMock = (error: Error) => {
    state.applyError = error;
  };
  applyMock(new GuideEvidenceConflictError("revision 过期"));
  const conflictResponse = await mutationRoute.POST(
    request("POST", { action: "withdraw", link_id: "link-1", expected_guide_revision: 1 }, COOKIE),
    params("obs-1"),
  );
  assert.equal(conflictResponse.status, 409, "冲突返回 409");
  const conflictBody = (await conflictResponse.json()) as Record<string, unknown>;
  ok(conflictBody.error === "state_conflict", "冲突错误码");

  applyMock(new GuideEvidenceNotFoundError("关联不存在", "link-9"));
  const notFoundLink = await mutationRoute.POST(
    request("POST", { action: "withdraw", link_id: "link-9", expected_guide_revision: 1 }, COOKIE),
    params("obs-1"),
  );
  assert.equal(notFoundLink.status, 404, "link 不存在返回 404");

  applyMock(new GuideEvidenceCatalogError("条目不在当前目录", "item.x"));
  const catalogMismatch = await mutationRoute.POST(
    request("POST", {
      action: "confirm",
      expected_guide_revision: 1,
      decisions: [
        {
          item_id: "item.x",
          support: "single_event",
          basis: [{ observation_id: "obs-1", quote: "请你先玩。", quote_source: "raw_text" }],
        },
      ],
    }, COOKIE),
    params("obs-1"),
  );
  assert.equal(catalogMismatch.status, 409, "目录版本不一致返回 409");
  const catalogBody = (await catalogMismatch.json()) as Record<string, unknown>;
  ok(catalogBody.error === "catalog_version_mismatch", "目录错误码");
  state.applyError = null;

  // 请求体不合法
  const badBody = await mutationRoute.POST(request("POST", { action: "confirm", expected_guide_revision: 0, decisions: [] }, COOKIE), params("obs-1"));
  assert.equal(badBody.status, 400, "非法请求体返回 400");
  // 无身份
  const mutationUnauthorized = await mutationRoute.POST(request("POST", { action: "suggest" }), params("obs-1"));
  assert.equal(mutationUnauthorized.status, 401, "写操作无身份返回 401");
  // 观察不存在
  state.observation = null as unknown as Observation;
  const missingObservation = await mutationRoute.POST(request("POST", { action: "suggest" }, COOKIE), params("obs-1"));
  assert.equal(missingObservation.status, 404, "观察不存在返回 404");
  state.observation = makeObservation();

  /* ---- 10) GET 只读：零模型零写入 + 错误映射 ---- */
  const beforeSuggest = state.suggestCalls;
  const beforeApply = state.applyCalls;
  state.bookResult = { ok: true, value: { audience: "child_history", status_counts: { no_records: 0, has_clues: 0, confirmed_observed: 0 } } };
  const bookResponse = await bookRoute.GET(request("GET", undefined, COOKIE), params("child-1"));
  assert.equal(bookResponse.status, 200, "个人证据册 GET 200");
  state.overviewResult = { ok: true, value: { audience: "class_current_roster" } };
  const overviewResponse = await overviewRoute.GET(request("GET", undefined, COOKIE), params("class-1"));
  assert.equal(overviewResponse.status, 200, "班级概览 GET 200");
  ok(state.suggestCalls === beforeSuggest && state.applyCalls === beforeApply, "GET 零模型零写入");

  state.bookResult = { ok: false, failure: { status: 400, error: "invalid_request", message: "日期范围非法" } };
  const bookBad = await bookRoute.GET(request("GET", undefined, COOKIE), params("child-1"));
  assert.equal(bookBad.status, 400, "读模型 400 透传");
  state.bookResult = { ok: false, failure: { status: 409, error: "semester_config_missing", message: "学期配置缺失" } };
  const bookMissing = await bookRoute.GET(request("GET", undefined, COOKIE), params("child-1"));
  assert.equal(bookMissing.status, 409, "读模型 409 透传");
  state.bookResult = { ok: false, failure: { status: 404, error: "not_found", message: "幼儿不存在" } };
  const bookNotFound = await bookRoute.GET(request("GET", undefined, COOKIE), params("child-1"));
  assert.equal(bookNotFound.status, 404, "读模型 404 透传");

  return passed;
}

async function main(): Promise<void> {
  if (process.env.G5_ROUTES_MOCKED !== "1") {
    const scriptPath = fileURLToPath(import.meta.url);
    const result = spawnSync(
      process.execPath,
      ["--experimental-test-module-mocks", "--no-warnings", "--import", "tsx", scriptPath],
      {
        stdio: "inherit",
        env: { ...process.env, G5_ROUTES_MOCKED: "1" },
      },
    );
    if (result.status !== 0) throw new Error("G5 路由离线检查失败");
    return;
  }

  const passed = await runWithMocks();
  console.log(JSON.stringify({ passed, total: passed, offline: true, routes_mocked: true, authorization_substituted: true, real_auth: false }));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
