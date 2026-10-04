import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import {
  assertCleanupComplete,
  modelGuardEnv,
  restoreGeneratedArtifacts,
  runCleanupSteps,
  sleep,
  snapshotGeneratedArtifacts,
  startIsolatedPostgres,
  startModelRequestGuard,
  stopTrackedChildTree,
  trackChildProcess,
  waitForVerifiedService,
  type CleanupReport,
  type IsolatedPostgres,
  type ModelRequestGuard,
} from "./harness-safety";

import {
  GuideEvidenceConflictError,
  GuideEvidenceInvalidError,
} from "../src/lib/guide/decisions";
import { parseGuideEvidence } from "../src/lib/guide/runtime";
import {
  loadChildEvidenceBook,
  loadClassEvidenceOverview,
} from "../src/lib/guide/read-model";
import {
  applyGuideEvidenceMutation,
  applyGuideEvidenceMutationWithClient,
  confirmObservation,
  getObservation,
  saveGuideEvidenceSuggestionResult,
} from "../src/lib/queries";
import { GUIDE_CATALOG_VERSION } from "../src/lib/guide/types";
import type { GuideEvidenceDecisionParsed } from "../src/lib/validation";
import {
  query,
  queryOne,
  type TransactionClient,
} from "../src/storage/database/pg-client";
import type { Observation } from "../src/lib/types";

/**
 * G5 隔离实库检查（真实 PostgreSQL + 真实 HTTP + 受控双连接交错）。
 *
 * 资源安全（复用 scripts/harness-safety.ts）：
 * - 一次性本地容器：三态核实（已核实 / 明确不存在 / 无法核实），无法核实不删除也不报成功；
 *   写入前核验标签/回环映射/库身份/空库，清理按已核实容器 ID + 标签所有权并复核；
 * - dev server：就绪必须核实是本轮子进程（PID + 创建时间 + 端口监听者归属），
 *   任意 HTTP 200（含外部占位）不算就绪；写前用 HTTP 读模型与直连隔离库比对，
 *   首笔业务写后直连复核写入目标；清理只终止可核实属于本轮的进程树；
 * - 模型预算：provider 出口改道本地守门服务器，任何真实调用被计数并失败；
 * - 生成物：next-env.d.ts 与 .next 类型生成物按快照恢复，不整目录清空。
 *
 * 不回退 .env、外部 URL 或任何未知数据库。不调用真实模型。
 *
 * 运行：pnpm tsx scripts/check-guide-evidence-db.ts
 */

const RUN_ID = `${process.pid.toString(36)}${Date.now().toString(36)}`.toLowerCase();
const CONTAINER_NAME = `cga-g5-${RUN_ID}`;
const DB_NAME = `cga_g5_${RUN_ID}`;
const CONTAINER_LABEL_KEY = "cga-g5-check";
const TEACHER_PASSCODE = "g5-offline-passcode";
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const cleanupIssues: string[] = [];
function noteCleanupIssue(label: string, detail: string): void {
  cleanupIssues.push(`${label}: ${detail}`);
}

/* ------------------------------ 测试数据 ------------------------------ */

const ID = {
  classMiddle: "f5000000-0000-4000-8000-000000000001",
  classOther: "f5000000-0000-4000-8000-000000000002",
  child1: "f5100000-0000-4000-8000-000000000001",
  child2: "f5100000-0000-4000-8000-000000000002",
  child3: "f5100000-0000-4000-8000-000000000003",
  child4: "f5100000-0000-4000-8000-000000000004",
  child5: "f5100000-0000-4000-8000-000000000005",
  child6: "f5100000-0000-4000-8000-000000000006",
  child7: "f5100000-0000-4000-8000-000000000007",
  child8: "f5100000-0000-4000-8000-000000000008",
  obs1: "f5200000-0000-4000-8000-000000000001",
  obs2: "f5200000-0000-4000-8000-000000000002",
  obs3: "f5200000-0000-4000-8000-000000000003",
  obs4: "f5200000-0000-4000-8000-000000000004",
  obs5: "f5200000-0000-4000-8000-000000000005",
  obs6: "f5200000-0000-4000-8000-000000000006",
  obsRace: "f5200000-0000-4000-8000-000000000010",
  obsRaceB: "f5200000-0000-4000-8000-000000000011",
  obsLate: "f5200000-0000-4000-8000-000000000012",
  obsCorrupt: "f5200000-0000-4000-8000-000000000013",
  obsSelf: "f5200000-0000-4000-8000-000000000014",
  obsSelfRef: "f5200000-0000-4000-8000-000000000017",
  obsRollback: "f5200000-0000-4000-8000-000000000015",
  obsDeferred: "f5200000-0000-4000-8000-000000000016",
  obsFillerEvidence: "f5200000-0000-4000-8000-000000000020",
  enroll1: "f5300000-0000-4000-8000-000000000001",
  enroll2: "f5300000-0000-4000-8000-000000000002",
  enroll3: "f5300000-0000-4000-8000-000000000003",
  enroll4: "f5300000-0000-4000-8000-000000000004",
  enroll5old: "f5300000-0000-4000-8000-000000000005",
  enroll5new: "f5300000-0000-4000-8000-000000000006",
  enroll6: "f5300000-0000-4000-8000-000000000007",
  enroll7: "f5300000-0000-4000-8000-000000000008",
  enroll8: "f5300000-0000-4000-8000-000000000009",
} as const;

const ITEM_ALLOWED = "item.moe.language.listening_speaking.1.3-4.1";
const ITEM_ALLOWED_B = "item.moe.language.listening_speaking.1.3-4.2";
const ITEM_SUSTAINED = "item.moe.language.reading_writing.1.4-5.1";
const ITEM_HEALTH = "item.moe.health.physical.1.3-4.1";

const RAW_1 = "他把小汽车递给同伴，说：请你先玩。";
const QUOTE_1 = "请你先玩。";
const RAW_2 = "她在图书区安静地翻看绘本。";
const QUOTE_2 = "安静地翻看绘本";
const CONFIRMED_1 = {
  domain: "语言",
  sub_domain: "倾听与表达",
  objective_description: "这次记录中出现了主动轮流表达。",
  highlights: ["他说：请你先玩。"],
  support_suggestions: ["提供轮流表达的机会。"],
  highlight_quote: QUOTE_1,
};
const CONFIRMED_2 = {
  domain: "语言",
  sub_domain: "阅读与书写准备",
  objective_description: "这次记录中出现了安静阅读。",
  highlights: ["安静地翻看绘本。"],
  support_suggestions: ["提供安静阅读角。"],
  highlight_quote: QUOTE_2,
};
const MIDDLE_SNAPSHOT = {
  class_id: ID.classMiddle,
  class_name: "G5中班",
  stage: "middle" as const,
  school_year: "2026-2027",
  captured_at: "2026-09-01T00:00:00.000Z",
  source: "enrollment_lookup" as const,
  enrollment_id: ID.enroll1,
  confirmed_at: null,
};
const SMALL_SNAPSHOT = {
  class_id: ID.classOther,
  class_name: "G5小班",
  stage: "small" as const,
  school_year: "2025-2026",
  captured_at: "2025-09-01T00:00:00.000Z",
  source: "enrollment_lookup" as const,
  enrollment_id: ID.enroll5old,
  confirmed_at: null,
};

