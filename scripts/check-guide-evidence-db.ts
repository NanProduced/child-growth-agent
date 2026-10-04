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
import { guideItemById } from "../src/lib/guide/item-index";
import { parseGuideEvidence } from "../src/lib/guide/runtime";
import {
  loadChildEvidenceBook,
  loadClassEvidenceOverview,
} from "../src/lib/guide/read-model";
import { generateGuideEvidenceSuggestions } from "../src/lib/guide/suggest";
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
 * 组合验收（G5-R1/R2 业务修复 + QA 安全装置同一候选）：
 * - A 宿主守门、B 版本与原子性、C 提交与响应（测试进程池注入）、D 读取与审计、
 *   E 引用定位、F 来源绑定（模型替身 + 真实库观察）、G 旧空版本恢复路线；
 * - 故障注入只存在于本测试进程，不新增产品开关；模型全部替身，真实请求守门计数为 0。
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
  classBroken: "f5000000-0000-4000-8000-000000000003",
  child1: "f5100000-0000-4000-8000-000000000001",
  child2: "f5100000-0000-4000-8000-000000000002",
  child3: "f5100000-0000-4000-8000-000000000003",
  child4: "f5100000-0000-4000-8000-000000000004",
  child5: "f5100000-0000-4000-8000-000000000005",
  child6: "f5100000-0000-4000-8000-000000000006",
  child7: "f5100000-0000-4000-8000-000000000007",
  child8: "f5100000-0000-4000-8000-000000000008",
  childGate: "f5100000-0000-4000-8000-000000000101",
  childRelBrokenOnly: "f5100000-0000-4000-8000-000000000102",
  childMixed: "f5100000-0000-4000-8000-000000000103",
  childAllBroken: "f5100000-0000-4000-8000-000000000104",
  childSupport: "f5100000-0000-4000-8000-000000000105",
  childQuote: "f5100000-0000-4000-8000-000000000106",
  childRecovery: "f5100000-0000-4000-8000-000000000107",
  childSuggest: "f5100000-0000-4000-8000-000000000108",
  childConfirm: "f5100000-0000-4000-8000-000000000109",
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
  obsGateSrc: "f5200000-0000-4000-8000-000000000101",
  obsGateDraft: "f5200000-0000-4000-8000-000000000102",
  obsGateNeeds: "f5200000-0000-4000-8000-000000000103",
  obsGateAi: "f5200000-0000-4000-8000-000000000104",
  obsGateConfirmed: "f5200000-0000-4000-8000-000000000105",
  obsGateIdentical: "f5200000-0000-4000-8000-000000000106",
  obsGateOldCatalog: "f5200000-0000-4000-8000-000000000107",
  obsGateDrift: "f5200000-0000-4000-8000-000000000108",
  obsGateDateDrift: "f5200000-0000-4000-8000-000000000109",
  obsGateEmptyVersion: "f5200000-0000-4000-8000-000000000110",
  obsGateInvalidVersion: "f5200000-0000-4000-8000-000000000111",
  obsGateBatch: "f5200000-0000-4000-8000-000000000112",
  obsGateFirstArchive: "f5200000-0000-4000-8000-000000000139",
  obsDriftSrc: "f5200000-0000-4000-8000-000000000113",
  obsDateSrc: "f5200000-0000-4000-8000-000000000114",
  obsRelBrokenOnly: "f5200000-0000-4000-8000-000000000115",
  obsMixed: "f5200000-0000-4000-8000-000000000116",
  obsAllBroken: "f5200000-0000-4000-8000-000000000117",
  obsSupClue: "f5200000-0000-4000-8000-000000000118",
  obsSupIndep: "f5200000-0000-4000-8000-000000000119",
  obsSupHelpNoNote: "f5200000-0000-4000-8000-000000000120",
  obsSupInvalidNote: "f5200000-0000-4000-8000-000000000121",
  obsQuoteSrc: "f5200000-0000-4000-8000-000000000122",
  obsQuoteHost: "f5200000-0000-4000-8000-000000000123",
  obsQuoteMulti: "f5200000-0000-4000-8000-000000000124",
  obsQuoteWrong: "f5200000-0000-4000-8000-000000000125",
  obsQuoteDrift: "f5200000-0000-4000-8000-000000000126",
  obsQuoteBatch: "f5200000-0000-4000-8000-000000000127",
  obsQuoteHttp: "f5200000-0000-4000-8000-000000000128",
  obsQuoteDriftSrc: "f5200000-0000-4000-8000-000000000129",
  obsRecovery: "f5200000-0000-4000-8000-000000000130",
  obsSuggestHost: "f5200000-0000-4000-8000-000000000131",
  obsSuggestHost2: "f5200000-0000-4000-8000-000000000132",
  obsSuggestSrc2: "f5200000-0000-4000-8000-000000000133",
  obsSuggestSrc3: "f5200000-0000-4000-8000-000000000134",
  obsSuggestFact: "f5200000-0000-4000-8000-000000000135",
  obsSuggestHist: "f5200000-0000-4000-8000-000000000136",
  obsConfirmHost: "f5200000-0000-4000-8000-000000000137",
  obsConfirmSrc: "f5200000-0000-4000-8000-000000000138",
  enroll1: "f5300000-0000-4000-8000-000000000001",
  enroll2: "f5300000-0000-4000-8000-000000000002",
  enroll3: "f5300000-0000-4000-8000-000000000003",
  enroll4: "f5300000-0000-4000-8000-000000000004",
  enroll5old: "f5300000-0000-4000-8000-000000000005",
  enroll5new: "f5300000-0000-4000-8000-000000000006",
  enroll6: "f5300000-0000-4000-8000-000000000007",
  enroll7: "f5300000-0000-4000-8000-000000000008",
  enroll8: "f5300000-0000-4000-8000-000000000009",
  enrollAllBroken: "f5300000-0000-4000-8000-000000000010",
} as const;

const ITEM_ALLOWED = "item.moe.language.listening_speaking.1.3-4.1";
const ITEM_ALLOWED_B = "item.moe.language.listening_speaking.1.3-4.2";
const ITEM_SUSTAINED = "item.moe.language.reading_writing.1.4-5.1";
const ITEM_HEALTH = "item.moe.health.physical.1.3-4.1";
const ITEM_REQUIRES_INDEPENDENCE = "item.moe.health.daily_living.1.5-6.2";

const T1 = "2026-09-21T02:00:00.000Z";
const T2 = "2026-09-30T02:00:00.000Z";

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
const CONTENT_BOTH = {
  ...CONFIRMED_1,
  highlights: [QUOTE_1],
  highlight_quote: QUOTE_1,
};
const RAW_SCORE = "他说：游戏不按分数排名。";
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

interface SeedBasisInput {
  observationId: string;
  observedAt: string;
  quote: string;
  quoteSource?: "raw_text" | "confirmed_content";
  quoteField?: string | null;
  sourceConfirmedAt?: string | null;
  classContext?: unknown;
}

interface SeedLinkInput {
  id: string;
  itemId: string;
  status?: string;
  origin?: string;
  support?: string | null;
  adultHelpUsed?: boolean;
  basis: SeedBasisInput | SeedBasisInput[];
  sustainedNote?: unknown;
  teacherNote?: string | null;
  revision?: number;
  catalogVersion?: string;
}

function seedBasis(input: SeedBasisInput): Record<string, unknown> {
  return {
    observation_id: input.observationId,
    observed_at: input.observedAt,
    quote: input.quote,
    quote_source: input.quoteSource ?? "raw_text",
    quote_field: input.quoteField ?? null,
    class_context: input.classContext === undefined ? MIDDLE_SNAPSHOT : input.classContext,
    source_confirmed_at: input.sourceConfirmedAt ?? null,
  };
}

