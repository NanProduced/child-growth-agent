import { guideItemById } from "../src/lib/guide/item-index";
import {
  applyGuideDecisions,
  applyGuideTerminalOperation,
  GuideEvidenceConflictError,
  type ApplyDecisionsContext,
  type DecisionSourceObservation,
} from "../src/lib/guide/decisions";
import { buildChildEvidenceBook } from "../src/lib/guide/read-model";
import {
  buildMutationLinkViews,
  checkBasis,
  evaluateLink,
  parseGuideEvidence,
  rollupChildItem,
  rollupClassItem,
  sameTimestamp,
  type EvidenceObservation,
} from "../src/lib/guide/runtime";
import {
  generateGuideEvidenceSuggestions,
  validateGuideSuggestionOutput,
  type GuideSuggestionOutput,
} from "../src/lib/guide/suggest";
import {
  GUIDE_CATALOG_VERSION,
  type GuideEvidenceLink,
  type ObservationGuideEvidence,
} from "../src/lib/guide/types";
import type { EvidenceScope, EvidenceViewFilters } from "../src/lib/guide/view-types";
import type { Child, Observation } from "../src/lib/types";
import type { TransactionClient } from "../src/storage/database/pg-client";

/**
 * G5-R1 业务守门离线反例（不写数据库、不调用模型，模型全部注入替身）。
 *
 * 覆盖：宿主归档守门（A）、目录/来源版本漂移（B）、读取可靠性与支持条件（D）、
 * 依据审计独立核对（E）、AI 引用来源绑定（F）、事实引用不被当作评分（G）。
 * C 的响应补查语义在 scripts/check-guide-evidence-routes.ts 覆盖。
 *
 * 运行：pnpm tsx scripts/check-guide-evidence-r1.ts
 */

let passed = 0;
const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (condition) {
    passed += 1;
  } else {
    failures.push(message);
  }
}

function errorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

const CHILD = "c0000000-0000-4000-8000-000000000001";
const OTHER_CHILD = "c0000000-0000-4000-8000-000000000002";
const OBS_A = "o0000000-0000-4000-8000-000000000001";
const OBS_B = "o0000000-0000-4000-8000-000000000002";
const OBS_C = "o0000000-0000-4000-8000-000000000003";
const OBS_D = "o0000000-0000-4000-8000-000000000004";
const OBS_OTHER = "o0000000-0000-4000-8000-000000000005";
const NOW = "2026-10-03T08:00:00.000Z";
const T1 = "2026-09-21T02:00:00.000Z";
const T2 = "2026-09-30T02:00:00.000Z";

const ITEM_ALLOWED = "item.moe.language.listening_speaking.1.3-4.1";
const ITEM_REQUIRES_INDEPENDENCE = "item.moe.health.daily_living.1.5-6.2";
const ITEM_SUSTAINED = "item.moe.language.reading_writing.1.4-5.1";

const RAW_A = "他把小汽车递给同伴，说：请你先玩。";
const RAW_SCORE = "他说：游戏不按分数排名。";

const CONTENT_A = {
  domain: "语言",
  sub_domain: "倾听与表达",
  objective_description: "这次记录中出现了主动表达。",
  highlights: ["他说：请你先玩。"],
  support_suggestions: ["提供轮流表达的机会。"],
  highlight_quote: "请你先玩。",
};

const SNAPSHOT_MIDDLE = {
  class_id: "k0000000-0000-4000-8000-000000000001",
  class_name: "向日葵班",
  stage: "middle" as const,
  school_year: "2026-2027",
  captured_at: "2026-09-01T00:00:00.000Z",
  source: "enrollment_lookup" as const,
  enrollment_id: "e0000000-0000-4000-8000-000000000001",
  confirmed_at: null,
};

function makeObs(overrides: Partial<EvidenceObservation> & { id: string }): EvidenceObservation {
  return {
    child_id: CHILD,
    observed_at: "2026-09-20",
    raw_text: RAW_A,
    status: "confirmed",
    confirmed_content: { ...CONTENT_A },
    confirmed_at: T1,
    class_context_snapshot: { ...SNAPSHOT_MIDDLE },
    guide_evidence: null,
    ...overrides,
  };
}

function makeLink(overrides: Partial<GuideEvidenceLink> & { id: string; item_id: string }): GuideEvidenceLink {
  return {
    catalog_version: GUIDE_CATALOG_VERSION,
    origin: "manual",
    status: "confirmed_performance",
    support: "single_event",
    adult_help_used: false,
    basis: [
      {
        observation_id: OBS_A,
        observed_at: "2026-09-20",
        quote: "请你先玩。",
        quote_source: "raw_text",
        quote_field: null,
        class_context: { ...SNAPSHOT_MIDDLE },
        source_confirmed_at: T1,
      },
    ],
    ai_reason: null,
    teacher_note: null,
    revision: 1,
    created_at: "2026-09-22T00:00:00.000Z",
    decided_at: "2026-09-22T00:00:00.000Z",
    withdrawn_at: null,
    withdrawn_reason: null,
    ...overrides,
  };
}

function makeContainer(links: GuideEvidenceLink[], revision = links.length > 0 ? 1 : 0): ObservationGuideEvidence {
  return { revision, links };
}