async function seed(client: Client): Promise<void> {
  const insert = async (sql: string, params: unknown[]) => {
    await client.query(sql, params);
  };
  await insert(
    `INSERT INTO classes (id, name, stage, school_year, is_active, is_demo) VALUES
       ($1, 'G5中班', 'middle', '2026-2027', true, false),
       ($2, 'G5小班', 'small', '2025-2026', true, false)`,
    [ID.classMiddle, ID.classOther],
  );
  const child = async (id: string, name: string) =>
    insert(
      `INSERT INTO children (id, name, gender, birth_date, class_name, is_demo)
       VALUES ($1, $2, '女', '2021-05-01', 'G5中班', false)`,
      [id, name],
    );
  await child(ID.child1, "幼儿一");
  await child(ID.child2, "幼儿二");
  await child(ID.child3, "幼儿三");
  await child(ID.child4, "幼儿四");
  await child(ID.child5, "幼儿五");
  await child(ID.child6, "幼儿六");
  await child(ID.child7, "幼儿七");
  await child(ID.child8, "幼儿八");
  const enroll = async (id: string, childId: string, classId: string, start: string, end: string | null) =>
    insert(
      `INSERT INTO child_class_enrollments (id, child_id, class_id, start_date, end_date)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, childId, classId, start, end],
    );
  await enroll(ID.enroll1, ID.child1, ID.classMiddle, "2026-09-01", null);
  await enroll(ID.enroll2, ID.child2, ID.classMiddle, "2026-09-01", null);
  await enroll(ID.enroll3, ID.child3, ID.classMiddle, "2026-09-01", null);
  await enroll(ID.enroll4, ID.child4, ID.classOther, "2026-09-01", null);
  await enroll(ID.enroll5old, ID.child5, ID.classMiddle, "2025-09-01", "2026-08-31");
  await enroll(ID.enroll5new, ID.child5, ID.classOther, "2026-09-01", null);
  await enroll(ID.enroll6, ID.child6, ID.classMiddle, "2026-09-01", null);
  await enroll(ID.enroll7, ID.child7, ID.classMiddle, "2026-09-01", null);
  await enroll(ID.enroll8, ID.child8, ID.classMiddle, "2026-09-01", null);

  const observation = async (input: {
    id: string;
    childId: string;
    observedAt: string;
    rawText: string;
    status: string;
    confirmedContent?: unknown;
    confirmedAt?: string | null;
    snapshot?: unknown;
    guideEvidence?: unknown;
    aiDraft?: unknown;
    agentContext?: unknown;
    classId?: string;
    createdAt?: string;
  }) =>
    insert(
      `INSERT INTO observations
         (id, child_id, class_id, observed_at, context, raw_text, status, ai_draft, agent_context,
          confirmed_content, confirmed_at, class_context_snapshot, guide_evidence, is_demo, created_at)
       VALUES ($1, $2, $3, $4, '区域活动', $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12::jsonb, false, COALESCE($13::timestamptz, now()))`,
      [
        input.id,
        input.childId,
        input.classId ?? ID.classMiddle,
        input.observedAt,
        input.rawText,
        input.status,
        input.aiDraft === undefined ? null : JSON.stringify(input.aiDraft),
        input.agentContext === undefined ? null : JSON.stringify(input.agentContext),
        input.confirmedContent === undefined ? null : JSON.stringify(input.confirmedContent),
        input.confirmedAt ?? null,
        input.snapshot === undefined ? JSON.stringify(MIDDLE_SNAPSHOT) : JSON.stringify(input.snapshot),
        input.guideEvidence === undefined ? null : JSON.stringify(input.guideEvidence),
        input.createdAt ?? null,
      ],
    );

  await observation({
    id: ID.obs1,
    childId: ID.child1,
    observedAt: "2026-09-20",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: "2026-09-21T02:00:00.000Z",
  });
  await observation({
    id: ID.obs2,
    childId: ID.child2,
    observedAt: "2026-09-22",
    rawText: RAW_2,
    status: "confirmed",
    confirmedContent: CONFIRMED_2,
    confirmedAt: "2026-09-23T02:00:00.000Z",
  });
  await observation({
    id: ID.obs3,
    childId: ID.child3,
    observedAt: "2026-09-24",
    rawText: "他把积木分给同伴。",
    status: "ai_organized",
    aiDraft: CONFIRMED_1,
  });
  await observation({
    id: ID.obs4,
    childId: ID.child2,
    observedAt: "2026-09-25",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: "2026-09-26T02:00:00.000Z",
  });
  await observation({
    id: ID.obs5,
    childId: ID.child5,
    observedAt: "2025-10-10",
    rawText: RAW_2,
    status: "confirmed",
    confirmedContent: CONFIRMED_2,
    confirmedAt: "2025-10-11T02:00:00.000Z",
    snapshot: SMALL_SNAPSHOT,
    classId: ID.classOther,
  });
  await observation({
    id: ID.obsRace,
    childId: ID.child1,
    observedAt: "2026-09-26",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: "2026-09-27T02:00:00.000Z",
  });
  await observation({
    id: ID.obsRaceB,
    childId: ID.child1,
    observedAt: "2026-09-27",
    rawText: RAW_2,
    status: "confirmed",
    confirmedContent: CONFIRMED_2,
    confirmedAt: "2026-09-28T02:00:00.000Z",
  });
  await observation({
    id: ID.obsLate,
    childId: ID.child1,
    observedAt: "2026-09-28",
    rawText: RAW_1,
    status: "ai_organized",
    aiDraft: CONFIRMED_1,
  });
  await observation({
    id: ID.obsCorrupt,
    childId: ID.child1,
    observedAt: "2026-09-29",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: "2026-09-30T02:00:00.000Z",
    guideEvidence: "broken-json-shape",
  });
  await observation({
    id: ID.obsSelf,
    childId: ID.child1,
    observedAt: "2026-09-30",
    rawText: RAW_1,
    status: "ai_organized",
    aiDraft: CONFIRMED_1,
  });
  await observation({
    id: ID.obsSelfRef,
    childId: ID.child1,
    observedAt: "2026-10-03",
    rawText: RAW_1,
    status: "ai_organized",
    aiDraft: CONFIRMED_1,
  });
  await observation({
    id: ID.obsRollback,
    childId: ID.child1,
    observedAt: "2026-10-01",
    rawText: RAW_1,
    status: "ai_organized",
    aiDraft: CONFIRMED_1,
  });
  const deferredReview = {
    decision: "clarify",
    summary: "需要澄清",
    change_summary: [],
    fact_check: "partially_supported",
    question: "这个行为出现过几次？",
    content_snapshot: {
      domain: CONFIRMED_1.domain,
      sub_domain: CONFIRMED_1.sub_domain,
      objective_description: "教师修改后的表述。",
      highlights: CONFIRMED_1.highlights,
      support_suggestions: CONFIRMED_1.support_suggestions,
      highlight_quote: CONFIRMED_1.highlight_quote,
    },
    clarification_snapshot: [],
    note_snapshot: "",
    reviewed_at: "2026-10-01T00:00:00.000Z",
  };
  await observation({
    id: ID.obsDeferred,
    childId: ID.child1,
    observedAt: "2026-10-02",
    rawText: RAW_1,
    status: "ai_organized",
    aiDraft: CONFIRMED_1,
    agentContext: { teacher_edit_review: deferredReview },
  });
  // 截断反例：最早创建的证据观察 + 1004 条更新的填充观察
  await observation({
    id: ID.obsFillerEvidence,
    childId: ID.child6,
    observedAt: "2026-09-01",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: "2026-09-02T02:00:00.000Z",
    createdAt: "2026-09-02T00:00:00.000Z",
    guideEvidence: {
      revision: 1,
      links: [
        {
          id: "f5400000-0000-4000-8000-000000000010",
          item_id: ITEM_ALLOWED,
          catalog_version: GUIDE_CATALOG_VERSION,
          origin: "manual",
          status: "confirmed_performance",
          support: "single_event",
          adult_help_used: false,
          basis: [
            {
              observation_id: ID.obsFillerEvidence,
              observed_at: "2026-09-01",
              quote: QUOTE_1,
              quote_source: "raw_text",
              quote_field: null,
              class_context: MIDDLE_SNAPSHOT,
              source_confirmed_at: "2026-09-02T02:00:00.000Z",
            },
          ],
          ai_reason: null,
          teacher_note: null,
          revision: 1,
          created_at: "2026-09-02T00:00:00.000Z",
          decided_at: "2026-09-02T00:00:00.000Z",
          withdrawn_at: null,
          withdrawn_reason: null,
        },
      ],
    },
  });
  await client.query(
    `INSERT INTO observations
       (child_id, class_id, observed_at, raw_text, status, class_context_snapshot, is_demo, created_at)
     SELECT $1, $2, '2026-09-10', '填充观察 ' || g, 'confirmed', $3::jsonb, false,
            '2026-09-20T00:00:00.000Z'::timestamptz + (g || ' seconds')::interval
       FROM generate_series(1, 1004) AS g`,
    [ID.child6, ID.classMiddle, JSON.stringify(MIDDLE_SNAPSHOT)],
  );
  // 损坏容器读模型：child7 一条可读 + 一条损坏；child8 只有损坏
  await observation({
    id: ID.obs6,
    childId: ID.child7,
    observedAt: "2026-09-15",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: "2026-09-16T02:00:00.000Z",
  });
  await observation({
    id: "f5200000-0000-4000-8000-000000000031",
    childId: ID.child7,
    observedAt: "2026-09-16",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: "2026-09-17T02:00:00.000Z",
    guideEvidence: { revision: 1, links: [{ id: "broken", item_id: ITEM_ALLOWED, status: "mystery" }] },
  });
  await observation({
    id: "f5200000-0000-4000-8000-000000000032",
    childId: ID.child8,
    observedAt: "2026-09-17",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: "2026-09-18T02:00:00.000Z",
    guideEvidence: "not-an-object",
  });
}

/* ------------------------------ 断言辅助 ------------------------------ */

let directPassed = 0;
let httpPassed = 0;
let currentPhase: "direct" | "http" = "direct";
function countPassed(): void {
  if (currentPhase === "http") httpPassed += 1;
  else directPassed += 1;
}
function ok(condition: boolean, message: string): void {
  assert.ok(condition, message);
  countPassed();
}
function eq<T>(actual: T, expected: T, message: string): void {
  assert.deepEqual(actual, expected, message);
  countPassed();
}

function manualDecision(
  itemId: string,
  observationId: string,
  quote: string,
): GuideEvidenceDecisionParsed {
  return {
    item_id: itemId,
    support: "single_event",
    basis: [{ observation_id: observationId, quote, quote_source: "raw_text" }],
  };
}

async function readRevision(observationId: string): Promise<number> {
  const row = await queryOne<{ guide_evidence: unknown }>(
    "SELECT guide_evidence FROM observations WHERE id = $1",
    [observationId],
  );
  const parsed = parseGuideEvidence(row?.guide_evidence ?? null);
  return parsed.kind === "unreadable" ? -1 : parsed.revision;
}

/* ------------------------------ 直接函数测试 ------------------------------ */

async function runDirectTests(): Promise<void> {
  /* D1) 同事务归档 + 手动关联 */
  const beforeSelf = await getObservation(ID.obs1);
  assert.ok(beforeSelf);
  const confirmed = await confirmObservation(
    ID.obsSelf,
    ID.child1,
    CONFIRMED_1,
    { status: "ai_organized", agentContext: null, aiDraft: CONFIRMED_1 },
    {
      expectedRevision: 0,
      decisions: [manualDecision(ITEM_ALLOWED, ID.obs1, QUOTE_1)],
    },
  );
  eq(confirmed.status, "confirmed", "同事务归档写入 confirmed");
  eq(confirmed.raw_text, RAW_1, "归档不改写 raw_text");
  const selfContainer = parseGuideEvidence(confirmed.guide_evidence);
  ok(selfContainer.kind === "ok" && selfContainer.links.length === 1, "归档同时写入关联");
  if (selfContainer.kind === "ok") {
    eq(selfContainer.revision, 1, "容器 revision=1");
    eq(
      Date.parse(String(selfContainer.links[0].basis[0].source_confirmed_at)),
      Date.parse("2026-09-21T02:00:00.000Z"),
      "依据版本来自来源观察",
    );
  }
  const afterSelf = await getObservation(ID.obsSelf);
  eq(afterSelf?.ai_draft?.objective_description, CONFIRMED_1.objective_description, "归档不改写 ai_draft");

  /* D1b) 当前观察作为依据：使用即将归档的确认稿与真实 confirmed_at */
  const selfDecision: GuideEvidenceDecisionParsed = {
    item_id: ITEM_ALLOWED,
    support: "single_event",
    basis: [
      { observation_id: ID.obsSelfRef, quote: QUOTE_1, quote_source: "raw_text" },
    ],
  };
  const deferredConfirmed = await confirmObservation(
    ID.obsSelfRef,
    ID.child1,
    CONFIRMED_1,
    { status: "ai_organized", agentContext: null, aiDraft: CONFIRMED_1 },
    { expectedRevision: 0, decisions: [selfDecision] },
  );
  const deferredContainer = parseGuideEvidence(deferredConfirmed.guide_evidence);
  ok(deferredContainer.kind === "ok" && deferredContainer.links.length === 1, "归档路径允许引用本次即将归档的观察");
  if (deferredContainer.kind === "ok") {
    eq(
      Date.parse(String(deferredContainer.links[0].basis[0].source_confirmed_at)),
      Date.parse(String(deferredConfirmed.confirmed_at)),
      "自引用依据版本等于本次实际 confirmed_at",
    );
  }

  /* D2) 无效决定导致归档整体回滚 */
  const rollbackBefore = await getObservation(ID.obsRollback);
  assert.ok(rollbackBefore);
  let rollbackError: unknown = null;
  try {
    await confirmObservation(
      ID.obsRollback,
      ID.child1,
      CONFIRMED_1,
      { status: "ai_organized", agentContext: null, aiDraft: CONFIRMED_1 },
      {
        expectedRevision: 0,
        decisions: [manualDecision(ITEM_ALLOWED, ID.obs1, "编造的不存在引用")],
      },
    );
  } catch (error) {
    rollbackError = error;
  }
  ok(rollbackError instanceof GuideEvidenceInvalidError, "无效关联决定抛出 invalid_request");
  const rollbackAfter = await getObservation(ID.obsRollback);
  eq(rollbackAfter?.status, "ai_organized", "归档随关联失败一起回滚（仍为未归档）");
  eq(rollbackAfter?.confirmed_content, null, "回滚后没有确认稿");
  eq(rollbackAfter?.guide_evidence, null, "回滚后没有关联写入");

  /* D3) 独立操作：手动关联 → 幂等 → 内容冲突 → 过期 revision */
  const manual = await applyGuideEvidenceMutation(ID.obs1, {
    action: "confirm",
    expected_guide_revision: 0,
    decisions: [manualDecision(ITEM_ALLOWED, ID.obs1, QUOTE_1)],
  });
  eq(manual.revision, 1, "手动关联 revision=1");
  eq(manual.links.length, 1, "返回全部关联");
  const linkId = manual.links[0].link_id;

  const repeat = await applyGuideEvidenceMutation(ID.obs1, {
    action: "confirm",
    expected_guide_revision: 1,
    decisions: [manualDecision(ITEM_ALLOWED, ID.obs1, QUOTE_1)],
  });
  eq(repeat.revision, 1, "完全相同的重复提交不增长 revision");
  eq(repeat.links.length, 1, "幂等不新增 link");

  let conflict: unknown = null;
  try {
    await applyGuideEvidenceMutation(ID.obs1, {
      action: "confirm",
      expected_guide_revision: 1,
      decisions: [manualDecision(ITEM_ALLOWED, ID.obs1, "把小汽车递给同伴")],
    });
  } catch (error) {
    conflict = error;
  }
  ok(conflict instanceof GuideEvidenceConflictError, "同条目内容不同返回 409");
  eq(await readRevision(ID.obs1), 1, "冲突不写入");

  let stale: unknown = null;
  try {
    await applyGuideEvidenceMutation(ID.obs1, {
      action: "confirm",
      expected_guide_revision: 0,
      decisions: [manualDecision(ITEM_ALLOWED_B, ID.obs1, QUOTE_1)],
    });
  } catch (error) {
    stale = error;
  }
  ok(stale instanceof GuideEvidenceConflictError, "过期 revision 返回 409");
  eq(await readRevision(ID.obs1), 1, "过期操作不写入");

  /* D4) reject / withdraw 终态与审计保留 */
  const aiLinkId = "f5400000-0000-4000-8000-000000000001";
  await query(
    `UPDATE observations SET guide_evidence = $2::jsonb WHERE id = $1`,
    [
      ID.obs3,
      JSON.stringify({
        revision: 1,
        links: [
          {
            id: aiLinkId,
            item_id: ITEM_ALLOWED,
            catalog_version: GUIDE_CATALOG_VERSION,
            origin: "ai",
            status: "ai_suggested",
            support: null,
            adult_help_used: false,
            basis: [
              {
                observation_id: ID.obs2,
                observed_at: "2026-09-22",
                quote: QUOTE_2,
                quote_source: "raw_text",
                quote_field: null,
                class_context: MIDDLE_SNAPSHOT,
                source_confirmed_at: "2026-09-23T02:00:00.000Z",
              },
            ],
            ai_reason: "与阅读行为相关",
            teacher_note: null,
            revision: 1,
            created_at: "2026-09-24T00:00:00.000Z",
            decided_at: null,
            withdrawn_at: null,
            withdrawn_reason: null,
          },
        ],
      }),
    ],
  );
  const rejected = await applyGuideEvidenceMutation(ID.obs3, {
    action: "reject",
    link_id: aiLinkId,
    expected_guide_revision: 1,
    reason: "与本次情境不符",
  });
  const rejectedLink = rejected.links[0] as unknown as Record<string, unknown>;
  eq(rejectedLink.status, "rejected", "拒绝写入终态");
  eq(rejectedLink.support, null, "拒绝 support 为 null");
  const rejectRepeat = await applyGuideEvidenceMutation(ID.obs3, {
    action: "reject",
    link_id: aiLinkId,
    expected_guide_revision: rejected.revision,
    reason: "与本次情境不符",
  });
  eq(rejectRepeat.revision, rejected.revision, "重复拒绝幂等");

  const withdrawn = await applyGuideEvidenceMutation(ID.obs1, {
    action: "withdraw",
    link_id: linkId,
    expected_guide_revision: 1,
    reason: "教师撤回",
  });
  const withdrawnLink = withdrawn.links.find(
    (link) => link.link_id === linkId,
  ) as unknown as Record<string, unknown>;
  eq(withdrawnLink.status, "withdrawn", "撤回写入终态");
  eq(withdrawnLink.support, "single_event", "撤回保留 support");
  ok(Boolean(withdrawnLink.withdrawn_at), "撤回记录时间");

  /* D5) 建议保存：成功追加、不重复已有条目、失败记录、损坏不重置 */
  const suggestion = {
    item_id: ITEM_ALLOWED,
    reason: "出现轮流表达",
    quote: QUOTE_1,
    quote_source: "raw_text" as const,
    quote_field: null,
    source_observation_id: ID.obs1,
    observed_at: "2026-09-20",
    class_context: MIDDLE_SNAPSHOT,
    source_confirmed_at: "2026-09-21T02:00:00.000Z",
  };
  const obsLateBefore = await getObservation(ID.obsLate);
  assert.ok(obsLateBefore);
  const suggested = await saveGuideEvidenceSuggestionResult(ID.obsLate, {
    expectedRevision: 0,
    expectedStatus: "ai_organized",
    expectedRawText: RAW_1,
    expectedAiDraft: CONFIRMED_1,
    expectedConfirmedContent: null,
    ok: true,
    model: "offline-model",
    suggestions: [suggestion],
  });
  eq(suggested.revision, 1, "建议写入 revision=1");
  eq(suggested.links.length, 1, "追加 ai_suggested");
  const suggestedContainer = parseGuideEvidence((await getObservation(ID.obsLate))?.guide_evidence);
  ok(
    suggestedContainer.kind === "ok" && suggestedContainer.raw.last_attempt !== undefined,
    "记录 last_attempt",
  );
  if (suggestedContainer.kind === "ok") {
    const attempt = suggestedContainer.raw.last_attempt as { ok: boolean; suggested_count: number };
    ok(attempt.ok === true && attempt.suggested_count === 1, "last_attempt ok 且计数正确");
  }

  // 过期 revision 的迟到建议被拒绝
  let lateConflict: unknown = null;
  try {
    await saveGuideEvidenceSuggestionResult(ID.obsLate, {
      expectedRevision: 0,
      expectedStatus: "ai_organized",
      expectedRawText: RAW_1,
      expectedAiDraft: CONFIRMED_1,
      expectedConfirmedContent: null,
      ok: true,
      model: "offline-model",
      suggestions: [{ ...suggestion, item_id: ITEM_SUSTAINED }],
    });
  } catch (error) {
    lateConflict = error;
  }
  ok(lateConflict instanceof GuideEvidenceConflictError, "迟到的建议不覆盖当前状态");

  // 已有任何关联（含拒绝/撤回历史）的条目不再追加
  const dupSave = await saveGuideEvidenceSuggestionResult(ID.obsLate, {
    expectedRevision: 1,
    expectedStatus: "ai_organized",
    expectedRawText: RAW_1,
    expectedAiDraft: CONFIRMED_1,
    expectedConfirmedContent: null,
    ok: true,
    model: "offline-model",
    suggestions: [suggestion],
  });
  eq(dupSave.revision, 1, "已有条目不重复追加、不增长 revision");
  eq(dupSave.links.length, 1, "link 数量不变");

  // 失败记录 last_attempt{ok:false}，不删除既有教师可见关联
  const failedSave = await saveGuideEvidenceSuggestionResult(ID.obsLate, {
    expectedRevision: 1,
    expectedStatus: "ai_organized",
    expectedRawText: RAW_1,
    expectedAiDraft: CONFIRMED_1,
    expectedConfirmedContent: null,
    ok: false,
    model: "offline-model",
    error: "模型两次输出均未通过核对",
    suggestions: [],
  });
  eq(failedSave.revision, 2, "失败也记录 last_attempt 并增长 revision");
  eq(failedSave.links.length, 1, "失败后保留既有建议关联");
  const failedContainer = parseGuideEvidence(
    (await getObservation(ID.obsLate))?.guide_evidence,
  );
  if (failedContainer.kind === "ok") {
    const attempt = failedContainer.raw.last_attempt as { ok: boolean; error?: string };
    ok(attempt.ok === false && Boolean(attempt.error), "失败原因写入 last_attempt");
  } else {
    assert.fail("失败写入后容器应可读取");
  }

  // 观察原文变化后保存前提不匹配
  await query("UPDATE observations SET raw_text = raw_text || '（教师补充）' WHERE id = $1", [ID.obsLate]);
  let premiseConflict: unknown = null;
  try {
    await saveGuideEvidenceSuggestionResult(ID.obsLate, {
      expectedRevision: 2,
      expectedStatus: "ai_organized",
      expectedRawText: RAW_1,
      expectedAiDraft: CONFIRMED_1,
      expectedConfirmedContent: null,
      ok: true,
      model: "offline-model",
      suggestions: [{ ...suggestion, item_id: ITEM_SUSTAINED }],
    });
  } catch (error) {
    premiseConflict = error;
  }
  ok(premiseConflict instanceof GuideEvidenceConflictError, "观察被修改后迟到建议返回 409");

  // 损坏容器：失败记录不写入、不重置；成功追加直接冲突
  const corruptBefore = await queryOne<{ guide_evidence: unknown }>(
    "SELECT guide_evidence FROM observations WHERE id = $1",
    [ID.obsCorrupt],
  );
  const corruptSave = await saveGuideEvidenceSuggestionResult(ID.obsCorrupt, {
    expectedRevision: 0,
    expectedStatus: "confirmed",
    expectedRawText: RAW_1,
    expectedAiDraft: null,
    expectedConfirmedContent: CONFIRMED_1,
    ok: false,
    model: "offline-model",
    error: "模型失败",
    suggestions: [],
  });
  eq(corruptSave.links.length, 0, "损坏容器失败记录不返回伪造关联");
  const corruptAfter = await queryOne<{ guide_evidence: unknown }>(
    "SELECT guide_evidence FROM observations WHERE id = $1",
    [ID.obsCorrupt],
  );
  eq(corruptAfter?.guide_evidence, corruptBefore?.guide_evidence, "损坏 JSON 不被重置或改写");
  let corruptAppend: unknown = null;
  try {
    await saveGuideEvidenceSuggestionResult(ID.obsCorrupt, {
      expectedRevision: 0,
      expectedStatus: "confirmed",
      expectedRawText: RAW_1,
      expectedAiDraft: null,
      expectedConfirmedContent: CONFIRMED_1,
      ok: true,
      model: "offline-model",
      suggestions: [suggestion],
    });
  } catch (error) {
    corruptAppend = error;
  }
  ok(corruptAppend instanceof GuideEvidenceConflictError, "损坏容器不允许追加建议");

  /* D6) 读模型：个人历史与班级口径 */
  const child1Book = await loadChildEvidenceBook(ID.child1, { scope: "all_history" });
  ok(child1Book.ok, "个人证据册读取成功");
  if (child1Book.ok) {
    const item = child1Book.value.goals
      .flatMap((goal) => goal.items)
      .find((entry) => entry.item.id === ITEM_ALLOWED);
    assert.ok(item);
    ok(
      item.status === "no_records" || item.status === "confirmed_observed",
      "个人证据册条目状态为正式三类之一",
    );
    ok(item.reliability === "partial", "损坏容器使个人条目 partial");
    ok(
      child1Book.value.notices.some((entry) => entry.code === "guide_evidence_unreadable"),
      "损坏容器产生可读性通知",
    );
  }

  const classOverview = await loadClassEvidenceOverview(ID.classMiddle, { scope: "all_history" });
  ok(classOverview.ok, "班级概览读取成功");
  if (classOverview.ok) {
    eq(classOverview.value.roster.child_count, 6, "名单为当前在班幼儿（不含转走与别班幼儿）");
    const allowedItem = classOverview.value.goals
      .flatMap((goal) => goal.items)
      .find((entry) => entry.item.id === ITEM_ALLOWED);
    assert.ok(allowedItem);
    eq(
      allowedItem.counts.confirmed_observed + allowedItem.counts.has_clues + allowedItem.counts.no_records,
      allowedItem.total,
      "三类人数之和等于分母",
    );
    const healthItem = classOverview.value.goals
      .flatMap((goal) => goal.items)
      .find((entry) => entry.item.id === ITEM_HEALTH);
    assert.ok(healthItem);
    eq(healthItem.confirmed_ratio, null, "保健参考不显示行为占比");
    ok(
      !classOverview.value.roster.children.some((child) => child.id === ID.child5),
      "转走幼儿不进入当前分母",
    );
  }

  const child5Book = await loadChildEvidenceBook(ID.child5, { scope: "all_history" });
  ok(child5Book.ok, "转走幼儿个人历史可读取");
  if (child5Book.ok) {
    const smallItem = child5Book.value.goals
      .flatMap((goal) => goal.items)
      .find((entry) => entry.item.id === ITEM_ALLOWED);
    assert.ok(smallItem);
    eq(smallItem.status, "no_records", "转走幼儿当前无有效关联（未在 D 阶段写入）");
  }

  /* D7) 截断反例：1005 条观察中最早一条承载证据 */
  const truncationBook = await loadChildEvidenceBook(ID.child6, { scope: "all_history" });
  ok(truncationBook.ok, "截断反例读取成功");
  if (truncationBook.ok) {
    const item = truncationBook.value.goals
      .flatMap((goal) => goal.items)
      .find((entry) => entry.item.id === ITEM_ALLOWED);
    assert.ok(item);
    ok(
      item.links.length > 0 || item.status !== "no_records",
      "统计不因列表默认 LIMIT 截断",
    );
  }

  /* D8) 损坏容器：部分损坏 partial / 全部损坏 unavailable */
  const child7Book = await loadChildEvidenceBook(ID.child7, { scope: "all_history" });
  const child8Book = await loadChildEvidenceBook(ID.child8, { scope: "all_history" });
  if (child7Book.ok) {
    const item = child7Book.value.goals.flatMap((goal) => goal.items)[0];
    eq(item.reliability, "partial", "部分损坏按 partial");
  }
  if (child8Book.ok) {
    const item = child8Book.value.goals.flatMap((goal) => goal.items)[0];
    eq(item.reliability, "unavailable", "全部不可读按 unavailable");
  }

  /* D9) 未归档路径（clarify）直接调用路由：返回 deferred，不写正式关联 */
  const { NextRequest } = await import("next/server");
  const { createSessionToken, TEACHER_COOKIE } = await import("../src/lib/auth");
  const confirmRoute = await import("../src/app/api/observations/[id]/confirm/route");
  const token = createSessionToken().token;
  const deferredSubmitted = {
    ...CONFIRMED_1,
    objective_description: "教师修改后的表述。",
  };
  const deferredResponse = await confirmRoute.POST(
    new NextRequest(`http://localhost/api/observations/${ID.obsDeferred}/confirm`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${TEACHER_COOKIE}=${encodeURIComponent(token)}`,
      },
      body: JSON.stringify({
        content: deferredSubmitted,
        guide_decisions: {
          expected_guide_revision: 0,
          decisions: [manualDecision(ITEM_ALLOWED, ID.obs1, QUOTE_1)],
        },
      }),
    }),
    { params: Promise.resolve({ id: ID.obsDeferred }) },
  );
  const deferredBody = (await deferredResponse.json()) as {
    guideEvidence?: { status: string };
  };
  eq(deferredResponse.status, 200, "clarify 路径返回 200");
  eq(deferredBody.guideEvidence?.status, "deferred", "未归档路径返回 deferred");
  const deferredAfter = await getObservation(ID.obsDeferred);
  eq(deferredAfter?.status, "ai_organized", "deferred 不归档观察");
  eq(deferredAfter?.guide_evidence, null, "deferred 不写正式关联");

  // 无教师身份：真实路由返回 401
  const unauthorizedResponse = await confirmRoute.POST(
    new NextRequest(`http://localhost/api/observations/${ID.obsDeferred}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: deferredSubmitted }),
    }),
    { params: Promise.resolve({ id: ID.obsDeferred }) },
  );
  eq(unauthorizedResponse.status, 401, "无教师身份不能写");
}

/* ------------------------------ 受控双连接交错 ------------------------------ */

async function runConcurrencyTest(url: string): Promise<void> {
  const clientA = new Client({ connectionString: url });
  const clientB = new Client({ connectionString: url });
  await clientA.connect();
  await clientB.connect();
  try {
    // A：真实实现，在自身事务内应用 D1 并持有行锁（不提交）
    await clientA.query("BEGIN");
    const aResult = await applyGuideEvidenceMutationWithClient(clientA as never, ID.obsRace, {
      action: "confirm",
      expected_guide_revision: 0,
      decisions: [manualDecision(ITEM_ALLOWED, ID.obsRace, QUOTE_1)],
    });
    eq(aResult.revision, 1, "交错 A 先应用 D1（未提交）");

    // B：真实实现，同一 revision 应用不同内容 D2 → 先阻塞在儿童行锁
    await clientB.query("BEGIN");
    const bPromise = applyGuideEvidenceMutationWithClient(clientB as never, ID.obsRace, {
      action: "confirm",
      expected_guide_revision: 0,
      decisions: [manualDecision(ITEM_ALLOWED_B, ID.obsRaceB, QUOTE_2)],
    });
    const bSettledEarly = await Promise.race([
      bPromise.then(() => true).catch(() => true),
      sleep(400).then(() => false),
    ]);
    ok(bSettledEarly === false, "B 在 A 持有行锁期间真实阻塞（非并发数量模拟）");

    await clientA.query("COMMIT");
    let bError: unknown = null;
    try {
      await bPromise;
    } catch (error) {
      bError = error;
    }
    ok(bError instanceof GuideEvidenceConflictError, "A 提交后 B 读到新 revision 并冲突（最多一个不同结果成功）");
    await clientB.query("ROLLBACK").catch(() => undefined);

    const finalRevision = await readRevision(ID.obsRace);
    eq(finalRevision, 1, "最终只有 A 的决定生效");
    const raceContainer = parseGuideEvidence(
      (await queryOne<{ guide_evidence: unknown }>("SELECT guide_evidence FROM observations WHERE id = $1", [ID.obsRace]))
        ?.guide_evidence,
    );
    ok(
      raceContainer.kind === "ok" && raceContainer.links.length === 1,
      "竞争后只保留一条关联",
    );

    // 幂等交错：B 提交完全相同内容 → A 提交后 B 返回 200 语义（changed=false）
    const clientC = new Client({ connectionString: url });
    const clientD = new Client({ connectionString: url });
    await clientC.connect();
    await clientD.connect();
    try {
      await clientC.query("BEGIN");
      await applyGuideEvidenceMutationWithClient(clientC as never, ID.obsRaceB, {
        action: "confirm",
        expected_guide_revision: 0,
        decisions: [manualDecision(ITEM_ALLOWED, ID.obsRace, QUOTE_1)],
      });
      await clientD.query("BEGIN");
      const dPromise = applyGuideEvidenceMutationWithClient(clientD as never, ID.obsRaceB, {
        action: "confirm",
        expected_guide_revision: 0,
        decisions: [manualDecision(ITEM_ALLOWED, ID.obsRace, QUOTE_1)],
      });
      const dSettledEarly = await Promise.race([
        dPromise.then(() => true).catch(() => true),
        sleep(400).then(() => false),
      ]);
      ok(dSettledEarly === false, "幂等交错同样真实阻塞");
      await clientC.query("COMMIT");
      const dResult = await dPromise;
      eq(dResult.revision, 1, "完全相同的重复决定幂等成功（不增长 revision）");
      await clientD.query("COMMIT");
    } finally {
      await clientC.end().catch(() => undefined);
      await clientD.end().catch(() => undefined);
    }
  } finally {
    await clientA.end().catch(() => undefined);
    await clientB.end().catch(() => undefined);
  }
}

/* ------------------------------ 真实 HTTP ------------------------------ */

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配回环端口"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

const httpAudit = {
  pid: -1,
  startedAt: null as string | null,
  ownerPids: [] as number[],
  stop: null as CleanupReport | null,
};

async function runHttpTests(url: string, guard: ModelRequestGuard): Promise<void> {
  currentPhase = "http";
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const logFile = `${process.env.TEMP ?? "."}\\g5-db-check-server-${RUN_ID}.log`;
  const logFd = fs.openSync(logFile, "w");
  const child = trackChildProcess(
    spawn(
      process.execPath,
      [
        `${ROOT}node_modules/next/dist/bin/next`,
        "dev",
        "-p",
        String(port),
        "--hostname",
        "127.0.0.1",
      ],
      {
        cwd: ROOT,
        env: { ...modelGuardEnv(guard, process.env), DATABASE_URL: url, TEACHER_PASSCODE },
        stdio: ["ignore", logFd, logFd],
      },
    ),
    { logFile },
  );
  httpAudit.pid = child.pid;
  httpAudit.startedAt = child.startedAt;

  try {
    const ready = await waitForVerifiedService({ base, port, child, timeoutMs: 180_000 });
    httpAudit.ownerPids = ready.ownerPids;
    ok(ready.ownerPids.length >= 1, "就绪服务监听者属于本轮子进程树（非任意 200）");

    // 写业务数据前的数据身份核验：HTTP 读模型必须与直连隔离库完全一致
    const directBook = await loadChildEvidenceBook(ID.child2, { scope: "all_history" });
    if (!directBook.ok) assert.fail("直连读取儿童2证据册失败");
    const identityResponse = await fetch(
      `${base}/api/children/${ID.child2}/evidence-book?scope=all_history`,
    );
    eq(identityResponse.status, 200, "写前身份核验：HTTP 读接口返回 200");
    const identityBody: unknown = await identityResponse.json();
    eq(
      JSON.stringify(identityBody),
      JSON.stringify(directBook.value),
      "写前身份核验：HTTP 读模型与直连隔离库一致（服务对应当前本轮数据库）",
    );

    // 1) 教师身份
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: TEACHER_PASSCODE }),
    });
    eq(login.status, 200, "教师登录成功");
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    ok(cookie.startsWith("cga_teacher="), "登录返回教师会话 cookie");

    // 2) 手动关联（不依赖 AI）
    const linkResponse = await fetch(`${base}/api/observations/${ID.obs4}/guide-evidence`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        action: "confirm",
        expected_guide_revision: 0,
        decisions: [
          {
            item_id: ITEM_ALLOWED,
            support: "clue_only",
            basis: [{ observation_id: ID.obs4, quote: QUOTE_1, quote_source: "raw_text" }],
          },
        ],
      }),
    });
    const linkBody = (await linkResponse.json()) as Record<string, unknown>;
    eq(linkResponse.status, 200, "真实 HTTP 手动关联成功");
    eq(linkBody.revision, 1, "HTTP 返回 revision=1");
    const directAfterWrite = await queryOne<{ guide_evidence: unknown }>(
      "SELECT guide_evidence FROM observations WHERE id = $1",
      [ID.obs4],
    );
    const directAfterWriteParsed = parseGuideEvidence(directAfterWrite?.guide_evidence);
    ok(
      directAfterWriteParsed.kind === "ok" && directAfterWriteParsed.revision === 1,
      "业务写入落在本轮隔离库（直连复核 revision=1）",
    );

    // 3) 个人 GET
    const bookResponse = await fetch(`${base}/api/children/${ID.child2}/evidence-book?scope=all_history`);
    eq(bookResponse.status, 200, "个人证据册 GET 200");
    const book = (await bookResponse.json()) as {
      goals: { items: { item: { id: string }; status: string; links: unknown[] }[] }[];
    };
    const bookItem = book.goals.flatMap((goal) => goal.items).find((entry) => entry.item.id === ITEM_ALLOWED);
    assert.ok(bookItem, "个人证据册包含目标条目");
    eq(bookItem.status, "has_clues", "个人证据册状态为已有相关线索");
    ok(bookItem.links.length >= 1, "个人证据册返回关联与来源");

    // 4) 班级 GET
    const overviewResponse = await fetch(`${base}/api/classes/${ID.classMiddle}/evidence-overview?scope=all_history`);
    eq(overviewResponse.status, 200, "班级概览 GET 200");
    const overview = (await overviewResponse.json()) as {
      roster: { child_count: number };
      goals: { items: { item: { id: string }; counts: Record<string, number>; total: number }[] }[];
    };
    eq(overview.roster.child_count, 6, "班级 GET 名单人数正确");
    const overviewItem = overview.goals.flatMap((goal) => goal.items).find((entry) => entry.item.id === ITEM_ALLOWED);
    assert.ok(overviewItem, "班级概览包含目标条目");
    eq(
      overviewItem.counts.confirmed_observed + overviewItem.counts.has_clues + overviewItem.counts.no_records,
      overviewItem.total,
      "班级 GET 三类之和等于分母",
    );

    // 5) 撤回
    const linkId = (linkBody.links as { link_id: string }[])[0]?.link_id;
    assert.ok(linkId, "HTTP 关联包含 link_id");
    const withdrawResponse = await fetch(`${base}/api/observations/${ID.obs4}/guide-evidence`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        action: "withdraw",
        link_id: linkId,
        expected_guide_revision: 1,
        reason: "HTTP 验收撤回",
      }),
    });
    const withdrawBody = (await withdrawResponse.json()) as { revision: number; links: { status: string; withdrawn_at: string | null }[] };
    eq(withdrawResponse.status, 200, "真实 HTTP 撤回成功");
    eq(withdrawBody.links[0].status, "withdrawn", "撤回后状态为 withdrawn");
    ok(Boolean(withdrawBody.links[0].withdrawn_at), "撤回记录时间");
    const afterWithdraw = await fetch(`${base}/api/children/${ID.child2}/evidence-book?scope=all_history`);
    const afterWithdrawBook = (await afterWithdraw.json()) as typeof book;
    const afterItem = afterWithdrawBook.goals
      .flatMap((goal) => goal.items)
      .find((entry) => entry.item.id === ITEM_ALLOWED);
    eq(afterItem?.status, "no_records", "撤回后不计入正式状态");

    // 6) 无身份写操作 → 401；读接口公开
    const unauthorized = await fetch(`${base}/api/observations/${ID.obs4}/guide-evidence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "suggest" }),
    });
    eq(unauthorized.status, 401, "无教师身份写操作返回 401");
    const publicBook = await fetch(`${base}/api/children/${ID.child2}/evidence-book?scope=all_history`);
    eq(publicBook.status, 200, "读接口公开可访问");
  } finally {
    await runCleanupSteps(
      [
        {
          label: "http-server",
          run: async () => {
            const report = await stopTrackedChildTree(child);
            httpAudit.stop = report;
            return report;
          },
        },
        {
          label: "http-log-fd",
          run: () => {
            try {
              fs.closeSync(logFd);
            } catch {
              // 已关闭
            }
          },
        },
      ],
      noteCleanupIssue,
    );
  }
}