function seedLink(input: SeedLinkInput): Record<string, unknown> {
  const bases = Array.isArray(input.basis) ? input.basis : [input.basis];
  return {
    id: input.id,
    item_id: input.itemId,
    catalog_version: input.catalogVersion ?? GUIDE_CATALOG_VERSION,
    origin: input.origin ?? "ai",
    status: input.status ?? "ai_suggested",
    support: input.support ?? null,
    adult_help_used: input.adultHelpUsed ?? false,
    basis: bases.map(seedBasis),
    ...(input.sustainedNote === undefined ? {} : { sustained_note: input.sustainedNote }),
    ai_reason: "离线组合检查",
    teacher_note: input.teacherNote ?? null,
    revision: input.revision ?? 1,
    created_at: "2026-09-01T00:00:00.000Z",
    decided_at: null,
    withdrawn_at: null,
    withdrawn_reason: null,
  };
}

function seedContainer(links: unknown[], revision = 1): { revision: number; links: unknown[] } {
  return { revision, links };
}

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

  /* ------------------- 组合验收 fixture（G5-R1/R2 + QA 装置） ------------------- */

  await insert(
    `INSERT INTO classes (id, name, stage, school_year, is_active, is_demo)
     VALUES ($1, 'G5损坏班', 'middle', '2026-2027', true, false)`,
    [ID.classBroken],
  );
  for (const [childId, name] of [
    [ID.childGate, "守门幼儿"],
    [ID.childRelBrokenOnly, "损坏容器幼儿"],
    [ID.childMixed, "混合容器幼儿"],
    [ID.childAllBroken, "全班损坏幼儿"],
    [ID.childSupport, "支持条件幼儿"],
    [ID.childQuote, "引用定位幼儿"],
    [ID.childRecovery, "恢复路线幼儿"],
    [ID.childSuggest, "建议来源幼儿"],
    [ID.childConfirm, "提交响应幼儿"],
  ] as const) {
    await child(childId, name);
  }
  await enroll(ID.enrollAllBroken, ID.childAllBroken, ID.classBroken, "2026-09-01", null);

  // A 宿主守门：同一 confirmed 来源 + 三种未归档宿主 + 已归档宿主 + 完全重复宿主
  await observation({
    id: ID.obsGateSrc,
    childId: ID.childGate,
    observedAt: "2026-09-20",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: T1,
  });
  const gateAiLink = () =>
    seedLink({
      id: "gate-ai",
      itemId: ITEM_ALLOWED,
      basis: { observationId: ID.obsGateSrc, observedAt: "2026-09-20", quote: QUOTE_1, sourceConfirmedAt: T1 },
    });
  for (const [obsId, status] of [
    [ID.obsGateDraft, "draft"],
    [ID.obsGateNeeds, "needs_input"],
    [ID.obsGateAi, "ai_organized"],
  ] as const) {
    await observation({
      id: obsId,
      childId: ID.childGate,
      observedAt: "2026-09-21",
      rawText: RAW_1,
      status,
      aiDraft: CONFIRMED_1,
      guideEvidence: seedContainer([gateAiLink()]),
    });
  }
  await observation({
    id: ID.obsGateConfirmed,
    childId: ID.childGate,
    observedAt: "2026-09-23",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: T1,
  });
  await observation({
    id: ID.obsGateIdentical,
    childId: ID.childGate,
    observedAt: "2026-09-24",
    rawText: RAW_1,
    status: "ai_organized",
    aiDraft: CONFIRMED_1,
    guideEvidence: seedContainer([
      seedLink({
        id: "gate-identical",
        itemId: ITEM_ALLOWED,
        status: "confirmed_performance",
        support: "single_event",
        basis: { observationId: ID.obsGateSrc, observedAt: "2026-09-20", quote: QUOTE_1, sourceConfirmedAt: T1 },
      }),
    ]),
  });

  // B 版本与原子性：漂移来源 / 日期来源 / 旧目录 / 空版本 / 非法版本 / 批量
  await observation({
    id: ID.obsDriftSrc,
    childId: ID.childGate,
    observedAt: "2026-09-20",
    rawText: RAW_2,
    status: "confirmed",
    confirmedContent: CONFIRMED_2,
    confirmedAt: T1,
  });
  await observation({
    id: ID.obsDateSrc,
    childId: ID.childGate,
    observedAt: "2026-09-20",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: T1,
  });
  await observation({
    id: ID.obsGateOldCatalog,
    childId: ID.childGate,
    observedAt: "2026-09-25",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: T1,
    guideEvidence: seedContainer([
      seedLink({
        id: "gate-old-catalog",
        itemId: ITEM_ALLOWED,
        catalogVersion: "moe-3-6-2012.v0",
        basis: { observationId: ID.obsGateSrc, observedAt: "2026-09-20", quote: QUOTE_1, sourceConfirmedAt: T1 },
      }),
    ]),
  });
  await observation({
    id: ID.obsGateDrift,
    childId: ID.childGate,
    observedAt: "2026-09-26",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: T1,
    guideEvidence: seedContainer([
      seedLink({
        id: "gate-drift",
        itemId: ITEM_ALLOWED,
        basis: { observationId: ID.obsDriftSrc, observedAt: "2026-09-20", quote: QUOTE_2, sourceConfirmedAt: T1 },
      }),
    ]),
  });
  await observation({
    id: ID.obsGateDateDrift,
    childId: ID.childGate,
    observedAt: "2026-09-27",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: T1,
    guideEvidence: seedContainer([
      seedLink({
        id: "gate-date-drift",
        itemId: ITEM_ALLOWED,
        basis: { observationId: ID.obsDateSrc, observedAt: "2026-09-20", quote: QUOTE_1, sourceConfirmedAt: T1 },
      }),
    ]),
  });
  await observation({
    id: ID.obsGateEmptyVersion,
    childId: ID.childGate,
    observedAt: "2026-09-28",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: T1,
    guideEvidence: seedContainer([
      seedLink({
        id: "gate-empty-version",
        itemId: ITEM_ALLOWED,
        basis: { observationId: ID.obsGateSrc, observedAt: "2026-09-20", quote: QUOTE_1, sourceConfirmedAt: null },
      }),
    ]),
  });
  await observation({
    id: ID.obsGateInvalidVersion,
    childId: ID.childGate,
    observedAt: "2026-09-29",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: T1,
    guideEvidence: seedContainer([
      seedLink({
        id: "gate-invalid-version",
        itemId: ITEM_ALLOWED,
        basis: {
          observationId: ID.obsGateSrc,
          observedAt: "2026-09-20",
          quote: QUOTE_1,
          sourceConfirmedAt: "not-a-date",
        },
      }),
    ]),
  });
  await observation({
    id: ID.obsGateBatch,
    childId: ID.childGate,
    observedAt: "2026-09-30",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: T1,
    guideEvidence: seedContainer([
      seedLink({
        id: "gate-batch-valid",
        itemId: ITEM_ALLOWED,
        basis: { observationId: ID.obsGateSrc, observedAt: "2026-09-20", quote: QUOTE_1, sourceConfirmedAt: T1 },
      }),
      seedLink({
        id: "gate-batch-drift",
        itemId: ITEM_ALLOWED_B,
        basis: { observationId: ID.obsDriftSrc, observedAt: "2026-09-20", quote: QUOTE_2, sourceConfirmedAt: T1 },
      }),
    ]),
  });
  await observation({
    id: ID.obsGateFirstArchive,
    childId: ID.childGate,
    observedAt: "2026-10-01",
    rawText: RAW_1,
    status: "ai_organized",
    aiDraft: CONFIRMED_1,
  });

  // D 读取与审计：缺 item_id / 有效+未知 / 全部损坏 / 四类支持条件
  const brokenOnlyLink = seedLink({
    id: "rel-broken",
    itemId: ITEM_ALLOWED,
    status: "confirmed_performance",
    support: "single_event",
    basis: { observationId: ID.obsRelBrokenOnly, observedAt: "2026-09-20", quote: QUOTE_1, sourceConfirmedAt: T1 },
  });
  delete (brokenOnlyLink as Record<string, unknown>).item_id;
  await observation({
    id: ID.obsRelBrokenOnly,
    childId: ID.childRelBrokenOnly,
    observedAt: "2026-09-20",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: T1,
    guideEvidence: seedContainer([brokenOnlyLink]),
  });
  await observation({
    id: ID.obsMixed,
    childId: ID.childMixed,
    observedAt: "2026-09-20",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: T1,
    guideEvidence: seedContainer([
      seedLink({
        id: "rel-valid",
        itemId: ITEM_ALLOWED,
        status: "confirmed_performance",
        support: "single_event",
        basis: { observationId: ID.obsMixed, observedAt: "2026-09-20", quote: QUOTE_1, sourceConfirmedAt: T1 },
      }),
      {
        ...seedLink({
          id: "rel-unknown",
          itemId: ITEM_ALLOWED,
          basis: { observationId: ID.obsMixed, observedAt: "2026-09-20", quote: QUOTE_1, sourceConfirmedAt: T1 },
        }),
        status: "mystery",
      },
    ]),
  });
  await observation({
    id: ID.obsAllBroken,
    childId: ID.childAllBroken,
    observedAt: "2026-09-20",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: T1,
    classId: ID.classBroken,
    guideEvidence: "not-an-object",
  });
  const selfBasis = (obsId: string, quote: string): SeedBasisInput => ({
    observationId: obsId,
    observedAt: "2026-09-20",
    quote,
    sourceConfirmedAt: T1,
  });
  await observation({
    id: ID.obsSupClue,
    childId: ID.childSupport,
    observedAt: "2026-09-20",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: T1,
    guideEvidence: seedContainer([
      seedLink({
        id: "sup-clue",
        itemId: ITEM_ALLOWED,
        status: "confirmed_performance",
        support: "clue_only",
        basis: selfBasis(ID.obsSupClue, QUOTE_1),
      }),
    ]),
  });
  await observation({
    id: ID.obsSupIndep,
    childId: ID.childSupport,
    observedAt: "2026-09-21",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: T1,
    guideEvidence: seedContainer([
      seedLink({
        id: "sup-indep",
        itemId: ITEM_REQUIRES_INDEPENDENCE,
        status: "confirmed_performance",
        support: "single_event",
        adultHelpUsed: true,
        teacherNote: "扶助完成。",
        basis: selfBasis(ID.obsSupIndep, QUOTE_1),
      }),
    ]),
  });
  await observation({
    id: ID.obsSupHelpNoNote,
    childId: ID.childSupport,
    observedAt: "2026-09-22",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: T1,
    guideEvidence: seedContainer([
      seedLink({
        id: "sup-help-no-note",
        itemId: ITEM_ALLOWED_B,
        status: "confirmed_performance",
        support: "single_event",
        adultHelpUsed: true,
        basis: selfBasis(ID.obsSupHelpNoNote, QUOTE_1),
      }),
    ]),
  });
  await observation({
    id: ID.obsSupInvalidNote,
    childId: ID.childSupport,
    observedAt: "2026-09-23",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: T1,
    guideEvidence: seedContainer([
      seedLink({
        id: "sup-invalid-note",
        itemId: ITEM_SUSTAINED,
        status: "confirmed_performance",
        support: "sustained",
        sustainedNote: {
          period_start: "2026-02-30",
          period_end: "2026-09-30",
          description: "连续观察到主动表达的行为。",
        },
        basis: selfBasis(ID.obsSupInvalidNote, QUOTE_1),
      }),
    ]),
  });

  // E 引用定位：同句双字段来源 + 各定位宿主
  await observation({
    id: ID.obsQuoteSrc,
    childId: ID.childQuote,
    observedAt: "2026-09-20",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONTENT_BOTH,
    confirmedAt: T1,
  });
  await observation({
    id: ID.obsQuoteDriftSrc,
    childId: ID.childQuote,
    observedAt: "2026-09-20",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONTENT_BOTH,
    confirmedAt: T1,
  });
  const quoteFieldBasis = (obsId: string, field: "highlight_quote" | "highlights"): SeedBasisInput => ({
    observationId: obsId,
    observedAt: "2026-09-20",
    quote: QUOTE_1,
    quoteSource: "confirmed_content",
    quoteField: field,
    sourceConfirmedAt: T1,
  });
  await observation({
    id: ID.obsQuoteHost,
    childId: ID.childQuote,
    observedAt: "2026-09-21",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: T1,
    guideEvidence: seedContainer([
      seedLink({ id: "quote-host", itemId: ITEM_ALLOWED, basis: quoteFieldBasis(ID.obsQuoteSrc, "highlight_quote") }),
    ]),
  });
  await observation({
    id: ID.obsQuoteMulti,
    childId: ID.childQuote,
    observedAt: "2026-09-22",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: T1,
    guideEvidence: seedContainer([
      seedLink({
        id: "quote-multi",
        itemId: ITEM_ALLOWED,
        basis: [quoteFieldBasis(ID.obsQuoteSrc, "highlight_quote"), quoteFieldBasis(ID.obsQuoteSrc, "highlights")],
      }),
    ]),
  });
  await observation({
    id: ID.obsQuoteWrong,
    childId: ID.childQuote,
    observedAt: "2026-09-23",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: T1,
    guideEvidence: seedContainer([
      seedLink({ id: "quote-wrong", itemId: ITEM_ALLOWED, basis: quoteFieldBasis(ID.obsQuoteSrc, "highlight_quote") }),
    ]),
  });
  await observation({
    id: ID.obsQuoteDrift,
    childId: ID.childQuote,
    observedAt: "2026-09-24",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: T1,
    guideEvidence: seedContainer([
      seedLink({ id: "quote-drift", itemId: ITEM_ALLOWED, basis: quoteFieldBasis(ID.obsQuoteDriftSrc, "highlight_quote") }),
    ]),
  });
  await observation({
    id: ID.obsQuoteBatch,
    childId: ID.childQuote,
    observedAt: "2026-09-25",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: T1,
    guideEvidence: seedContainer([
      seedLink({ id: "quote-batch-valid", itemId: ITEM_ALLOWED, basis: quoteFieldBasis(ID.obsQuoteSrc, "highlight_quote") }),
      seedLink({
        id: "quote-batch-drift",
        itemId: ITEM_ALLOWED_B,
        basis: quoteFieldBasis(ID.obsQuoteDriftSrc, "highlight_quote"),
      }),
    ]),
  });
  await observation({
    id: ID.obsQuoteHttp,
    childId: ID.childQuote,
    observedAt: "2026-09-26",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: T1,
    guideEvidence: seedContainer([
      seedLink({ id: "quote-http", itemId: ITEM_ALLOWED, basis: quoteFieldBasis(ID.obsQuoteSrc, "highlight_quote") }),
    ]),
  });

  // G 恢复路线：已归档宿主 + 旧空版本建议
  await observation({
    id: ID.obsRecovery,
    childId: ID.childRecovery,
    observedAt: "2026-09-20",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: T2,
    guideEvidence: seedContainer([
      seedLink({
        id: "recovery-old",
        itemId: ITEM_ALLOWED,
        basis: { observationId: ID.obsRecovery, observedAt: "2026-09-20", quote: QUOTE_1, sourceConfirmedAt: null },
      }),
    ]),
  });

  // F 来源绑定与保存前核对
  await observation({
    id: ID.obsSuggestSrc2,
    childId: ID.childSuggest,
    observedAt: "2026-09-20",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: T1,
  });
  await observation({
    id: ID.obsSuggestSrc3,
    childId: ID.childSuggest,
    observedAt: "2026-09-20",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: T1,
  });
  await observation({
    id: ID.obsSuggestHost,
    childId: ID.childSuggest,
    observedAt: "2026-09-21",
    rawText: RAW_1,
    status: "ai_organized",
    aiDraft: CONFIRMED_1,
  });
  await observation({
    id: ID.obsSuggestHost2,
    childId: ID.childSuggest,
    observedAt: "2026-09-22",
    rawText: RAW_1,
    status: "ai_organized",
    aiDraft: CONFIRMED_1,
  });
  await observation({
    id: ID.obsSuggestFact,
    childId: ID.childSuggest,
    observedAt: "2026-09-23",
    rawText: RAW_SCORE,
    status: "ai_organized",
    aiDraft: CONFIRMED_1,
  });
  await observation({
    id: ID.obsSuggestHist,
    childId: ID.childSuggest,
    observedAt: "2026-09-10",
    rawText: RAW_SCORE,
    status: "confirmed",
    confirmedContent: CONFIRMED_2,
    confirmedAt: T1,
  });

  // C 提交与响应：归档 + 关联已提交后详情补查失败（测试进程注入）
  await observation({
    id: ID.obsConfirmSrc,
    childId: ID.childConfirm,
    observedAt: "2026-09-20",
    rawText: RAW_1,
    status: "confirmed",
    confirmedContent: CONFIRMED_1,
    confirmedAt: T1,
  });
  await observation({
    id: ID.obsConfirmHost,
    childId: ID.childConfirm,
    observedAt: "2026-09-21",
    rawText: RAW_1,
    status: "ai_organized",
    aiDraft: CONFIRMED_1,
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

function errorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

async function expectErrorCode(
  action: () => Promise<unknown>,
  expected: string,
  message: string,
): Promise<void> {
  let code: string | null = null;
  try {
    await action();
  } catch (error) {
    code = errorCode(error);
  }
  eq(code, expected, message);
}

function findGoalItem<T extends { item: { id: string } }>(
  view: { goals: { items: T[] }[] },
  itemId: string,
): T | undefined {
  return view.goals.flatMap((goal) => goal.items).find((entry) => entry.item.id === itemId);
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

  /* D4) reject / withdraw 终态与审计保留（R1 起独立操作只作用于已归档宿主，先把 obs3 归档） */
  const aiLinkId = "f5400000-0000-4000-8000-000000000001";
  await query(
    `UPDATE observations
        SET guide_evidence = $2::jsonb, status = 'confirmed', confirmed_content = $3::jsonb, confirmed_at = $4
      WHERE id = $1`,
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
      JSON.stringify(CONFIRMED_1),
      "2026-09-25T02:00:00.000Z",
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

/* ------------------------------ 组合业务验收（G5-R1/R2 + QA 装置） ------------------------------ */

async function runComboHostGuardTests(): Promise<void> {
  const gateDecision = {
    item_id: ITEM_ALLOWED,
    support: "single_event" as const,
    basis: [{ observation_id: ID.obsGateSrc, quote: QUOTE_1, quote_source: "raw_text" as const }],
  };
  const hosts = [
    ["draft", ID.obsGateDraft],
    ["needs_input", ID.obsGateNeeds],
    ["ai_organized", ID.obsGateAi],
  ] as const;
  for (const [status, obsId] of hosts) {
    const before = await readRevision(obsId);
    await expectErrorCode(
      () =>
        applyGuideEvidenceMutation(obsId, {
          action: "confirm",
          expected_guide_revision: before,
          decisions: [gateDecision],
        }),
      "state_conflict",
      `${status} 宿主独立 confirm 必须 409 state_conflict`,
    );
    await expectErrorCode(
      () =>
        applyGuideEvidenceMutation(obsId, {
          action: "confirm",
          expected_guide_revision: before,
          decisions: [gateDecision],
        }),
      "state_conflict",
      `${status} 宿主幂等重复 confirm 仍必须 409`,
    );
    await expectErrorCode(
      () =>
        applyGuideEvidenceMutation(obsId, {
          action: "reject",
          link_id: "gate-ai",
          expected_guide_revision: before,
          reason: "组合检查",
        }),
      "state_conflict",
      `${status} 宿主独立 reject 必须 409 state_conflict`,
    );
    await expectErrorCode(
      () =>
        applyGuideEvidenceMutation(obsId, {
          action: "reject",
          link_id: "gate-ai",
          expected_guide_revision: before,
          reason: "组合检查",
        }),
      "state_conflict",
      `${status} 宿主重复 reject 仍必须 409`,
    );
    await expectErrorCode(
      () =>
        applyGuideEvidenceMutation(obsId, {
          action: "withdraw",
          link_id: "gate-ai",
          expected_guide_revision: before,
          reason: "组合检查",
        }),
      "state_conflict",
      `${status} 宿主独立 withdraw 必须 409 state_conflict`,
    );
    await expectErrorCode(
      () =>
        applyGuideEvidenceMutation(obsId, {
          action: "withdraw",
          link_id: "gate-ai",
          expected_guide_revision: before,
          reason: "组合检查",
        }),
      "state_conflict",
      `${status} 宿主重复 withdraw 仍必须 409`,
    );
    eq(await readRevision(obsId), before, `${status} 宿主被拒后 revision 与容器不变`);
  }

  const identicalBefore = await readRevision(ID.obsGateIdentical);
  await expectErrorCode(
    () =>
      applyGuideEvidenceMutation(ID.obsGateIdentical, {
        action: "confirm",
        expected_guide_revision: identicalBefore,
        decisions: [gateDecision],
      }),
    "state_conflict",
    "未归档宿主上完全重复的合法内容也不得绕过宿主守门",
  );
  eq(await readRevision(ID.obsGateIdentical), identicalBefore, "幂等绕过被拒后 revision 不变");

  const confirmed = await applyGuideEvidenceMutation(ID.obsGateConfirmed, {
    action: "confirm",
    expected_guide_revision: 0,
    decisions: [gateDecision],
  });
  eq(confirmed.revision, 1, "已归档宿主独立确认成功 revision=1");
  eq(confirmed.links.length, 1, "已归档宿主独立确认产生一条关联");
  const repeated = await applyGuideEvidenceMutation(ID.obsGateConfirmed, {
    action: "confirm",
    expected_guide_revision: 1,
    decisions: [gateDecision],
  });
  eq(repeated.revision, 1, "已归档宿主完全重复幂等不增长 revision");
  eq(repeated.links.length, 1, "已归档宿主完全重复不新增关联");

  const suggestion = {
    item_id: ITEM_ALLOWED_B,
    reason: "出现轮流表达",
    quote: QUOTE_1,
    quote_source: "raw_text" as const,
    quote_field: null,
    source_observation_id: ID.obsGateSrc,
    observed_at: "2026-09-20",
    class_context: MIDDLE_SNAPSHOT,
    source_confirmed_at: T1,
  };
  const saved = await saveGuideEvidenceSuggestionResult(ID.obsGateAi, {
    expectedRevision: 1,
    expectedStatus: "ai_organized",
    expectedRawText: RAW_1,
    expectedAiDraft: CONFIRMED_1,
    expectedConfirmedContent: null,
    ok: true,
    model: "offline-model",
    suggestions: [suggestion],
  });
  eq(saved.revision, 2, "未归档宿主仍可保存待核对建议");
  const savedContainer = parseGuideEvidence((await getObservation(ID.obsGateAi))?.guide_evidence);
  ok(
    savedContainer.kind === "ok" && savedContainer.links.some((link) => link.status === "ai_suggested"),
    "未归档宿主建议保持待核对且不产生正式状态",
  );
}

async function runComboVersionTests(): Promise<void> {
  const oldBefore = await readRevision(ID.obsGateOldCatalog);
  await expectErrorCode(
    () =>
      applyGuideEvidenceMutation(ID.obsGateOldCatalog, {
        action: "confirm",
        expected_guide_revision: oldBefore,
        decisions: [
          {
            link_id: "gate-old-catalog",
            support: "single_event",
            basis: [{ observation_id: ID.obsGateSrc, quote: QUOTE_1, quote_source: "raw_text" }],
          },
        ],
      }),
    "catalog_version_mismatch",
    "旧目录关联按 link_id 确认必须 409 catalog_version_mismatch",
  );
  eq(await readRevision(ID.obsGateOldCatalog), oldBefore, "旧目录被拒后不写入");

  const driftBefore = await readRevision(ID.obsGateDrift);
  await query("UPDATE observations SET confirmed_at = $2 WHERE id = $1", [ID.obsDriftSrc, T2]);
  await expectErrorCode(
    () =>
      applyGuideEvidenceMutation(ID.obsGateDrift, {
        action: "confirm",
        expected_guide_revision: driftBefore,
        decisions: [
          {
            link_id: "gate-drift",
            support: "single_event",
            basis: [{ observation_id: ID.obsDriftSrc, quote: QUOTE_2, quote_source: "raw_text" }],
          },
        ],
      }),
    "basis_expired",
    "来源版本漂移后沿用旧快照必须 409 basis_expired",
  );
  eq(await readRevision(ID.obsGateDrift), driftBefore, "版本漂移被拒后不写入");

  const dateBefore = await readRevision(ID.obsGateDateDrift);
  await query("UPDATE observations SET observed_at = $2 WHERE id = $1", [ID.obsDateSrc, "2026-09-25"]);
  await expectErrorCode(
    () =>
      applyGuideEvidenceMutation(ID.obsGateDateDrift, {
        action: "confirm",
        expected_guide_revision: dateBefore,
        decisions: [
          {
            link_id: "gate-date-drift",
            support: "single_event",
            basis: [{ observation_id: ID.obsDateSrc, quote: QUOTE_1, quote_source: "raw_text" }],
          },
        ],
      }),
    "basis_expired",
    "来源日期漂移必须 409 basis_expired",
  );
  eq(await readRevision(ID.obsGateDateDrift), dateBefore, "日期漂移被拒后不写入");

  const emptyBefore = await readRevision(ID.obsGateEmptyVersion);
  await expectErrorCode(
    () =>
      applyGuideEvidenceMutation(ID.obsGateEmptyVersion, {
        action: "confirm",
        expected_guide_revision: emptyBefore,
        decisions: [
          {
            link_id: "gate-empty-version",
            support: "single_event",
            basis: [{ observation_id: ID.obsGateSrc, quote: QUOTE_1, quote_source: "raw_text" }],
          },
        ],
      }),
    "basis_expired",
    "旧空版本快照独立确认必须 409 basis_expired",
  );
  eq(await readRevision(ID.obsGateEmptyVersion), emptyBefore, "空版本被拒后不写入");

  const invalidBefore = await readRevision(ID.obsGateInvalidVersion);
  await expectErrorCode(
    () =>
      applyGuideEvidenceMutation(ID.obsGateInvalidVersion, {
        action: "confirm",
        expected_guide_revision: invalidBefore,
        decisions: [
          {
            link_id: "gate-invalid-version",
            support: "single_event",
            basis: [{ observation_id: ID.obsGateSrc, quote: QUOTE_1, quote_source: "raw_text" }],
          },
        ],
      }),
    "basis_expired",
    "非法版本快照独立确认必须 409 basis_expired",
  );
  eq(await readRevision(ID.obsGateInvalidVersion), invalidBefore, "非法版本被拒后不写入");

  const batchBefore = await readRevision(ID.obsGateBatch);
  await expectErrorCode(
    () =>
      applyGuideEvidenceMutation(ID.obsGateBatch, {
        action: "confirm",
        expected_guide_revision: batchBefore,
        decisions: [
          {
            link_id: "gate-batch-valid",
            support: "single_event",
            basis: [{ observation_id: ID.obsGateSrc, quote: QUOTE_1, quote_source: "raw_text" }],
          },
          {
            link_id: "gate-batch-drift",
            support: "single_event",
            basis: [{ observation_id: ID.obsDriftSrc, quote: QUOTE_2, quote_source: "raw_text" }],
          },
        ],
      }),
    "basis_expired",
    "批量中一条过期必须 409 且全批回滚",
  );
  eq(await readRevision(ID.obsGateBatch), batchBefore, "批量失败后容器 revision 不变");
  const batchContainer = parseGuideEvidence((await getObservation(ID.obsGateBatch))?.guide_evidence);
  ok(
    batchContainer.kind === "ok" && batchContainer.links.every((link) => link.status === "ai_suggested"),
    "批量失败后两条关联均保持待核对（零部分写入）",
  );

  const firstArchive = await confirmObservation(
    ID.obsGateFirstArchive,
    ID.childGate,
    CONFIRMED_1,
    { status: "ai_organized", agentContext: null, aiDraft: CONFIRMED_1 },
    {
      expectedRevision: 0,
      decisions: [manualDecision(ITEM_ALLOWED, ID.obsGateFirstArchive, QUOTE_1)],
    },
  );
  eq(firstArchive.status, "confirmed", "同事务首次归档合法路径成功");
  const firstContainer = parseGuideEvidence(firstArchive.guide_evidence);
  ok(firstContainer.kind === "ok" && firstContainer.links.length === 1, "首次归档写入关联");
  if (firstContainer.kind === "ok") {
    eq(
      Date.parse(String(firstContainer.links[0].basis[0].source_confirmed_at)),
      Date.parse(String(firstArchive.confirmed_at)),
      "首次归档依据版本等于本次实际 confirmed_at",
    );
  }
}

async function runComboCommitResponseTests(): Promise<void> {
  const { NextRequest } = await import("next/server");
  const { createSessionToken, TEACHER_COOKIE } = await import("../src/lib/auth");
  const confirmRoute = await import("../src/app/api/observations/[id]/confirm/route");
  const { Pool } = await import("pg");
  const token = createSessionToken().token;
  const poolPrototype = Pool.prototype as unknown as { query: (...args: unknown[]) => unknown };
  const originalQuery = poolPrototype.query;
  let injected = false;
  poolPrototype.query = function (this: unknown, ...args: unknown[]) {
    const sql = typeof args[0] === "string" ? args[0] : "";
    if (sql.includes("WHERE o.child_id = ANY($1::text[])") || sql.includes("ORDER BY o.created_at DESC LIMIT")) {
      injected = true;
      throw new Error("组合检查注入：提交后详情/档案查询失败");
    }
    return originalQuery.apply(this, args);
  };
  let response: Response;
  try {
    response = await confirmRoute.POST(
      new NextRequest(`http://localhost/api/observations/${ID.obsConfirmHost}/confirm`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${TEACHER_COOKIE}=${encodeURIComponent(token)}`,
        },
        body: JSON.stringify({
          content: CONFIRMED_1,
          guide_decisions: {
            expected_guide_revision: 0,
            decisions: [manualDecision(ITEM_ALLOWED, ID.obsConfirmSrc, QUOTE_1)],
          },
        }),
      }),
      { params: Promise.resolve({ id: ID.obsConfirmHost }) },
    );
  } finally {
    poolPrototype.query = originalQuery;
  }
  ok(injected, "测试进程故障注入已触发（仅本进程，无产品开关）");
  eq(response.status, 200, "提交后详情补查失败仍返回 200");
  const body = (await response.json()) as {
    observation?: { status?: string };
    guideEvidence?: { status?: string; revision?: number; detail_unavailable?: boolean; links?: unknown };
  };
  eq(body.observation?.status, "confirmed", "归档结果保持已提交");
  eq(body.guideEvidence?.status, "applied", "返回 applied 不伪装为归档失败");
  eq(body.guideEvidence?.detail_unavailable, true, "返回 detail_unavailable");
  eq(body.guideEvidence?.revision, 1, "revision 由已提交容器解析");
  ok(body.guideEvidence?.links === undefined, "不以空 links 冒充成功");
  const after = await getObservation(ID.obsConfirmHost);
  eq(after?.status, "confirmed", "直连复核归档已提交");
  eq(after?.raw_text, RAW_1, "raw_text 不变");
  const afterContainer = parseGuideEvidence(after?.guide_evidence);
  ok(
    afterContainer.kind === "ok" && afterContainer.revision === 1 && afterContainer.links.length === 1,
    "关联只提交一次且无重复写入",
  );
}

async function runComboReadAuditTests(): Promise<void> {
  const brokenOnlyBook = await loadChildEvidenceBook(ID.childRelBrokenOnly, { scope: "all_history" });
  if (!brokenOnlyBook.ok) assert.fail("损坏容器幼儿证据册读取失败");
  const brokenItem = findGoalItem(brokenOnlyBook.value, ITEM_ALLOWED);
  assert.ok(brokenItem);
  ok(brokenItem.reliability !== "reliable", `缺 item_id 的关联不得返回 reliable（实际 ${brokenItem.reliability}）`);
  eq(brokenItem.status, "no_records", "缺 item_id 不产生虚假正式状态");

  const mixedBook = await loadChildEvidenceBook(ID.childMixed, { scope: "all_history" });
  if (!mixedBook.ok) assert.fail("混合容器幼儿证据册读取失败");
  const mixedItem = findGoalItem(mixedBook.value, ITEM_ALLOWED);
  assert.ok(mixedItem);
  eq(mixedItem.reliability, "partial", "有效+未知同容器应为 partial");
  eq(mixedItem.status, "confirmed_observed", "混合容器中有效关联仍计入正式状态");
  eq(mixedItem.links.length, 1, "混合容器只计入可归属关联");

  const middleOverview = await loadClassEvidenceOverview(ID.classMiddle, { scope: "all_history" });
  if (!middleOverview.ok) assert.fail("中班概览读取失败");
  const middleItem = findGoalItem(middleOverview.value, ITEM_ALLOWED);
  assert.ok(middleItem);
  eq(middleItem.reliability, "partial", "班级一人不可读其余可读 → partial");
  eq(middleItem.confirmed_ratio, null, "partial 班级占比必须为 null");
  eq(
    middleItem.counts.confirmed_observed + middleItem.counts.has_clues + middleItem.counts.no_records,
    middleItem.total,
    "混合班级三类人数之和仍等于分母",
  );

  const brokenOverview = await loadClassEvidenceOverview(ID.classBroken, { scope: "all_history" });
  if (!brokenOverview.ok) assert.fail("损坏班概览读取失败");
  const brokenClassItem = findGoalItem(brokenOverview.value, ITEM_ALLOWED);
  assert.ok(brokenClassItem);
  eq(brokenClassItem.reliability, "unavailable", "全部幼儿不可读 → unavailable");
  eq(brokenClassItem.confirmed_ratio, null, "unavailable 班级占比必须为 null");
  eq(
    brokenClassItem.counts.confirmed_observed + brokenClassItem.counts.has_clues + brokenClassItem.counts.no_records,
    brokenClassItem.total,
    "不可读班级仍保留名单分母",
  );

  const supportBook = await loadChildEvidenceBook(ID.childSupport, { scope: "all_history" });
  if (!supportBook.ok) assert.fail("支持条件幼儿证据册读取失败");
  for (const itemId of [ITEM_ALLOWED, ITEM_REQUIRES_INDEPENDENCE, ITEM_ALLOWED_B, ITEM_SUSTAINED]) {
    const item = findGoalItem(supportBook.value, itemId);
    assert.ok(item, `支持条件条目存在：${itemId}`);
    ok(item.status !== "confirmed_observed", `支持条件不足不得计为表现：${itemId}`);
  }
}

async function runComboQuoteTests(): Promise<void> {
  const switchDecision = (field: "highlight_quote" | "highlights") => ({
    link_id: "quote-host",
    support: "single_event" as const,
    basis: [
      {
        observation_id: ID.obsQuoteSrc,
        quote: QUOTE_1,
        quote_source: "confirmed_content" as const,
        quote_field: field,
      },
    ],
  });
  const first = await applyGuideEvidenceMutation(ID.obsQuoteHost, {
    action: "confirm",
    expected_guide_revision: 1,
    decisions: [switchDecision("highlights")],
  });
  eq(first.revision, 2, "E1 highlight_quote→highlights 容器 revision+1");
  const firstLink = first.links.find((link) => link.link_id === "quote-host");
  assert.ok(firstLink);
  eq(firstLink.basis[0]?.quote_field, "highlights", "E1 新位置写入结果");
  eq(firstLink.revision, 2, "E1 link revision+1");

  const repeat = await applyGuideEvidenceMutation(ID.obsQuoteHost, {
    action: "confirm",
    expected_guide_revision: 2,
    decisions: [switchDecision("highlights")],
  });
  eq(repeat.revision, 2, "E2 完全重复不增长容器 revision");
  eq(repeat.links.find((link) => link.link_id === "quote-host")?.revision, 2, "E2 完全重复不增长 link revision");

  const back = await applyGuideEvidenceMutation(ID.obsQuoteHost, {
    action: "confirm",
    expected_guide_revision: 2,
    decisions: [switchDecision("highlight_quote")],
  });
  eq(back.revision, 3, "E3 反向切换生效");
  eq(
    back.links.find((link) => link.link_id === "quote-host")?.basis[0]?.quote_field,
    "highlight_quote",
    "E3 反向位置写入结果",
  );

  const multi = await applyGuideEvidenceMutation(ID.obsQuoteMulti, {
    action: "confirm",
    expected_guide_revision: 1,
    decisions: [
      {
        link_id: "quote-multi",
        support: "single_event",
        basis: [
          {
            observation_id: ID.obsQuoteSrc,
            quote: QUOTE_1,
            quote_source: "confirmed_content",
            quote_field: "highlights",
          },
        ],
      },
    ],
  });
  const multiLink = multi.links.find((link) => link.link_id === "quote-multi");
  assert.ok(multiLink);
  eq(multiLink.basis.length, 1, "E4 多字段并存按提交定位只保留新依据");
  eq(multiLink.basis[0]?.quote_field, "highlights", "E4 不误用第一条旧依据");

  const wrongBefore = await readRevision(ID.obsQuoteWrong);
  await expectErrorCode(
    () =>
      applyGuideEvidenceMutation(ID.obsQuoteWrong, {
        action: "confirm",
        expected_guide_revision: wrongBefore,
        decisions: [
          {
            link_id: "quote-wrong",
            support: "single_event",
            basis: [
              {
                observation_id: ID.obsQuoteSrc,
                quote: "把小汽车递给同伴",
                quote_source: "confirmed_content",
                quote_field: "highlights",
              },
            ],
          },
        ],
      }),
    "invalid_request",
    "E5 声明位置不含片段必须 400 invalid_request",
  );
  eq(await readRevision(ID.obsQuoteWrong), wrongBefore, "E5 被拒后零写入");

  const driftBefore = await readRevision(ID.obsQuoteDrift);
  await query("UPDATE observations SET confirmed_at = $2 WHERE id = $1", [ID.obsQuoteDriftSrc, T2]);
  await expectErrorCode(
    () =>
      applyGuideEvidenceMutation(ID.obsQuoteDrift, {
        action: "confirm",
        expected_guide_revision: driftBefore,
        decisions: [
          {
            link_id: "quote-drift",
            support: "single_event",
            basis: [
              {
                observation_id: ID.obsQuoteDriftSrc,
                quote: QUOTE_1,
                quote_source: "confirmed_content",
                quote_field: "highlights",
              },
            ],
          },
        ],
      }),
    "basis_expired",
    "E6 来源漂移时切换字段必须 409 basis_expired",
  );
  eq(await readRevision(ID.obsQuoteDrift), driftBefore, "E6 被拒后零写入");

  const batchBefore = await readRevision(ID.obsQuoteBatch);
  await expectErrorCode(
    () =>
      applyGuideEvidenceMutation(ID.obsQuoteBatch, {
        action: "confirm",
        expected_guide_revision: batchBefore,
        decisions: [
          {
            link_id: "quote-batch-valid",
            support: "single_event",
            basis: [
              {
                observation_id: ID.obsQuoteSrc,
                quote: QUOTE_1,
                quote_source: "confirmed_content",
                quote_field: "highlights",
              },
            ],
          },
          {
            link_id: "quote-batch-drift",
            support: "single_event",
            basis: [
              {
                observation_id: ID.obsQuoteDriftSrc,
                quote: QUOTE_1,
                quote_source: "confirmed_content",
                quote_field: "highlights",
              },
            ],
          },
        ],
      }),
    "basis_expired",
    "E7 批量一条漂移必须整批零写入",
  );
  eq(await readRevision(ID.obsQuoteBatch), batchBefore, "E7 批量失败后容器不变");
}

async function runComboSourceBindingTests(): Promise<void> {
  const factObservation = await getObservation(ID.obsSuggestFact);
  const historicalSource = await getObservation(ID.obsSuggestHist);
  if (!factObservation || !historicalSource) assert.fail("来源绑定 fixture 缺失");
  const item = guideItemById(ITEM_ALLOWED);
  if (!item) assert.fail("目录条目缺失");
  const invoke = (content: unknown) => async () => ({
    content: JSON.stringify(content),
    provider: "coze" as const,
    model: "offline-model",
  });
  const suggestion = {
    item_id: ITEM_ALLOWED,
    reason: "在观察中出现了该行为",
    quote: "游戏不按分数排名",
    quote_source: "raw_text" as const,
    quote_field: "",
    quote_source_id: ID.obsSuggestHist,
  };
  const bound = await generateGuideEvidenceSuggestions(factObservation, {
    candidates: [item],
    confirmedSources: [historicalSource],
    invoke: invoke({ suggestions: [suggestion] }),
  });
  ok(bound.ok, "明确来源 id 的正确建议应通过");
  if (bound.ok) {
    eq(bound.suggestions[0]?.source_observation_id, ID.obsSuggestHist, "建议绑定模型声明的来源 id");
    eq(bound.suggestions[0]?.observed_at, "2026-09-10", "来源日期由服务端按 id 生成");
    ok(
      bound.suggestions[0]?.source_confirmed_at !== null &&
        Date.parse(String(bound.suggestions[0].source_confirmed_at)) === Date.parse(T1),
      "来源版本由服务端按 id 生成",
    );
  }
  const missing = await generateGuideEvidenceSuggestions(factObservation, {
    candidates: [item],
    confirmedSources: [historicalSource],
    invoke: invoke({ suggestions: [{ ...suggestion, quote_source_id: undefined }] }),
  });
  ok(!missing.ok, "缺少来源 id 的旧格式建议必须拒绝");
  const wrong = await generateGuideEvidenceSuggestions(factObservation, {
    candidates: [item],
    confirmedSources: [historicalSource],
    invoke: invoke({ suggestions: [{ ...suggestion, quote_source_id: "o-missing" }] }),
  });
  ok(!wrong.ok, "来源 id 不在可用范围必须拒绝");
  const cross = await generateGuideEvidenceSuggestions(factObservation, {
    candidates: [item],
    confirmedSources: [historicalSource],
    invoke: invoke({ suggestions: [{ ...suggestion, quote_source_id: ID.obs1 }] }),
  });
  ok(!cross.ok, "跨幼儿来源 id 必须拒绝");
  const wrongField = await generateGuideEvidenceSuggestions(factObservation, {
    candidates: [item],
    confirmedSources: [historicalSource],
    invoke: invoke({
      suggestions: [
        {
          ...suggestion,
          quote_source: "confirmed_content",
          quote_field: "highlight_quote",
          quote: "游戏不按分数排名",
        },
      ],
    }),
  });
  ok(!wrongField.ok, "引用位置与片段不符必须拒绝");
  const fabricated = await generateGuideEvidenceSuggestions(factObservation, {
    candidates: [item],
    confirmedSources: [historicalSource],
    invoke: invoke({ suggestions: [{ ...suggestion, quote: "编造的引用内容不存在" }] }),
  });
  ok(!fabricated.ok, "虚构引用必须拒绝");
  const scored = await generateGuideEvidenceSuggestions(factObservation, {
    candidates: [item],
    confirmedSources: [historicalSource],
    invoke: invoke({ suggestions: [{ ...suggestion, reason: "该幼儿得分高，排名领先。" }] }),
  });
  ok(!scored.ok, "AI 理由主动打分/排名必须拒绝");

  const snapshotSuggestion = {
    item_id: ITEM_ALLOWED,
    reason: "出现轮流表达",
    quote: QUOTE_1,
    quote_source: "raw_text" as const,
    quote_field: null,
    source_observation_id: ID.obsSuggestSrc2,
    observed_at: "2026-09-20",
    class_context: MIDDLE_SNAPSHOT,
    source_confirmed_at: T1,
  };
  const saved = await saveGuideEvidenceSuggestionResult(ID.obsSuggestHost, {
    expectedRevision: 0,
    expectedStatus: "ai_organized",
    expectedRawText: RAW_1,
    expectedAiDraft: CONFIRMED_1,
    expectedConfirmedContent: null,
    ok: true,
    model: "offline-model",
    suggestions: [snapshotSuggestion],
  });
  eq(saved.revision, 1, "生成快照与来源一致时建议保存成功");

  await query("UPDATE observations SET confirmed_at = $2 WHERE id = $1", [ID.obsSuggestSrc3, T2]);
  await expectErrorCode(
    () =>
      saveGuideEvidenceSuggestionResult(ID.obsSuggestHost2, {
        expectedRevision: 0,
        expectedStatus: "ai_organized",
        expectedRawText: RAW_1,
        expectedAiDraft: CONFIRMED_1,
        expectedConfirmedContent: null,
        ok: true,
        model: "offline-model",
        suggestions: [{ ...snapshotSuggestion, source_observation_id: ID.obsSuggestSrc3 }],
      }),
    "state_conflict",
    "来源在生成后版本漂移：迟到建议必须 409 冲突",
  );
  eq(await readRevision(ID.obsSuggestHost2), 0, "迟到建议不写入");
  eq((await getObservation(ID.obsSuggestHost2))?.guide_evidence, null, "迟到建议不产生容器");
}

async function runComboRecoveryTests(): Promise<void> {
  eq(await readRevision(ID.obsRecovery), 1, "恢复路线起点 revision=1");
  await expectErrorCode(
    () =>
      applyGuideEvidenceMutation(ID.obsRecovery, {
        action: "confirm",
        expected_guide_revision: 1,
        decisions: [
          {
            link_id: "recovery-old",
            support: "single_event",
            basis: [{ observation_id: ID.obsRecovery, quote: QUOTE_1, quote_source: "raw_text" }],
          },
        ],
      }),
    "basis_expired",
    "旧空版本建议独立确认 409 basis_expired",
  );
  eq(await readRevision(ID.obsRecovery), 1, "确认失败不增长 revision");
  eq((await getObservation(ID.obsRecovery))?.status, "confirmed", "宿主保持已归档");

  const rejected = await applyGuideEvidenceMutation(ID.obsRecovery, {
    action: "reject",
    link_id: "recovery-old",
    expected_guide_revision: 1,
    reason: "旧建议版本无法核对，改用当前来源重新关联",
  });
  eq(rejected.revision, 2, "拒绝旧建议 revision=2");
  eq(rejected.links.find((link) => link.link_id === "recovery-old")?.status, "rejected", "拒绝保留审计终态");

  const manual = await applyGuideEvidenceMutation(ID.obsRecovery, {
    action: "confirm",
    expected_guide_revision: 2,
    decisions: [manualDecision(ITEM_ALLOWED, ID.obsRecovery, QUOTE_1)],
  });
  eq(manual.revision, 3, "手动关联当前条目 revision=3");
  const manualLink = manual.links.find((link) => link.status === "confirmed_performance");
  assert.ok(manualLink);
  eq(manualLink.basis[0]?.observation_id, ID.obsRecovery, "新依据来源为宿主");
  ok(manualLink.basis[0]?.source_confirmed_at !== null, "新正式依据版本非空");

  const repeat = await applyGuideEvidenceMutation(ID.obsRecovery, {
    action: "confirm",
    expected_guide_revision: 3,
    decisions: [manualDecision(ITEM_ALLOWED, ID.obsRecovery, QUOTE_1)],
  });
  eq(repeat.revision, 3, "重复提交幂等不增长 revision");
  eq(repeat.links.length, 2, "重复提交不新增关联");
  eq((await getObservation(ID.obsRecovery))?.raw_text, RAW_1, "恢复路线全程 raw_text 不变");
}

async function runComboTests(): Promise<void> {
  await runComboHostGuardTests();
  await runComboVersionTests();
  await runComboCommitResponseTests();
  await runComboReadAuditTests();
  await runComboQuoteTests();
  await runComboSourceBindingTests();
  await runComboRecoveryTests();
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

    // 7) 组合业务（G5-R1/R2）真实 HTTP 错误映射与引用定位
    const hostGuardResponse = await fetch(`${base}/api/observations/${ID.obsGateAi}/guide-evidence`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        action: "confirm",
        expected_guide_revision: 2,
        decisions: [
          {
            item_id: ITEM_ALLOWED,
            support: "single_event",
            basis: [{ observation_id: ID.obsGateSrc, quote: QUOTE_1, quote_source: "raw_text" }],
          },
        ],
      }),
    });
    eq(hostGuardResponse.status, 409, "HTTP 未归档宿主独立确认返回 409");
    eq(
      ((await hostGuardResponse.json()) as { error?: string }).error,
      "state_conflict",
      "HTTP 未归档宿主错误码 state_conflict",
    );

    const oldCatalogResponse = await fetch(`${base}/api/observations/${ID.obsGateOldCatalog}/guide-evidence`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        action: "confirm",
        expected_guide_revision: 1,
        decisions: [
          {
            link_id: "gate-old-catalog",
            support: "single_event",
            basis: [{ observation_id: ID.obsGateSrc, quote: QUOTE_1, quote_source: "raw_text" }],
          },
        ],
      }),
    });
    eq(oldCatalogResponse.status, 409, "HTTP 旧目录关联返回 409");
    eq(
      ((await oldCatalogResponse.json()) as { error?: string }).error,
      "catalog_version_mismatch",
      "HTTP 旧目录错误码 catalog_version_mismatch",
    );

    const emptyVersionResponse = await fetch(`${base}/api/observations/${ID.obsGateEmptyVersion}/guide-evidence`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        action: "confirm",
        expected_guide_revision: 1,
        decisions: [
          {
            link_id: "gate-empty-version",
            support: "single_event",
            basis: [{ observation_id: ID.obsGateSrc, quote: QUOTE_1, quote_source: "raw_text" }],
          },
        ],
      }),
    });
    eq(emptyVersionResponse.status, 409, "HTTP 旧空版本建议返回 409");
    eq(
      ((await emptyVersionResponse.json()) as { error?: string }).error,
      "basis_expired",
      "HTTP 旧空版本错误码 basis_expired",
    );

    const quoteSwitchResponse = await fetch(`${base}/api/observations/${ID.obsQuoteHttp}/guide-evidence`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        action: "confirm",
        expected_guide_revision: 1,
        decisions: [
          {
            link_id: "quote-http",
            support: "single_event",
            basis: [
              {
                observation_id: ID.obsQuoteSrc,
                quote: QUOTE_1,
                quote_source: "confirmed_content",
                quote_field: "highlights",
              },
            ],
          },
        ],
      }),
    });
    const quoteSwitchBody = (await quoteSwitchResponse.json()) as {
      revision: number;
      links: { basis: { quote_field: string | null }[] }[];
    };
    eq(quoteSwitchResponse.status, 200, "HTTP 引用字段切换成功");
    eq(quoteSwitchBody.revision, 2, "HTTP 引用字段切换容器 revision=2");
    eq(quoteSwitchBody.links[0]?.basis[0]?.quote_field, "highlights", "HTTP 引用字段新位置生效");
    const quoteRepeatResponse = await fetch(`${base}/api/observations/${ID.obsQuoteHttp}/guide-evidence`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        action: "confirm",
        expected_guide_revision: 2,
        decisions: [
          {
            link_id: "quote-http",
            support: "single_event",
            basis: [
              {
                observation_id: ID.obsQuoteSrc,
                quote: QUOTE_1,
                quote_source: "confirmed_content",
                quote_field: "highlights",
              },
            ],
          },
        ],
      }),
    });
    eq(quoteRepeatResponse.status, 200, "HTTP 完全重复提交成功");
    eq(
      ((await quoteRepeatResponse.json()) as { revision: number }).revision,
      2,
      "HTTP 完全重复幂等不增长 revision",
    );
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
    await runComboTests();
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
      combination: {
        business: "G5-R1/R2 approved fixes (faea10d)",
        safety: "G5-QA1-R1 approved harness (711c9cd)",
        counterexamples: "A host guard / B version+atomicity / C commit+response / D read+audit / E quote position / F source binding / G recovery route",
        fault_injection: "C detail-unavailable via test-process pool interception only (no product switch)",
      },
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