function decisionContext(
  sources: EvidenceObservation[],
  confirmingObservationId: string | null = null,
): ApplyDecisionsContext {
  const sourceById = new Map<string, DecisionSourceObservation>();
  for (const source of sources) {
    sourceById.set(source.id, {
      id: source.id,
      child_id: source.child_id,
      observed_at: source.observed_at,
      raw_text: source.raw_text,
      status: source.status,
      confirmed_content: source.confirmed_content,
      confirmed_at: source.confirmed_at,
      class_context_snapshot: source.class_context_snapshot ?? null,
    });
  }
  return {
    childId: CHILD,
    itemById: guideItemById,
    sourceById,
    now: NOW,
    confirmingObservationId,
  };
}

const ALL_SCOPE: EvidenceScope = {
  kind: "all_history",
  semester_id: null,
  label: "全部历史",
  start_date: null,
  end_date: null,
  filter_field: "observed_at",
};

const NO_FILTERS: EvidenceViewFilters = { domain_code: null, age_band: null, goal_id: null };

const VALID_BASIS = { observation_id: OBS_A, quote: "请你先玩。", quote_source: "raw_text" as const };

function rollupFor(
  observations: EvidenceObservation[],
  itemId: string,
  audience: "child_history" | "class_current_roster" = "child_history",
) {
  const item = guideItemById(itemId);
  if (!item) throw new Error(`目录条目不存在：${itemId}`);
  const observationById = new Map(observations.map((entry) => [entry.id, entry]));
  return rollupChildItem({
    childId: CHILD,
    observations,
    item,
    observationById,
    scope: ALL_SCOPE,
    audience,
    classStage: audience === "class_current_roster" ? "middle" : null,
  });
}