/* ------------------------------ 主流程 ------------------------------ */

async function main(): Promise<void> {
  const artifacts = snapshotGeneratedArtifacts(ROOT);
  const guard = await startModelRequestGuard();
  const guardedEnv = modelGuardEnv(guard, process.env);
  process.env.LLM_PROVIDER = guardedEnv.LLM_PROVIDER;
  process.env.STEPFUN_API_KEY = guardedEnv.STEPFUN_API_KEY;
  process.env.STEPFUN_BASE_URL = guardedEnv.STEPFUN_BASE_URL;
  process.env.STEPFUN_MODEL = guardedEnv.STEPFUN_MODEL;
  process.env.STEPFUN_TIMEOUT_MS = guardedEnv.STEPFUN_TIMEOUT_MS;

  let started: IsolatedPostgres | null = null;
  let failure: unknown = null;
  let artifactReport: { restored: string[]; removed: string[]; issues: string[] } | null = null;
  try {
    started = await startIsolatedPostgres({
      runId: RUN_ID,
      containerName: CONTAINER_NAME,
      dbName: DB_NAME,
      labelKey: CONTAINER_LABEL_KEY,
      noteIssue: noteCleanupIssue,
    });
    process.env.DATABASE_URL = started.url;
    process.env.TEACHER_PASSCODE = TEACHER_PASSCODE;

    const schemaClient = new Client({ connectionString: started.url });
    await schemaClient.connect();
    try {
      await schemaClient.query(fs.readFileSync(`${ROOT}scripts/initialize-demo-db.sql`, "utf8"));
      await seed(schemaClient);
    } finally {
      await schemaClient.end();
    }

    await runDirectTests();
    await runConcurrencyTest(started.url);
    await runHttpTests(started.url, guard);
  } catch (error) {
    failure = error;
  } finally {
    await runCleanupSteps(
      [
        {
          label: "pg-pool",
          timeoutMs: 10_000,
          run: async () => {
            await globalThis.__pgPool?.end();
          },
        },
        {
          label: "container",
          timeoutMs: 30_000,
          run: () => started?.teardown() ?? { ok: true, detail: "本轮未创建容器" },
        },
        { label: "model-guard", run: () => guard.close() },
        {
          label: "generated-artifacts",
          run: () => {
            artifactReport = restoreGeneratedArtifacts(artifacts, ROOT);
            if (artifactReport.issues.length > 0) {
              return { ok: false, detail: artifactReport.issues.join("；") };
            }
            return { ok: true, detail: "" };
          },
        },
      ],
      noteCleanupIssue,
    );
  }

  if (guard.hits !== 0) {
    noteCleanupIssue(
      "model-guard",
      `检测到 ${guard.hits} 次真实模型请求：${guard.requestPaths.join(",")}`,
    );
  }
  if (failure) {
    if (cleanupIssues.length > 0) console.error(`清理问题：${cleanupIssues.join("；")}`);
    throw failure;
  }
  assertCleanupComplete(cleanupIssues);
  console.log(
    JSON.stringify({
      passed: directPassed + httpPassed,
      total: directPassed + httpPassed,
      direct: directPassed,
      http: httpPassed,
      concurrency: "controlled two-client interleave (real row lock)",
      database: "disposable-local-postgres (identity-verified before DDL)",
      resource_safety: {
        run_id: RUN_ID,
        container: started?.containerId.slice(0, 12) ?? "none",
        container_cleanup: "tri-state inspect + verified id + label ownership + post-rm verify",
        http_server: {
          pid: httpAudit.pid,
          started_at: httpAudit.startedAt,
          listener_owner_pids: httpAudit.ownerPids,
          stop: httpAudit.stop,
        },
        business_write_target: "direct re-read from isolated db after first HTTP write",
        generated_artifacts: artifactReport,
      },
      model_guard: {
        provider_redirect: "stepfun -> local guard",
        requests: guard.requestPaths,
      },
      real_model_requests: guard.hits,
    }),
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