function makeChild(): Child {
  return {
    id: CHILD,
    name: "示例幼儿",
    gender: "女",
    birth_date: "2021-05-01",
    class_name: "向日葵班",
    class_id: SNAPSHOT_MIDDLE.class_id,
    current_class: {
      id: SNAPSHOT_MIDDLE.class_id,
      name: "向日葵班",
      stage: "middle",
      school_year: "2026-2027",
      is_active: true,
      is_demo: false,
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: null,
    },
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

/* ---------------- 假事务客户端：仅离线验证共享保存边界 ---------------- */

function fakeClient(observation: Observation, sources: Observation[] = []): TransactionClient {
  const byId = new Map<string, Observation>();
  byId.set(observation.id, observation);
  for (const source of sources) byId.set(source.id, source);
  const client = {
    release: () => undefined,
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("SELECT child_id FROM observations")) {
        const target = byId.get(String(params[0]));
        return target ? { rows: [{ child_id: target.child_id }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM children")) {
        return { rows: [{ id: String(params[0]) }], rowCount: 1 };
      }
      if (sql.includes("FROM observations o WHERE o.id = $1 FOR UPDATE")) {
        const target = byId.get(String(params[0]));
        return target ? { rows: [{ data: target }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes("o.child_id = $1")) {
        const rows = [...byId.values()]
          .filter((entry) => entry.child_id === String(params[0]))
          .map((entry) => ({ data: entry }));
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("SET guide_evidence")) {
        const target = byId.get(String(params[0]));
        if (!target) return { rows: [], rowCount: 0 };
        target.guide_evidence = JSON.parse(String(params[1])) as unknown;
        target.updated_at = String(params[2]);
        return { rows: [{ data: target }], rowCount: 1 };
      }
      throw new Error(`假事务客户端未处理的 SQL：${sql}`);
    },
  };
  return client as unknown as TransactionClient;
}

/* ---------------- A) 独立操作必须检查宿主观察已归档 ---------------- */

async function testHostGuard(): Promise<void> {
  const { applyGuideEvidenceMutationWithClient } = await import("../src/lib/queries");
  const decision = {
    item_id: ITEM_ALLOWED,
    support: "single_event" as const,
    basis: [{ observation_id: OBS_B, quote: "请你先玩。", quote_source: "raw_text" as const }],
  };

  for (const status of ["draft", "needs_input", "ai_organized"] as const) {
    const host = makeObs({ id: OBS_A, status, confirmed_content: null, confirmed_at: null });
    const confirmedSource = makeObs({ id: OBS_B });
    const client = fakeClient(host as unknown as Observation, [confirmedSource as unknown as Observation]);
    let code: string | null = null;
    try {
      await applyGuideEvidenceMutationWithClient(client, OBS_A, {
        action: "confirm",
        expected_guide_revision: 0,
        decisions: [decision],
      });
    } catch (error) {
      code = errorCode(error);
    }
    check(code === "state_conflict", `宿主 ${status} 独立确认必须 409 state_conflict（实际 ${code}）`);
    check(host.guide_evidence === null, `宿主 ${status} 被拒时不得写入容器`);
  }

  const aiLink = makeLink({
    id: "link-ai",
    item_id: ITEM_ALLOWED,
    origin: "ai",
    status: "ai_suggested",
    support: null,
    decided_at: null,
  });
  for (const action of ["reject", "withdraw"] as const) {
    const host = makeObs({
      id: OBS_A,
      status: "ai_organized",
      confirmed_content: null,
      confirmed_at: null,
      guide_evidence: makeContainer([aiLink]),
    });
    const client = fakeClient(host as unknown as Observation);
    let code: string | null = null;
    try {
      await applyGuideEvidenceMutationWithClient(client, OBS_A, {
        action,
        link_id: "link-ai",
        expected_guide_revision: 1,
        reason: "测试",
      });
    } catch (error) {
      code = errorCode(error);
    }
    check(code === "state_conflict", `宿主未归档执行 ${action} 必须 409 state_conflict（实际 ${code}）`);
  }

  // 幂等重复不得绕过宿主状态：未归档宿主上已有内容完全一致的 confirmed 关联
  const identical = makeLink({
    id: "link-identical",
    item_id: ITEM_ALLOWED,
    basis: [
      {
        observation_id: OBS_B,
        observed_at: "2026-09-20",
        quote: "请你先玩。",
        quote_source: "raw_text",
        quote_field: null,
        class_context: { ...SNAPSHOT_MIDDLE },
        source_confirmed_at: T1,
      },
    ],
  });
  const hostWithIdentical = makeObs({
    id: OBS_A,
    status: "ai_organized",
    confirmed_content: null,
    confirmed_at: null,
    guide_evidence: makeContainer([identical]),
  });
  const idempotentClient = fakeClient(hostWithIdentical as unknown as Observation, [
    makeObs({ id: OBS_B }) as unknown as Observation,
  ]);
  let idempotentCode: string | null = null;
  try {
    await applyGuideEvidenceMutationWithClient(idempotentClient, OBS_A, {
      action: "confirm",
      expected_guide_revision: 1,
      decisions: [decision],
    });
  } catch (error) {
    idempotentCode = errorCode(error);
  }
  check(idempotentCode === "state_conflict", `幂等重复不得绕过宿主状态（实际 ${idempotentCode}）`);
  check(
    (hostWithIdentical.guide_evidence as ObservationGuideEvidence).revision === 1,
    "宿主未归档被拒时不得增长 revision",
  );

  // 宿主正常归档后的合法操作与重复幂等保持可用
  const confirmedHost = makeObs({ id: OBS_A });
  const successClient = fakeClient(confirmedHost as unknown as Observation, [
    makeObs({ id: OBS_B }) as unknown as Observation,
  ]);
  const applied = await applyGuideEvidenceMutationWithClient(successClient, OBS_A, {
    action: "confirm",
    expected_guide_revision: 0,
    decisions: [decision],
  });
  check(
    applied.revision === 1 && applied.links.length === 1,
    "宿主已归档时独立确认正常写入",
  );
  const repeated = await applyGuideEvidenceMutationWithClient(successClient, OBS_A, {
    action: "confirm",
    expected_guide_revision: 1,
    decisions: [decision],
  });
  check(
    repeated.revision === 1 && repeated.links.length === 1,
    "宿主已归档时合法重复提交幂等且不增长 revision",
  );
}

/* ---------------- B) 目录版本与依据版本不能静默刷新 ---------------- */

function testCatalogVersionGuard(): void {
  const source = makeObs({ id: OBS_A });
  const oldLink = makeLink({
    id: "link-old",
    item_id: ITEM_ALLOWED,
    catalog_version: "moe-3-6-2012.v0",
    origin: "ai",
    status: "ai_suggested",
    support: null,
    decided_at: null,
  });
  let code: string | null = null;
  try {
    applyGuideDecisions(
      parseGuideEvidence(makeContainer([oldLink])),
      [{ link_id: "link-old", support: "single_event", basis: [VALID_BASIS] }],
      decisionContext([source]),
    );
  } catch (error) {
    code = errorCode(error);
  }
  check(code === "catalog_version_mismatch", `旧目录关联按 link_id 确认必须拒绝（实际 ${code}）`);
}

function testBasisVersionDrift(): void {
  const driftedSource = makeObs({ id: OBS_A, confirmed_at: T2 });
  const aiLink = makeLink({
    id: "link-ai",
    item_id: ITEM_ALLOWED,
    origin: "ai",
    status: "ai_suggested",
    support: null,
    decided_at: null,
    basis: [
      {
        observation_id: OBS_A,
        observed_at: "2026-09-20",
        quote: "请你先玩。",
        quote_source: "raw_text",
        quote_field: null,
        class_context: { ...SNAPSHOT_MIDDLE },
        source_confirmed_at: T1,
      },
    ],
  });
  let code: string | null = null;
  try {
    applyGuideDecisions(
      parseGuideEvidence(makeContainer([aiLink])),
      [{ link_id: "link-ai", support: "single_event", basis: [VALID_BASIS] }],
      decisionContext([driftedSource]),
    );
  } catch (error) {
    code = errorCode(error);
  }
  check(code === "basis_expired", `已确认来源版本漂移必须 basis_expired（实际 ${code}）`);

  // 同一来源改写片段也不能绕过版本核对（不允许借“换片段”静默刷新旧来源版本）
  let quoteEditCode: string | null = null;
  try {
    applyGuideDecisions(
      parseGuideEvidence(makeContainer([aiLink])),
      [
        {
          link_id: "link-ai",
          support: "single_event",
          basis: [{ observation_id: OBS_A, quote: "把小汽车递给同伴", quote_source: "raw_text" }],
        },
      ],
      decisionContext([driftedSource]),
    );
  } catch (error) {
    quoteEditCode = errorCode(error);
  }
  check(quoteEditCode === "basis_expired", `同一来源改写片段仍须核对版本（实际 ${quoteEditCode}）`);

  // 版本未漂移时允许教师明确改写片段
  const stableSource = makeObs({ id: OBS_A });
  const quoteEdit = applyGuideDecisions(
    parseGuideEvidence(makeContainer([aiLink])),
    [
      {
        link_id: "link-ai",
        support: "single_event",
        basis: [{ observation_id: OBS_A, quote: "把小汽车递给同伴", quote_source: "raw_text" }],
      },
    ],
    decisionContext([stableSource]),
  );
  const quoteEditedLink = quoteEdit.links.find((link) => link.id === "link-ai");
  check(
    quoteEdit.changed && quoteEditedLink?.basis[0]?.quote === "把小汽车递给同伴",
    "版本一致时允许明确改写片段并写入新片段",
  );

  // 批量中一条过期：整批不写入
  const freshSource = makeObs({ id: OBS_C, observed_at: "2026-09-18", raw_text: "他主动把积木分给同伴一起搭桥。" });
  const before = parseGuideEvidence(makeContainer([aiLink]));
  let batchCode: string | null = null;
  try {
    applyGuideDecisions(
      before,
      [
        {
          item_id: ITEM_SUSTAINED,
          support: "sustained",
          basis: [
            { observation_id: OBS_C, quote: "主动把积木分给同伴", quote_source: "raw_text" },
            { observation_id: OBS_A, quote: "请你先玩。", quote_source: "raw_text" },
          ],
        },
        { link_id: "link-ai", support: "single_event", basis: [VALID_BASIS] },
      ],
      decisionContext([driftedSource, freshSource]),
    );
  } catch (error) {
    batchCode = errorCode(error);
  }
  check(batchCode === "basis_expired", `批量中一条依据过期整批失败（实际 ${batchCode}）`);
  check(before.kind === "ok" && before.links.length === 1, "失败批次不得修改输入容器");
}

function testNullAndInvalidVersion(): void {
  // 读取：confirmed_at 与 source_confirmed_at 都为 null 不能证明版本一致
  const nullVersionObs = makeObs({ id: OBS_A, confirmed_at: null });
  const nullVersionCheck = checkBasis(
    {
      observation_id: OBS_A,
      observed_at: "2026-09-20",
      quote: "请你先玩。",
      quote_source: "raw_text",
      quote_field: null,
      class_context: null,
      source_confirmed_at: null,
      malformed: false,
    },
    CHILD,
    new Map([[nullVersionObs.id, nullVersionObs]]),
  );
  check(
    nullVersionCheck.valid === false && nullVersionCheck.reason === "version_mismatch",
    "null/null 不能证明版本一致，应判 version_mismatch",
  );
  check(sameTimestamp(null, null) === false, "sameTimestamp(null, null) 必须为 false");

  // 读取：相同非法字符串不能证明版本一致
  const invalidVersionObs = makeObs({ id: OBS_A, confirmed_at: "not-a-timestamp" });
  const invalidVersionCheck = checkBasis(
    {
      observation_id: OBS_A,
      observed_at: "2026-09-20",
      quote: "请你先玩。",
      quote_source: "raw_text",
      quote_field: null,
      class_context: null,
      source_confirmed_at: "not-a-timestamp",
      malformed: false,
    },
    CHILD,
    new Map([[invalidVersionObs.id, invalidVersionObs]]),
  );
  check(
    invalidVersionCheck.valid === false && invalidVersionCheck.reason === "version_mismatch",
    "相同非法版本字符串不能证明版本一致",
  );
  check(sameTimestamp("not-a-timestamp", "not-a-timestamp") === false, "sameTimestamp 非法字符串必须为 false");

  // 写入：沿用空版本快照的独立确认必须 basis_expired
  const confirmedSource = makeObs({ id: OBS_A });
  const nullSnapshotLink = makeLink({
    id: "link-null-version",
    item_id: ITEM_ALLOWED,
    origin: "ai",
    status: "ai_suggested",
    support: null,
    decided_at: null,
    basis: [
      {
        observation_id: OBS_A,
        observed_at: "2026-09-20",
        quote: "请你先玩。",
        quote_source: "raw_text",
        quote_field: null,
        class_context: null,
        source_confirmed_at: null,
      },
    ],
  });
  let code: string | null = null;
  try {
    applyGuideDecisions(
      parseGuideEvidence(makeContainer([nullSnapshotLink])),
      [{ link_id: "link-null-version", support: "single_event", basis: [VALID_BASIS] }],
      decisionContext([confirmedSource]),
    );
  } catch (error) {
    code = errorCode(error);
  }
  check(code === "basis_expired", `独立确认沿用空版本快照必须 basis_expired（实际 ${code}）`);

  // 正常首次归档：同一事务内宿主首次获得 confirmed_at，允许沿用空版本快照
  const hostBeingArchived: EvidenceObservation = makeObs({
    id: OBS_A,
    status: "confirmed",
    confirmed_content: { ...CONTENT_A },
    confirmed_at: NOW,
  });
  const firstArchive = applyGuideDecisions(
    parseGuideEvidence(makeContainer([nullSnapshotLink])),
    [{ link_id: "link-null-version", support: "single_event", basis: [VALID_BASIS] }],
    decisionContext([hostBeingArchived], OBS_A),
  );
  const archivedLink = firstArchive.links.find((link) => link.id === "link-null-version");
  check(
    firstArchive.changed && archivedLink?.basis[0]?.source_confirmed_at === NOW,
    "同事务首次归档应写入新的 confirmed_at 快照",
  );
}

function testExplicitRebaseAndIdempotent(): void {
  const sourceA = makeObs({ id: OBS_A });
  const sourceB = makeObs({ id: OBS_B });
  const existing = makeLink({
    id: "link-existing",
    item_id: ITEM_ALLOWED,
    origin: "ai",
    status: "ai_suggested",
    support: null,
    decided_at: null,
    basis: [
      {
        observation_id: OBS_A,
        observed_at: "2026-09-20",
        quote: "请你先玩。",
        quote_source: "raw_text",
        quote_field: null,
        class_context: null,
        source_confirmed_at: T1,
      },
    ],
  });
  // 教师明确换用另一条已确认依据：允许，生成新快照
  const rebased = applyGuideDecisions(
    parseGuideEvidence(makeContainer([existing])),
    [
      {
        link_id: "link-existing",
        support: "single_event",
        basis: [{ observation_id: OBS_B, quote: "请你先玩。", quote_source: "raw_text" }],
      },
    ],
    decisionContext([sourceA, sourceB]),
  );
  const rebasedLink = rebased.links.find((link) => link.id === "link-existing");
  check(
    rebased.changed && rebasedLink?.basis[0]?.observation_id === OBS_B,
    "教师明确换用新依据应允许并生成新快照",
  );

  // 新手动关联（无 AI 建议）仍可用
  const manual = applyGuideDecisions(
    parseGuideEvidence(null),
    [{ item_id: ITEM_ALLOWED, support: "single_event", basis: [VALID_BASIS] }],
    decisionContext([sourceA]),
  );
  check(manual.changed && manual.links.length === 1, "新手动关联仍可用");

  // 合法重复幂等
  const repeat = applyGuideDecisions(
    parseGuideEvidence(manual.container),
    [{ item_id: ITEM_ALLOWED, support: "single_event", basis: [VALID_BASIS] }],
    decisionContext([sourceA]),
  );
  check(repeat.changed === false && repeat.revision === manual.revision, "合法重复提交保持幂等");
}

/* ---------------- D) 读取校验与可靠性 ---------------- */

function testReadReliability(): void {
  // confirmed 关联缺 item_id：不能伪装成正常未关联
  const brokenRaw = { ...makeLink({ id: "link-broken", item_id: ITEM_ALLOWED }) } as Record<string, unknown>;
  delete brokenRaw.item_id;
  const brokenOnly = makeObs({ id: OBS_A, guide_evidence: { revision: 1, links: [brokenRaw] } });
  const brokenRollup = rollupFor([brokenOnly], ITEM_ALLOWED);
  check(brokenRollup.reliability !== "reliable", `缺 item_id 的关联不能返回 reliable（实际 ${brokenRollup.reliability}）`);
  check(brokenRollup.status === "no_records", "缺 item_id 不产生虚假状态");

  // 同一容器有有效关联和未知状态：partial，且有效关联仍计入
  const validRaw = makeLink({ id: "link-valid", item_id: ITEM_ALLOWED });
  const unknownRaw = { ...makeLink({ id: "link-unknown", item_id: ITEM_ALLOWED }), status: "mystery" };
  const mixed = makeObs({
    id: OBS_A,
    guide_evidence: { revision: 2, links: [validRaw, unknownRaw] },
  });
  const mixedRollup = rollupFor([mixed], ITEM_ALLOWED);
  check(mixedRollup.reliability === "partial", `有效+未知状态同容器应为 partial（实际 ${mixedRollup.reliability}）`);
  check(mixedRollup.status === "confirmed_observed", "混合容器中有效关联仍计入状态");

  // 班级：一人不可读、一人可读 → partial，保留分母与已核验结果
  const corruptChild = makeObs({ id: OBS_C, child_id: CHILD, guide_evidence: "broken" });
  const readableChild = makeObs({ id: OBS_D, child_id: OTHER_CHILD });
  const readableLink = makeLink({
    id: "link-readable",
    item_id: ITEM_ALLOWED,
    basis: [
      {
        observation_id: OBS_D,
        observed_at: "2026-09-20",
        quote: "请你先玩。",
        quote_source: "raw_text",
        quote_field: null,
        class_context: { ...SNAPSHOT_MIDDLE },
        source_confirmed_at: T1,
      },
    ],
  });
  readableChild.guide_evidence = makeContainer([readableLink]);
  const item = guideItemById(ITEM_ALLOWED);
  if (!item) throw new Error("目录条目不存在");
  const observationById = new Map<string, EvidenceObservation>([
    [corruptChild.id, corruptChild],
    [readableChild.id, readableChild],
  ]);
  const classRollup = rollupClassItem({
    children: [
      { childId: CHILD, observations: [corruptChild] },
      { childId: OTHER_CHILD, observations: [readableChild] },
    ],
    item,
    observationById,
    scope: ALL_SCOPE,
    classStage: "middle",
  });
  check(classRollup.reliability === "partial", `混合班级应为 partial（实际 ${classRollup.reliability}）`);
  check(classRollup.total === 2, "混合班级保留名单分母");
  check(classRollup.counts.confirmed_observed === 1, "混合班级保留已核验结果");
  check(
    classRollup.counts.no_records + classRollup.counts.has_clues + classRollup.counts.confirmed_observed ===
      classRollup.total,
    "三类人数之和仍等于分母",
  );
  check(classRollup.confirmed_ratio === null, "partial 班级占比必须为 null");

  // 全部不可读仍为 unavailable
  const allBroken = rollupClassItem({
    children: [
      { childId: CHILD, observations: [makeObs({ id: OBS_C, guide_evidence: "broken" })] },
      { childId: OTHER_CHILD, observations: [makeObs({ id: OBS_D, guide_evidence: "broken" })] },
    ],
    item,
    observationById: new Map(),
    scope: ALL_SCOPE,
    classStage: "middle",
  });
  check(allBroken.reliability === "unavailable", "全部不可读仍为 unavailable");
}

function evaluateFor(link: GuideEvidenceLink, itemId: string) {
  const item = guideItemById(itemId);
  if (!item) throw new Error(`目录条目不存在：${itemId}`);
  const parsed = parseGuideEvidence(makeContainer([link]));
  if (parsed.kind !== "ok") throw new Error("容器应可解析");
  const source = makeObs({ id: link.basis[0]?.observation_id ?? OBS_A });
  const observationById = new Map<string, EvidenceObservation>([[source.id, source]]);
  return evaluateLink(parsed.links[0], item, CHILD, observationById, ALL_SCOPE, "child_history", null);
}

function testReadSupportConditions(): void {
  const cluePerformance = evaluateFor(
    makeLink({ id: "link-clue-perf", item_id: ITEM_ALLOWED, status: "confirmed_performance", support: "clue_only" }),
    ITEM_ALLOWED,
  );
  check(
    cluePerformance.counts_toward_status === false && cluePerformance.excluded_reason === "support_insufficient",
    "confirmed_performance + clue_only 不得计为表现",
  );

  const independenceHelp = evaluateFor(
    makeLink({
      id: "link-independence",
      item_id: ITEM_REQUIRES_INDEPENDENCE,
      status: "confirmed_performance",
      support: "single_event",
      adult_help_used: true,
      teacher_note: "扶助完成。",
    }),
    ITEM_REQUIRES_INDEPENDENCE,
  );
  check(
    independenceHelp.counts_toward_status === false &&
      independenceHelp.excluded_reason === "support_insufficient",
    "要求独立条目有成人帮助不得计为表现（支持条件不足）",
  );

  const helpWithoutNote = evaluateFor(
    makeLink({
      id: "link-help-no-note",
      item_id: ITEM_ALLOWED,
      status: "confirmed_performance",
      support: "single_event",
      adult_help_used: true,
      teacher_note: null,
    }),
    ITEM_ALLOWED,
  );
  check(
    helpWithoutNote.counts_toward_status === false,
    "成人帮助确认表现但未说明帮助方式不得计入",
  );

  const invalidNote = evaluateFor(
    makeLink({
      id: "link-invalid-note",
      item_id: ITEM_SUSTAINED,
      status: "confirmed_performance",
      support: "sustained",
      sustained_note: {
        period_start: "2026-02-30",
        period_end: "2026-09-30",
        description: "连续观察到主动表达的行为。",
      },
    }),
    ITEM_SUSTAINED,
  );
  check(
    invalidNote.counts_toward_status === false && invalidNote.excluded_reason === "support_insufficient",
    "纪要日期非法不得计入持续性表现",
  );

  const validNote = evaluateFor(
    makeLink({
      id: "link-valid-note",
      item_id: ITEM_SUSTAINED,
      status: "confirmed_performance",
      support: "sustained",
      sustained_note: {
        period_start: "2026-09-19",
        period_end: "2026-09-21",
        description: "连续观察到主动表达与轮流等待的行为。",
      },
    }),
    ITEM_SUSTAINED,
  );
  check(validNote.counts_toward_status === true, "合法纪要仍计入持续性表现");
}

/* ---------------- E) 审计依据独立核对 ---------------- */

function findItemView(book: ReturnType<typeof buildChildEvidenceBook>, itemId: string) {
  return book.goals.flatMap((goal) => goal.items).find((item) => item.item.id === itemId);
}

function testBasisAuditIndependence(): void {
  const withdrawn = makeLink({
    id: "link-withdrawn",
    item_id: ITEM_ALLOWED,
    status: "withdrawn",
    withdrawn_at: NOW,
    withdrawn_reason: "教师撤回",
  });
  const book = buildChildEvidenceBook({
    child: makeChild(),
    observations: [makeObs({ id: OBS_A, guide_evidence: makeContainer([withdrawn]) })],
    scope: ALL_SCOPE,
    filters: NO_FILTERS,
  });
  const view = findItemView(book, ITEM_ALLOWED);
  const linkView = view?.links.find((link) => link.link_id === "link-withdrawn");
  check(
    linkView?.basis[0]?.valid === true && linkView?.basis[0]?.invalid_reason === null,
    "有效撤回依据仍应 valid=true 且无假失败原因",
  );

  // 撤回后来源真的失效：valid=false 且给出真实原因
  const drifted = buildChildEvidenceBook({
    child: makeChild(),
    observations: [makeObs({ id: OBS_A, confirmed_at: T2, guide_evidence: makeContainer([withdrawn]) })],
    scope: ALL_SCOPE,
    filters: NO_FILTERS,
  });
  const driftedLink = findItemView(drifted, ITEM_ALLOWED)?.links.find((link) => link.link_id === "link-withdrawn");
  check(
    driftedLink?.basis[0]?.valid === false && driftedLink?.basis[0]?.invalid_reason === "version_mismatch",
    "撤回后来源失效应 valid=false 且原因为 version_mismatch",
  );

  // 不采用（rejected）依据独立展示
  const rejected = makeLink({
    id: "link-rejected",
    item_id: ITEM_ALLOWED,
    origin: "ai",
    status: "rejected",
    support: null,
    teacher_note: "不采用",
  });
  const rejectedBook = buildChildEvidenceBook({
    child: makeChild(),
    observations: [makeObs({ id: OBS_A, guide_evidence: makeContainer([rejected]) })],
    scope: ALL_SCOPE,
    filters: NO_FILTERS,
  });
  const rejectedLink = findItemView(rejectedBook, ITEM_ALLOWED)?.links.find((link) => link.link_id === "link-rejected");
  check(rejectedLink?.basis[0]?.valid === true, "不采用关联的有效依据仍应 valid=true");
  check(rejectedLink?.counts_toward_status === false, "不采用不进入正式状态");

  // 待核对（ai_suggested）依据给出真实核对结果
  const pending = makeLink({
    id: "link-pending",
    item_id: ITEM_ALLOWED,
    origin: "ai",
    status: "ai_suggested",
    support: null,
    decided_at: null,
  });
  const pendingBook = buildChildEvidenceBook({
    child: makeChild(),
    observations: [
      makeObs({
        id: OBS_A,
        status: "ai_organized",
        confirmed_content: null,
        confirmed_at: null,
        guide_evidence: makeContainer([pending]),
      }),
    ],
    scope: ALL_SCOPE,
    filters: NO_FILTERS,
  });
  const pendingLink = findItemView(pendingBook, ITEM_ALLOWED)?.links.find((link) => link.link_id === "link-pending");
  check(
    pendingLink?.basis[0]?.valid === false && pendingLink?.basis[0]?.invalid_reason === "not_confirmed",
    "待核对关联的依据应显示真实核对失败原因 not_confirmed",
  );

  // 旧目录关联的依据仍独立核对
  const oldCatalog = makeLink({
    id: "link-old-catalog",
    item_id: ITEM_ALLOWED,
    catalog_version: "moe-3-6-2012.v0",
  });
  const oldCatalogBook = buildChildEvidenceBook({
    child: makeChild(),
    observations: [makeObs({ id: OBS_A, guide_evidence: makeContainer([oldCatalog]) })],
    scope: ALL_SCOPE,
    filters: NO_FILTERS,
  });
  const oldCatalogLink = findItemView(oldCatalogBook, ITEM_ALLOWED)?.links.find(
    (link) => link.link_id === "link-old-catalog",
  );
  check(oldCatalogLink?.basis[0]?.valid === true, "旧目录排除不得等同于依据片段失效");
  check(oldCatalogLink?.counts_toward_status === false, "旧目录不进入正式状态");

  // mutation 响应使用一致规则
  const mutationViews = buildMutationLinkViews(
    [withdrawn],
    CHILD,
    new Map<string, EvidenceObservation>([[OBS_A, makeObs({ id: OBS_A })]]),
    guideItemById,
  );
  check(mutationViews[0]?.basis[0]?.valid === true, "mutation 响应中有效撤回依据仍 valid=true");
}

/* ---------------- F) AI 引用必须绑定明确来源 ---------------- */

function makeSuggestionObservation(rawText = RAW_A, id = OBS_A): Observation {
  return {
    ...makeObs({
      id,
      raw_text: rawText,
      status: "ai_organized",
      confirmed_content: null,
      confirmed_at: null,
    }),
    class_id: SNAPSHOT_MIDDLE.class_id,
    observed_class: null,
    ai_draft: null,
    ai_model: null,
    ai_organized_at: null,
    is_demo: false,
    created_at: "2026-09-20T00:00:00.000Z",
    updated_at: null,
    agent_context: null,
  } as Observation;
}

function testSuggestionSourceBinding(): void {
  const host = makeSuggestionObservation();
  const historical = makeObs({ id: OBS_B, observed_at: "2026-08-10" }) as unknown as Observation;
  const candidates = [guideItemById(ITEM_ALLOWED)].filter(
    (item): item is NonNullable<typeof item> => item !== null,
  );
  const output = (overrides: Partial<GuideSuggestionOutput["suggestions"][number]>) =>
    ({
      suggestions: [
        {
          item_id: ITEM_ALLOWED,
          reason: "在图书区的表达与轮流等待",
          quote: "请你先玩。",
          quote_source: "raw_text" as const,
          quote_field: "",
          quote_source_id: OBS_B,
          ...overrides,
        },
      ],
    }) as GuideSuggestionOutput;

  // 同句不同日期/情境：必须绑定模型声明的历史来源
  const bound = validateGuideSuggestionOutput(output({}), host, candidates, [historical]);
  check(bound.ok, "明确来源 id 的正确建议应通过");
  if (bound.ok) {
    check(bound.suggestions[0].source_observation_id === OBS_B, "建议必须绑定声明的来源 id");
    check(bound.suggestions[0].observed_at === "2026-08-10", "来源日期由服务端按 id 生成");
    check(bound.suggestions[0].source_confirmed_at === T1, "来源版本由服务端按 id 生成");
  }

  // 错误 ID
  const wrongId = validateGuideSuggestionOutput(output({ quote_source_id: "o-missing" }), host, candidates, [historical]);
  check(!wrongId.ok, "来源 id 不在可用范围必须拒绝");

  // 跨幼儿 ID：不在允许来源集合中
  const crossId = validateGuideSuggestionOutput(
    output({ quote_source_id: OBS_OTHER }),
    host,
    candidates,
    [historical],
  );
  check(!crossId.ok, "跨幼儿来源 id 必须拒绝");

  // 错误引用位置：片段不在声明来源的确认稿位置
  const wrongField = validateGuideSuggestionOutput(
    output({
      quote_source: "confirmed_content",
      quote_field: "highlight_quote",
      quote: "她在图书区安静地翻看绘本",
      quote_source_id: OBS_B,
    }),
    host,
    candidates,
    [historical],
  );
  check(!wrongField.ok, "引用位置与片段不符必须拒绝");

  // 虚构引用
  const fabricated = validateGuideSuggestionOutput(
    output({ quote: "编造的引用内容不存在" }),
    host,
    candidates,
    [historical],
  );
  check(!fabricated.ok, "虚构引用必须拒绝");
}

async function testSuggestionSchemaAndSaveGuard(): Promise<void> {
  const host = makeSuggestionObservation(RAW_SCORE);
  const candidates = [guideItemById(ITEM_ALLOWED)].filter(
    (item): item is NonNullable<typeof item> => item !== null,
  );
  const reply = (content: unknown) => async () => ({
    content: JSON.stringify(content),
    provider: "coze" as const,
    model: "offline-model",
  });
  const missingId = await generateGuideEvidenceSuggestions(host, {
    candidates,
    confirmedSources: [],
    invoke: reply({
      suggestions: [
        {
          item_id: ITEM_ALLOWED,
          reason: "表达了自己的想法",
          quote: "游戏不按分数排名",
          quote_source: "raw_text",
          quote_field: "",
        },
      ],
    }),
  });
  check(!missingId.ok, "缺少来源 id 的旧格式建议不得静默采用第一个匹配来源");

  const withId = await generateGuideEvidenceSuggestions(host, {
    candidates,
    confirmedSources: [],
    invoke: reply({
      suggestions: [
        {
          item_id: ITEM_ALLOWED,
          reason: "表达了自己的想法",
          quote: "游戏不按分数排名",
          quote_source: "raw_text",
          quote_field: "",
          quote_source_id: OBS_A,
        },
      ],
    }),
  });
  check(withId.ok, "带明确来源 id 的建议应通过（含否定评分事实引用）");
  if (withId.ok) {
    check(withId.suggestions[0].source_observation_id === OBS_A, "来源绑定当前观察 id");
  }

  // 保存前同步核对来源快照（纯函数；实现后由同一脚本验证）
  const runtimeModule = (await import("../src/lib/guide/runtime")) as unknown as Record<string, unknown>;
  const stillMatches = runtimeModule.suggestionSourceSnapshotStillMatches;
  if (typeof stillMatches === "function") {
    const matches = stillMatches as (
      snapshot: { source_observation_id: string; observed_at: string; source_confirmed_at: string | null },
      observationById: Map<string, EvidenceObservation>,
    ) => boolean;
    const current = new Map<string, EvidenceObservation>([
      [OBS_A, makeObs({ id: OBS_A, status: "ai_organized", confirmed_content: null, confirmed_at: null })],
    ]);
    check(
      matches(
        { source_observation_id: OBS_A, observed_at: "2026-09-20", source_confirmed_at: null },
        current,
      ) === true,
      "未归档来源未变化时保存前核对通过",
    );
    check(
      matches(
        { source_observation_id: OBS_A, observed_at: "2026-09-20", source_confirmed_at: null },
        new Map([[OBS_A, makeObs({ id: OBS_A })]]),
      ) === false,
      "来源归档后迟到建议必须冲突",
    );
    check(
      matches(
        { source_observation_id: OBS_A, observed_at: "2026-09-20", source_confirmed_at: T1 },
        new Map([[OBS_A, makeObs({ id: OBS_A, confirmed_at: T2 })]]),
      ) === false,
      "来源版本漂移时保存前核对失败",
    );
  } else {
    check(false, "缺少 suggestionSourceSnapshotStillMatches 保存前来源核对");
  }
}

/* ---------------- G) 事实引用不能被当作 AI 评分 ---------------- */

function testFactQuoteNotScored(): void {
  const host = makeSuggestionObservation(RAW_SCORE);
  const candidates = [guideItemById(ITEM_ALLOWED)].filter(
    (item): item is NonNullable<typeof item> => item !== null,
  );
  const output = (reason: string, quote = "游戏不按分数排名"): GuideSuggestionOutput =>
    ({
      suggestions: [
        {
          item_id: ITEM_ALLOWED,
          reason,
          quote,
          quote_source: "raw_text",
          quote_field: "",
          quote_source_id: OBS_A,
        },
      ],
    }) as GuideSuggestionOutput;

  const factQuote = validateGuideSuggestionOutput(output("表达了自己的想法。"), host, candidates, []);
  check(factQuote.ok, "真实原文含“分数”的事实引用不得被当作 AI 评分");

  const scoredReason = validateGuideSuggestionOutput(output("该幼儿得分高，排名领先。"), host, candidates, []);
  check(!scoredReason.ok, "AI 理由主动打分/排名仍必须拒绝");

  const diagnosedReason = validateGuideSuggestionOutput(output("建议诊断注意力缺陷。"), host, candidates, []);
  check(!diagnosedReason.ok, "AI 理由作出诊断仍必须拒绝");

  const fabricated = validateGuideSuggestionOutput(output("表达了自己的想法。", "编造的评分片段"), host, candidates, []);
  check(!fabricated.ok, "虚构引用仍必须拒绝");
}

async function main(): Promise<void> {
  const run = async (name: string, fn: () => void | Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      failures.push(`${name} 抛出异常：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  await run("A 宿主归档守门", testHostGuard);
  await run("B 目录版本守门", testCatalogVersionGuard);
  await run("B 来源版本漂移", testBasisVersionDrift);
  await run("B 空/非法版本", testNullAndInvalidVersion);
  await run("B 明确换用依据与幂等", testExplicitRebaseAndIdempotent);
  await run("D 读取可靠性", testReadReliability);
  await run("D 读取支持条件", testReadSupportConditions);
  await run("E 审计依据独立核对", testBasisAuditIndependence);
  await run("F 引用来源绑定", testSuggestionSourceBinding);
  await run("F 建议 schema 与保存前核对", testSuggestionSchemaAndSaveGuard);
  await run("G 事实引用守门", testFactQuoteNotScored);

  if (failures.length > 0) {
    console.error(JSON.stringify({ passed, failed: failures.length, failures }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ passed, total: passed, offline: true, r1: true }));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
