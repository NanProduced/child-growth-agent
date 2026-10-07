/**
 * YAYA-QA-SEED1 可重用浏览器验收数据模块（创建 → 身份核验 → 种子 → 事实回读 → 精确 teardown）。
 *
 * 边界与纪律：
 * - 只使用 scripts/yaya/acceptance/resources.ts 的一次性隔离 PG 与自有对象目录；
 *   不接受外部 DATABASE_URL、不读 .env、不连托管库、不调用模型/S3（模型守门不在此进程启动，
 *   因为本模块不做任何 provider 出口请求）；
 * - 复用产品写入路径：AUTH repository（账号）、lib/queries（观察原文/整理/归档）、
 *   guide decisions（指南证据），yayaDataRepository（会话/消息/附件引用）、MEDIA 上传管线（sharp）；
 * - 不手写假回执：正常种子不写任何 operation 回执；唯一一条回执行是显式标注的故障夹具；
 * - 不调用待修的回收路径（src/lib/media/retention-service 不在本模块引用范围内）；
 * - 所有内容合成：is_demo=true + 文本 [合成] 标记 + 附件 metadata.synthetic=true；
 *   异常存储单独收敛在 [故障夹具] 班级/幼儿/观察，与正常种子分开登记在 fault_fixtures。
 */
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import type { AgentContext, Observation, ObservationDraft } from "../../../src/lib/types";
import type { GuidePerformanceItem } from "../../../src/lib/guide/types";
import { GUIDE_CATALOG_VERSION } from "../../../src/lib/guide/types";
import { buildPrincipal } from "../../../src/lib/accounts/repository";
import {
  createInitialAdmin,
  createTeacherWithAssignments,
} from "../../../src/lib/accounts/repository";
import { hashPassword } from "../../../src/lib/accounts/password";
import { listGuideItems } from "../../../src/lib/guide/catalog";
import { parseGuideEvidence } from "../../../src/lib/guide/runtime";
import {
  applyGuideEvidenceMutation,
  confirmObservation,
  createObservation,
  getObservation,
  updateObservationAgentContext,
  updateObservationAiDraft,
} from "../../../src/lib/queries";
import { withTransaction, type TransactionClient } from "../../../src/storage/database/pg-client";
import { getCurrentSemester } from "../../../src/lib/semester";
import { isoDateInShanghai } from "../../../src/lib/format";
import {
  createDataAttachmentMetadataPort,
} from "../../../src/lib/media/data-adapter";
import { LocalMediaObjectStore } from "../../../src/lib/media/object-store-local";
import { uploadImages } from "../../../src/lib/media/upload-service";
import type { MediaServiceDeps } from "../../../src/lib/media/runtime";
import { yayaDataRepository } from "../../../src/lib/yaya/data";
import type { YayaMessageSourceRef } from "../../../src/lib/yaya/types";
import type { YayaStoredFragment } from "../../../src/lib/yaya/storage-types";
import { runCleanupSteps, type CleanupStep } from "../../harness-safety";
import {
  ACCEPTANCE_SCHOOL_ID,
  AcceptanceResourceError,
  acceptanceCleanupSteps,
  prepareAcceptanceResources,
  verifyAcceptanceResources,
  type AcceptanceResources,
} from "./resources";
import { syntheticSharedPhoto } from "./media";
import { verifyAcceptanceSeed } from "./verify";
import type {
  AcceptanceSeedHandle,
  AcceptanceSeedManifest,
  AcceptanceSeedOptions,
  SeedAccountKey,
  SeedChildKey,
  SeedChildRef,
  SeedClassKey,
  SeedClassRef,
  SeedFailureStage,
  SeedObservationKey,
  SeedObservationRef,
} from "./types";
import { FAULT_MARK, SYNTHETIC_MARK } from "./types";

export type {
  AcceptanceSeedHandle,
  AcceptanceSeedManifest,
  AcceptanceSeedOptions,
  AcceptanceVerification,
  SeedChildKey,
  SeedClassKey,
  SeedFailureStage,
  SeedObservationKey,
} from "./types";
export { FAULT_MARK, SYNTHETIC_MARK } from "./types";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export class AcceptanceSeedError extends Error {
  constructor(
    message: string,
    public readonly cleanup_ok: boolean,
    public readonly cleanup_issues: readonly string[],
  ) {
    super(message);
    this.name = "AcceptanceSeedError";
  }
}

/* ------------------------------- 迁移/日期助手 ------------------------------- */

function readMigrationSlice(file: string, stopMarker: string): string {
  const sql = fs.readFileSync(path.join(ROOT, "scripts", file), "utf8");
  const index = sql.indexOf(stopMarker);
  if (index < 0) throw new Error(`迁移切片标记未找到：${file} ← ${stopMarker}`);
  return sql.slice(0, index);
}

async function runMigrations(resources: AcceptanceResources): Promise<void> {
  const client = new Client({ connectionString: resources.database_url });
  await client.connect();
  try {
    await client.query("SET TIME ZONE 'UTC'");
    // 纯结构部分：初始化脚本按 AGENTS 约定截取 INSERT INTO children 之前；
    // 班级升级脚本截取演示班级插入之前，保证隔离库只有本模块种子数据。
    await client.query(readMigrationSlice("initialize-demo-db.sql", "INSERT INTO children"));
    await client.query(readMigrationSlice("upgrade-classes.sql", "-- 5) 演示班级"));
    await client.query(fs.readFileSync(path.join(ROOT, "scripts", "upgrade-guide-evidence-v1.sql"), "utf8"));
    await client.query(fs.readFileSync(path.join(ROOT, "scripts", "upgrade-auth-v1.sql"), "utf8"));
    await client.query(fs.readFileSync(path.join(ROOT, "scripts", "upgrade-yaya-v1.sql"), "utf8"));
    await client.query(fs.readFileSync(path.join(ROOT, "scripts", "upgrade-yaya-runs-v1.sql"), "utf8"));
    await client.query(fs.readFileSync(path.join(ROOT, "scripts", "upgrade-yaya-chat-bind-v1.sql"), "utf8"));
  } finally {
    await client.end();
  }
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function dateTTimestamp(date: string): string {
  return new Date(`${date}T00:00:00Z`).toISOString();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`种子前置条件不成立：${message}`);
}

/* ------------------------------- 测试进程处理 ------------------------------- */

function assertFreshProcessPool(): void {
  if (globalThis.__pgPool !== undefined) {
    throw new Error(
      "本进程已存在数据库连接池（globalThis.__pgPool）；验收种子必须在独立进程中运行，避免混用其他数据库。",
    );
  }
}

async function closeGlobalPool(): Promise<void> {
  const pool = globalThis.__pgPool;
  if (!pool) return;
  globalThis.__pgPool = undefined;
  await pool.end();
}

/* ------------------------------- 种子入口 ------------------------------- */

export async function createAcceptanceSeed(
  options: AcceptanceSeedOptions = {},
): Promise<AcceptanceSeedHandle> {
  assertFreshProcessPool();
  let resources: AcceptanceResources | null = null;
  const cleanupSteps: CleanupStep[] = [];
  const cleanupIssues: string[] = [];

  const injectFailure = (stage: SeedFailureStage): void => {
    if (options.failAt === stage) throw new Error(`[self-check] 注入失败：${stage}`);
  };

  try {
    resources = await prepareAcceptanceResources();
    cleanupSteps.push(
      { label: "pg-pool-close", run: closeGlobalPool },
      ...acceptanceCleanupSteps(resources),
    );
    injectFailure("after_resources");

    process.env.DATABASE_URL = resources.database_url;
    delete process.env.PGDATABASE_URL;
    process.env.AUTH_SCHOOL_ID = ACCEPTANCE_SCHOOL_ID;

    await runMigrations(resources);
    verifyAcceptanceResources(resources);
    injectFailure("after_schema");

    const { manifest, credentials: accountCredentials } = await seedAll(resources);
    injectFailure("after_seed");

    // 凭证只写本轮受控临时目录（非仓库、非 stdout）；teardown 会连同目录精确删除。
    const credentials = {
      seed_id: manifest.seed_id,
      database_url: resources.database_url,
      object_root: resources.object_root,
      accounts: accountCredentials,
    };
    fs.writeFileSync(resources.credentials_path, JSON.stringify(credentials, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });

    const verification = await verifyAcceptanceSeed(resources, manifest);

    // teardown 语义：只有全部资源删除并核实后才进入完成态；失败保留可重试清理与失败信息。
    // 并发调用共享同一次进行中的清理；成功后幂等返回。
    let teardownComplete = false;
    let teardownInFlight: Promise<void> | null = null;
    const runTeardown = async (): Promise<void> => {
      const issues: string[] = [];
      await runCleanupSteps(cleanupSteps, (label, detail) => issues.push(`${label}: ${detail}`));
      if (issues.length > 0) {
        throw new AcceptanceSeedError(
          `本轮资源清理未完成（可再次调用 teardown 重试）：${issues.join("；")}`,
          false,
          issues,
        );
      }
      teardownComplete = true;
    };
    const teardown = (): Promise<void> => {
      if (teardownComplete) return Promise.resolve();
      if (!teardownInFlight) {
        teardownInFlight = runTeardown().finally(() => {
          teardownInFlight = null;
        });
      }
      return teardownInFlight;
    };

    return {
      seed_id: manifest.seed_id,
      manifest,
      verification,
      credentials_path: resources.credentials_path,
      object_root: resources.object_root,
      container_id: resources.container_id,
      database_url: resources.database_url,
      teardown,
    };
  } catch (error) {
    const issues: string[] = [];
    await runCleanupSteps(cleanupSteps, (label, detail) => issues.push(`${label}: ${detail}`));
    // 准备阶段失败时 resources 尚未返回：必须继承其结构化清理结果，不能重算为“已清理”。
    if (error instanceof AcceptanceResourceError) issues.push(...error.cleanup_issues);
    cleanupIssues.push(...issues);
    const message = error instanceof Error ? error.message : String(error);
    throw new AcceptanceSeedError(message, issues.length === 0, issues);
  }
}

/* ------------------------------- 种子主体 ------------------------------- */

interface SeedCredentials {
  admin: { username: string; password: string };
  teacher_a: { username: string; password: string };
  teacher_b: { username: string; password: string };
  teacher_c: { username: string; password: string };
}

async function seedAll(
  resources: AcceptanceResources,
): Promise<{ manifest: AcceptanceSeedManifest; credentials: SeedCredentials }> {
  const semester = getCurrentSemester();
  assert(semester, "显式学期配置中没有覆盖今天的学期；请在学期内运行或调整 lib/semester/config.ts");
  const today = isoDateInShanghai();
  const maxOffset = Math.floor(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${semester.start_date}T00:00:00Z`)) / 86_400_000,
  );
  const deriveDate = (offset: number): string => {
    assert(offset <= maxOffset, `观察日期偏移 +${offset} 晚于今天（学期事实无法派生未来观察）`);
    return addDays(semester.start_date, offset);
  };

  const seedId = resources.seed_id;
  const tx = <T>(work: (client: TransactionClient) => Promise<T>): Promise<T> => withTransaction(work);

  const run = async (sql: string, params: unknown[] = []): Promise<void> => {
    await tx(async (client) => {
      await client.query(sql, params);
    });
  };

  /* ---- 班级（合成；隔离库只有本模块数据） ---- */
  const classIds: Record<SeedClassKey, string> = {
    class_a: randomUUID(),
    class_b: randomUUID(),
    class_c: randomUUID(),
    class_fault: randomUUID(),
  };
  const classRefs: Record<SeedClassKey, SeedClassRef> = {
    class_a: { id: classIds.class_a, name: `松果班·${SYNTHETIC_MARK}`, stage: "small", school_year: semester.school_year, is_fault_fixture: false },
    class_b: { id: classIds.class_b, name: `白桦班·${SYNTHETIC_MARK}`, stage: "small", school_year: semester.school_year, is_fault_fixture: false },
    class_c: { id: classIds.class_c, name: `云杉班·${SYNTHETIC_MARK}`, stage: "small", school_year: semester.school_year, is_fault_fixture: false },
    class_fault: { id: classIds.class_fault, name: `${FAULT_MARK} 隔离班·${SYNTHETIC_MARK}`, stage: "small", school_year: semester.school_year, is_fault_fixture: true },
  };
  for (const klass of Object.values(classRefs)) {
    await run(
      `INSERT INTO classes (id, name, stage, school_year, is_active, is_demo)
       VALUES ($1, $2, $3, $4, true, true)`,
      [klass.id, klass.name, klass.stage, klass.school_year],
    );
  }

  /* ---- 账号（AUTH repository；口令只进凭证文件） ---- */
  const accountOf = (key: SeedAccountKey) => ({
    username: `${seedId}-${key.replace(/_/g, "-")}`,
    password: `Qa1-${randomBytes(12).toString("base64url")}`,
  });
  const adminCred = accountOf("admin");
  const admin = await createInitialAdmin(
    {
      username: adminCred.username,
      displayName: `合成管理员·${SYNTHETIC_MARK}`,
      passwordHash: await hashPassword(adminCred.password),
    },
    ACCEPTANCE_SCHOOL_ID,
  );
  const teacherCreds = {
    teacher_a: accountOf("teacher_a"),
    teacher_b: accountOf("teacher_b"),
    teacher_c: accountOf("teacher_c"),
  };
  const teacherA = await createTeacherWithAssignments({
    username: teacherCreds.teacher_a.username,
    displayName: `合成教师A·${SYNTHETIC_MARK}`,
    passwordHash: await hashPassword(teacherCreds.teacher_a.password),
    classIds: [classIds.class_a, classIds.class_b, classIds.class_fault],
    assignedBy: admin.account_id,
  });
  const teacherB = await createTeacherWithAssignments({
    username: teacherCreds.teacher_b.username,
    displayName: `合成教师B·${SYNTHETIC_MARK}`,
    passwordHash: await hashPassword(teacherCreds.teacher_b.password),
    classIds: [classIds.class_c],
    assignedBy: admin.account_id,
  });
  const teacherC = await createTeacherWithAssignments({
    username: teacherCreds.teacher_c.username,
    displayName: `合成未分配教师·${SYNTHETIC_MARK}`,
    passwordHash: await hashPassword(teacherCreds.teacher_c.password),
    classIds: [],
    assignedBy: admin.account_id,
  });
  // 撤权历史（不授予当前权限）：教师A上一个学期末曾带云杉班，本学期开始前撤销。
  const transferSplit = 20;
  await run(
    `INSERT INTO teacher_class_assignments
       (account_id, class_id, assigned_at, assigned_by_account_id, removed_at)
     VALUES ($1, $2, $3::timestamptz, $4, $5::timestamptz)`,
    [
      teacherA.account_id,
      classIds.class_c,
      dateTTimestamp(semester.start_date),
      admin.account_id,
      dateTTimestamp(addDays(semester.start_date, transferSplit + 1)),
    ],
  );
  const credentials: SeedCredentials = {
    admin: adminCred,
    teacher_a: teacherCreds.teacher_a,
    teacher_b: teacherCreds.teacher_b,
    teacher_c: teacherCreds.teacher_c,
  };

  /* ---- 幼儿与分班（日期全部由学期 + 分班事实派生） ---- */
  type ChildPlan = {
    key: SeedChildKey;
    name: string;
    class_key: SeedClassKey;
    dayOffset: number;
    note: string;
  };
  const childPlans: ChildPlan[] = [
    { key: "class_a_same_name", name: "王一诺", class_key: "class_a", dayOffset: 100, note: `${SYNTHETIC_MARK} 同名幼儿（松果班）` },
    { key: "class_a_shared_photo", name: "陈小满", class_key: "class_a", dayOffset: 130, note: `${SYNTHETIC_MARK} 共用合成照片` },
    { key: "class_a_trusted_empty", name: "赵小树", class_key: "class_a", dayOffset: 160, note: `${SYNTHETIC_MARK} 可信空证据` },
    { key: "class_b_same_name", name: "王一诺", class_key: "class_b", dayOffset: 190, note: `${SYNTHETIC_MARK} 同名幼儿（白桦班）` },
    { key: "class_b_shared_photo", name: "周小满", class_key: "class_b", dayOffset: 220, note: `${SYNTHETIC_MARK} 共用合成照片` },
    { key: "class_b_draft", name: "孙小芽", class_key: "class_b", dayOffset: 250, note: `${SYNTHETIC_MARK} draft 状态` },
    { key: "class_b_needs_input", name: "李小禾", class_key: "class_b", dayOffset: 280, note: `${SYNTHETIC_MARK} needs_input 状态` },
    { key: "class_b_ai_organized", name: "吴小溪", class_key: "class_b", dayOffset: 310, note: `${SYNTHETIC_MARK} ai_organized 状态` },
    { key: "class_c_transfer", name: "郑小舟", class_key: "class_c", dayOffset: 340, note: `${SYNTHETIC_MARK} 转班历史` },
    { key: "fault_unreadable", name: `${FAULT_MARK} 容器不可读`, class_key: "class_fault", dayOffset: 10, note: `${FAULT_MARK} 指南证据容器损坏夹具` },
    { key: "fault_partial", name: `${FAULT_MARK} 依据失效`, class_key: "class_fault", dayOffset: 40, note: `${FAULT_MARK} 依据不可核验夹具` },
  ];
  const children = {} as Record<SeedChildKey, SeedChildRef>;
  const enrollmentIds = {} as Record<SeedChildKey, string[]>;
  const birthBase = new Date(`${semester.start_date}T00:00:00Z`);
  birthBase.setUTCFullYear(birthBase.getUTCFullYear() - 4);
  const birthBaseDate = birthBase.toISOString().slice(0, 10);
  for (const plan of childPlans) {
    const klass = classRefs[plan.class_key];
    const id = randomUUID();
    const birth = addDays(birthBaseDate, plan.dayOffset % 300);
    await run(
      `INSERT INTO children (id, name, gender, birth_date, class_name, note, is_demo)
       VALUES ($1, $2, '女', $3, $4, $5, true)`,
      [id, plan.name, birth, klass.name, plan.note],
    );
    const currentStart = plan.key === "class_c_transfer" ? addDays(semester.start_date, transferSplit + 1) : semester.start_date;
    const currentEnrollment = randomUUID();
    await run(
      `INSERT INTO child_class_enrollments (id, child_id, class_id, start_date)
       VALUES ($1, $2, $3, $4)`,
      [currentEnrollment, id, klass.id, currentStart],
    );
    enrollmentIds[plan.key] = [currentEnrollment];
    children[plan.key] = { id, name: plan.name, class_key: plan.class_key, birth_date: birth };
  }
  // 转班历史：郑小舟先在松果班（截至 transferSplit），再转入云杉班。
  const transferOldEnrollment = randomUUID();
  await run(
    `INSERT INTO child_class_enrollments (id, child_id, class_id, start_date, end_date)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      transferOldEnrollment,
      children.class_c_transfer.id,
      classIds.class_a,
      semester.start_date,
      addDays(semester.start_date, transferSplit),
    ],
  );
  enrollmentIds.class_c_transfer = [transferOldEnrollment, enrollmentIds.class_c_transfer[0]];
  await run(`UPDATE children SET class_name = $2 WHERE id = $1`, [
    children.class_c_transfer.id,
    classRefs.class_c.name,
  ]);

  /* ---- 观察（createObservation/updateObservationAiDraft/confirmObservation） ---- */
  const rawTexts: Record<SeedObservationKey, string> = {
    a1_h1: `${SYNTHETIC_MARK} 集体活动时，王一诺在老师提醒后能自然坐直、站直，保持了大约两分钟。`,
    a1_h2: `${SYNTHETIC_MARK} 区域活动时，王一诺情绪比较稳定，和同伴商量着轮流玩，没有因一点小事哭闹。`,
    a1_h3: `${SYNTHETIC_MARK} 午睡起床后，王一诺情绪依然比较稳定，自己穿好鞋子后安静等待，没有因一点小事哭闹。`,
    a1_h4: `${SYNTHETIC_MARK} 王一诺在本周晨检时测量身高 102 厘米、体重 17 公斤，能独立站直配合测量。`,
    a2_photo: `${SYNTHETIC_MARK} 陈小满用红色和黄色积木搭出一座小桥，还给桥面留出了通道。`,
    a3_empty: `${SYNTHETIC_MARK} 赵小树在阅读区安静翻看绘本，偶尔指着画面微笑。`,
    b1_plain: `${SYNTHETIC_MARK} 王一诺（白桦班）主动把掉落的画笔捡起来放回笔筒。`,
    b2_photo: `${SYNTHETIC_MARK} 周小满在娃娃家给玩偶喂饭，并说“它吃饱了要睡觉”。`,
    b3_draft: `${SYNTHETIC_MARK} 孙小芽在建构区尝试把长积木横着放。`,
    b4_needs_input: `${SYNTHETIC_MARK} 李小禾在美工区站着看同伴画画。`,
    b5_ai_organized: `${SYNTHETIC_MARK} 吴小溪把不同形状的磁力片按颜色分类。`,
    c1_old: `${SYNTHETIC_MARK} 郑小舟在班级种植角给绿萝浇水，并说“它长大啦”。`,
    c1_new: `${SYNTHETIC_MARK} 郑小舟在云杉班主动邀请新同伴一起玩玩具，愿意和小朋友一起游戏。`,
    fault_unreadable: `${FAULT_MARK}${SYNTHETIC_MARK} 该观察用于验证指南证据容器不可读时的降级展示。`,
    fault_partial: `${FAULT_MARK}${SYNTHETIC_MARK} 该观察的关联依据与原文不一致，用于验证部分不可核验。`,
  };
  const observationDates: Record<SeedObservationKey, string> = {
    a1_h1: deriveDate(3),
    a1_h2: deriveDate(6),
    a1_h3: deriveDate(9),
    a1_h4: deriveDate(4),
    a2_photo: deriveDate(5),
    a3_empty: deriveDate(4),
    b1_plain: deriveDate(2),
    b2_photo: deriveDate(5),
    b3_draft: deriveDate(7),
    b4_needs_input: deriveDate(8),
    b5_ai_organized: deriveDate(9),
    c1_old: deriveDate(7),
    c1_new: deriveDate(25),
    fault_unreadable: deriveDate(6),
    fault_partial: deriveDate(8),
  };
  const planned: Record<SeedObservationKey, { child: SeedChildKey; klass: SeedClassKey }> = {
    a1_h1: { child: "class_a_same_name", klass: "class_a" },
    a1_h2: { child: "class_a_same_name", klass: "class_a" },
    a1_h3: { child: "class_a_same_name", klass: "class_a" },
    a1_h4: { child: "class_a_same_name", klass: "class_a" },
    a2_photo: { child: "class_a_shared_photo", klass: "class_a" },
    a3_empty: { child: "class_a_trusted_empty", klass: "class_a" },
    b1_plain: { child: "class_b_same_name", klass: "class_b" },
    b2_photo: { child: "class_b_shared_photo", klass: "class_b" },
    b3_draft: { child: "class_b_draft", klass: "class_b" },
    b4_needs_input: { child: "class_b_needs_input", klass: "class_b" },
    b5_ai_organized: { child: "class_b_ai_organized", klass: "class_b" },
    c1_old: { child: "class_c_transfer", klass: "class_a" },
    c1_new: { child: "class_c_transfer", klass: "class_c" },
    fault_unreadable: { child: "fault_unreadable", klass: "class_fault" },
    fault_partial: { child: "fault_partial", klass: "class_fault" },
  };
  const draftMeta: Partial<Record<SeedObservationKey, { domain: string; sub_domain: string }>> = {
    a1_h1: { domain: "健康", sub_domain: "动作发展" },
    a1_h2: { domain: "健康", sub_domain: "身心状况" },
    a1_h3: { domain: "健康", sub_domain: "身心状况" },
    a1_h4: { domain: "健康", sub_domain: "身心状况" },
    c1_new: { domain: "社会", sub_domain: "人际交往" },
  };
  const draftFor = (key: SeedObservationKey, quote: string, objective: string): ObservationDraft => {
    const meta = draftMeta[key] ?? { domain: "健康", sub_domain: "动作发展" };
    return {
      domain: meta.domain,
      sub_domain: meta.sub_domain,
      objective_description: objective,
      highlights: [quote],
      support_suggestions: [`${SYNTHETIC_MARK} 提供更多自由活动与鼓励`],
      highlight_quote: quote,
      teacher_note: `${SYNTHETIC_MARK} 验收夹具`,
    };
  };
  // 正常种子：原文事实与所关联条目语义一一对应（故意不匹配只出现在故障夹具）
  const quotes: Record<string, string> = {
    a1_h1: "在老师提醒后能自然坐直、站直",
    a1_h2: "情绪比较稳定，和同伴商量着轮流玩",
    a1_h3: "情绪依然比较稳定",
    a1_h4: "身高 102 厘米、体重 17 公斤",
    b1_plain: "主动把掉落的画笔捡起来",
    c1_new: "愿意和小朋友一起游戏",
  };

  const observations = {} as Record<SeedObservationKey, SeedObservationRef>;
  const createdObs = {} as Record<SeedObservationKey, Observation>;
  const createAndMaybeConfirm = async (
    key: SeedObservationKey,
    finalStatus: "draft" | "needs_input" | "ai_organized" | "confirmed",
  ): Promise<void> => {
    const plan = planned[key];
    const child = children[plan.child];
    const klass = classRefs[plan.klass];
    const enrollmentId =
      key === "c1_old"
        ? transferOldEnrollment
        : key === "c1_new"
          ? enrollmentIds.class_c_transfer[1]
          : enrollmentIds[plan.child][0];
    const observedAt = observationDates[key];
    const snapshot = {
      class_id: klass.id,
      class_name: klass.name,
      stage: klass.stage,
      school_year: klass.school_year,
      captured_at: dateTTimestamp(observedAt),
      source: "enrollment_lookup" as const,
      enrollment_id: enrollmentId,
      confirmed_at: null,
    };
    const created = await createObservation({
      child_id: child.id,
      observed_at: observedAt,
      context: `${SYNTHETIC_MARK} 验收种子`,
      raw_text: rawTexts[key],
      is_demo: true,
      class_context_snapshot: snapshot,
      premise: {
        class_id: klass.id,
        class_name: klass.name,
        stage: klass.stage,
        school_year: klass.school_year,
        enrollment_id: enrollmentId,
        observed_at: observedAt,
      },
    });
    createdObs[key] = created;
    observations[key] = {
      id: created.id,
      child_key: plan.child,
      class_key: plan.klass,
      status: created.status,
      observed_at: observedAt,
      raw_text: rawTexts[key],
    };
    if (finalStatus === "draft") return;
    if (finalStatus === "needs_input") {
      // 产品路径：写入待补充追问上下文并进入 needs_input（供“记不清/跳过”场景）
      const followUpContext: AgentContext = {
        follow_up: {
          round: 1,
          question: `${SYNTHETIC_MARK} 当时她是一个人玩还是和同伴一起？`,
          reason: `${SYNTHETIC_MARK} 需要补充同伴互动信息`,
          answers: [],
          stopped: false,
          rounds: [
            {
              round: 1,
              question: `${SYNTHETIC_MARK} 当时她是一个人玩还是和同伴一起？`,
              reason: `${SYNTHETIC_MARK} 需要补充同伴互动信息`,
              answer: null,
            },
          ],
        },
      };
      const waiting = await updateObservationAgentContext(created.id, followUpContext, "needs_input");
      createdObs[key] = waiting;
      observations[key].status = waiting.status;
      return;
    }
    const draft = draftFor(key, quotes[key] ?? SYNTHETIC_MARK, `${SYNTHETIC_MARK} 合成整理目标`);
    const organized = await updateObservationAiDraft(created.id, draft, "qa-seed1-fixture-model");
    createdObs[key] = organized;
    observations[key].status = organized.status;
    if (finalStatus === "ai_organized") return;
    const confirmed = await confirmObservation(
      organized.id,
      organized.child_id,
      draft,
      {
        status: organized.status,
        agentContext: organized.agent_context ?? null,
        aiDraft: organized.ai_draft ?? null,
      },
    );
    createdObs[key] = confirmed;
    observations[key].status = confirmed.status;
  };
  await createAndMaybeConfirm("a1_h1", "confirmed");
  await createAndMaybeConfirm("a1_h2", "confirmed");
  await createAndMaybeConfirm("a1_h3", "confirmed");
  await createAndMaybeConfirm("a1_h4", "confirmed");
  await createAndMaybeConfirm("a2_photo", "confirmed");
  await createAndMaybeConfirm("a3_empty", "confirmed");
  await createAndMaybeConfirm("b1_plain", "confirmed");
  await createAndMaybeConfirm("b2_photo", "confirmed");
  await createAndMaybeConfirm("b3_draft", "draft");
  await createAndMaybeConfirm("b4_needs_input", "needs_input");
  await createAndMaybeConfirm("b5_ai_organized", "ai_organized");
  await createAndMaybeConfirm("c1_old", "confirmed");
  await createAndMaybeConfirm("c1_new", "confirmed");
  await createAndMaybeConfirm("fault_unreadable", "confirmed");
  await createAndMaybeConfirm("fault_partial", "confirmed");

  /* ---- 指南证据（产品 decisions 写入路径；依据由服务端事实生成） ---- */
  const allItems = await listGuideItems();
  const pickItem = (evidenceType: GuidePerformanceItem["product_rules"]["evidence_type"], band: "3-4" | "4-5" | "5-6"): GuidePerformanceItem => {
    const exact = allItems.find(
      (item) => item.age_band === band && item.product_rules.evidence_type === evidenceType,
    );
    const fallback = allItems.find((item) => item.product_rules.evidence_type === evidenceType);
    const item = exact ?? fallback;
    assert(item, `指南目录缺少 evidence_type=${evidenceType} 的条目`);
    return item;
  };
  const behaviorItem = pickItem("behavior", "3-4");
  const sustainedItem = pickItem("sustained", "3-4");
  const healthItem = pickItem("health_reference", "3-4");
  const socialItem = allItems.find(
    (item) =>
      item.age_band === "3-4" &&
      item.domain_id.includes("social") &&
      item.product_rules.evidence_type === "behavior",
  );
  assert(socialItem, "指南目录缺少社会领域 3-4 岁行为类条目");
  const basisOf = (key: SeedObservationKey, quote: string) => ({
    observation_id: createdObs[key].id,
    quote,
    quote_source: "raw_text" as const,
    quote_field: null,
  });
  // 条目与事实对照：坐直站直 → 行为条目；两日情绪稳定 → 持续性条目（含期间纪要）；
  // 晨检身高体重 → 保健参考条目；愿意和同伴游戏 → 社会领域行为条目。
  await applyGuideEvidenceMutation(createdObs.a1_h1.id, {
    action: "confirm",
    expected_guide_revision: 0,
    decisions: [
      {
        item_id: behaviorItem.id,
        support: "single_event",
        basis: [basisOf("a1_h1", quotes.a1_h1)],
        adult_help_used: false,
        teacher_note: `${SYNTHETIC_MARK} 坐直站直对应行为类条目（夹具）`,
      },
    ],
  });
  await applyGuideEvidenceMutation(createdObs.a1_h2.id, {
    action: "confirm",
    expected_guide_revision: 0,
    decisions: [
      {
        item_id: sustainedItem.id,
        support: "sustained",
        basis: [basisOf("a1_h2", quotes.a1_h2), basisOf("a1_h3", quotes.a1_h3)],
        sustained_note: {
          period_start: observationDates.a1_h2,
          period_end: observationDates.a1_h3,
          description: `${SYNTHETIC_MARK} 跨两日观察到王一诺情绪比较稳定、很少因小事哭闹（合成验收纪要）`,
        },
        adult_help_used: false,
        teacher_note: `${SYNTHETIC_MARK} 情绪稳定持续性表现（夹具）`,
      },
    ],
  });
  await applyGuideEvidenceMutation(createdObs.a1_h4.id, {
    action: "confirm",
    expected_guide_revision: 0,
    decisions: [
      {
        item_id: healthItem.id,
        support: "single_event",
        basis: [basisOf("a1_h4", quotes.a1_h4)],
        adult_help_used: false,
        teacher_note: `${SYNTHETIC_MARK} 身高体重对应保健参考类（夹具，不参与行为统计）`,
      },
    ],
  });
  await applyGuideEvidenceMutation(createdObs.c1_new.id, {
    action: "confirm",
    expected_guide_revision: 0,
    decisions: [
      {
        item_id: socialItem.id,
        support: "single_event",
        basis: [basisOf("c1_new", quotes.c1_new)],
        adult_help_used: false,
        teacher_note: `${SYNTHETIC_MARK} 愿意和同伴游戏对应社会领域条目（夹具）`,
      },
    ],
  });
  const linkCountOf = async (key: SeedObservationKey): Promise<number> => {
    const current = await getObservation(createdObs[key].id);
    const parsed = current ? parseGuideEvidence(current.guide_evidence) : { kind: "none" as const };
    return parsed.kind === "ok" ? parsed.links.length : -1;
  };
  assert((await linkCountOf("a1_h1")) === 1, "指南证据写入后应可读取（行为类）");
  assert((await linkCountOf("a1_h2")) === 1, "指南证据写入后应可读取（持续性）");
  assert((await linkCountOf("a1_h4")) === 1, "指南证据写入后应可读取（保健参考）");

  /* ---- 媒体：两名幼儿共用一张合成照片，各自事实不同 ---- */
  const image = await syntheticSharedPhoto();
  const metadata = createDataAttachmentMetadataPort();
  const deps: MediaServiceDeps = {
    metadata,
    store: new LocalMediaObjectStore(resources.object_root),
    environment: "development",
  };
  const upload = await uploadImages(deps, {
    owner_account_id: teacherA.account_id,
    files: [
      {
        filename: "synthetic-shared.png",
        declared_content_type: "image/png",
        body: image,
        client_upload_id: `${seedId}-shared-photo`,
      },
    ],
  });
  const uploaded = upload.uploads[0];
  assert(uploaded !== undefined && uploaded.ok, "合成照片上传失败");
  const attachmentId = uploaded.attachment.attachment_id;
  const mediaRecord = await metadata.get(attachmentId);
  assert(mediaRecord !== null, "合成照片元数据缺失");
  for (const key of ["a2_photo", "b2_photo"] as const) {
    await tx(async (client) => {
      await yayaDataRepository.addObservationAttachmentRefs(client, {
        observation_id: createdObs[key].id,
        attachment_ids: [attachmentId],
        actor_account_id: teacherA.account_id,
      });
    });
  }
  await run(
    `UPDATE yaya_attachments
        SET metadata = jsonb_build_object('synthetic', true, 'fixture', $2::text, 'seed_id', $3::text)
      WHERE id = $1`,
    [attachmentId, `${SYNTHETIC_MARK} 两名幼儿共用合成照片`, seedId],
  );

  /* ---- 会话与消息（owner 私有；权限收紧后的历史消息） ---- */
  const principalA = buildPrincipal(
    {
      id: teacherA.account_id,
      username: teacherA.username,
      display_name: teacherA.display_name,
      role: "teacher",
      status: "active",
      class_ids: [classIds.class_a, classIds.class_b, classIds.class_fault],
    },
    ACCEPTANCE_SCHOOL_ID,
  );
  const principalB = buildPrincipal(
    {
      id: teacherB.account_id,
      username: teacherB.username,
      display_name: teacherB.display_name,
      role: "teacher",
      status: "active",
      class_ids: [classIds.class_c],
    },
    ACCEPTANCE_SCHOOL_ID,
  );
  const provenance = (refId: string | null) => ({
    kind: "child_fact" as const,
    ref_id: refId,
    label: `${SYNTHETIC_MARK} 观察事实`,
    derived_from: null,
  });
  const fragment = (
    fragmentId: string,
    text: string,
    sources: YayaMessageSourceRef[],
    provenanceRef: string | null,
  ): YayaStoredFragment => ({
    fragment_id: fragmentId,
    text,
    sources,
    independently_readable: true,
    provenance: provenance(provenanceRef),
  });
  const conversationA = await tx((client) =>
    yayaDataRepository.createConversation(client, {
      owner_account_id: teacherA.account_id,
      title: `${SYNTHETIC_MARK} 王一诺的观察讨论`,
    }),
  );
  let revision = conversationA.revision;
  const saveMessage = async (
    conversationId: string,
    principal: typeof principalA,
    clientMessageId: string,
    role: "user" | "assistant",
    fragments: YayaStoredFragment[],
  ): Promise<void> => {
    const result = await tx((client) =>
      role === "assistant" ? yayaDataRepository.saveRunTerminalMessage(client, principal, ACCEPTANCE_SCHOOL_ID, {
        conversation_id: conversationId, role: "assistant", message_kind: "text", execution_state: "none", fragments,
        attachment_ids: [], expected_conversation_revision: revision,
        run: { run_id: clientMessageId, client_request_id: clientMessageId }, binding_state: "bound",
      }) : yayaDataRepository.saveMessage(client, principal, ACCEPTANCE_SCHOOL_ID, {
        conversation_id: conversationId,
        client_message_id: clientMessageId,
        role,
        message_kind: "text",
        execution_state: "none",
        fragments,
        attachment_ids: [],
        expected_conversation_revision: revision,
      }),
    );
    revision = result.conversation.revision;
  };
  await saveMessage(conversationA.conversation_id, principalA, `${seedId}-m1`, "user", [
    fragment("f-question", `${SYNTHETIC_MARK} 请帮我看看王一诺这周的观察可以怎么记录？`, [], null),
  ]);
  await saveMessage(conversationA.conversation_id, principalA, `${seedId}-m2`, "assistant", [
    fragment(
      "f-full",
      `${SYNTHETIC_MARK} 王一诺在松果班的动作表现有明确记录。`,
      [{ kind: "child", child_id: children.class_a_same_name.id, current_class_id: classIds.class_a }],
      createdObs.a1_h1.id,
    ),
  ]);
  await saveMessage(conversationA.conversation_id, principalA, `${seedId}-m3`, "assistant", [
    fragment(
      "f-history",
      `${SYNTHETIC_MARK} 这是郑小舟在松果班时期的观察：给绿萝浇水并说“它长大啦”。`,
      [
        {
          kind: "observation",
          observation_id: createdObs.c1_old.id,
          child_id: children.class_c_transfer.id,
          current_class_id: classIds.class_c,
          observed_class_id: classIds.class_a,
        },
      ],
      createdObs.c1_old.id,
    ),
  ]);
  await saveMessage(conversationA.conversation_id, principalA, `${seedId}-m4`, "assistant", [
    fragment(
      "f-denied",
      `${SYNTHETIC_MARK} 郑小舟转到云杉班后的记录（当前任教范围外）。`,
      [{ kind: "child", child_id: children.class_c_transfer.id, current_class_id: classIds.class_c }],
      createdObs.c1_new.id,
    ),
  ]);
  const restrictedTitle = `${SYNTHETIC_MARK} 受限标题不应外泄`;
  await tx((client) =>
    yayaDataRepository.renameConversation(client, {
      principal: principalA,
      school_id: ACCEPTANCE_SCHOOL_ID,
      conversation_id: conversationA.conversation_id,
      title: restrictedTitle,
      title_source_fragments: ["f-history"],
      expected_revision: revision,
    }),
  );

  const conversationB = await tx((client) =>
    yayaDataRepository.createConversation(client, {
      owner_account_id: teacherB.account_id,
      title: `${SYNTHETIC_MARK} 教师B私有会话`,
    }),
  );
  await tx((client) =>
    yayaDataRepository.saveRunTerminalMessage(client, principalB, ACCEPTANCE_SCHOOL_ID, {
      conversation_id: conversationB.conversation_id,
      run: { run_id: `${seedId}-b1`, client_request_id: `${seedId}-b1` }, binding_state: "bound",
      role: "assistant",
      message_kind: "text",
      execution_state: "none",
      fragments: [fragment("f-b-private", `${SYNTHETIC_MARK} 教师B的私有消息正文。`, [], null)],
      attachment_ids: [],
      expected_conversation_revision: conversationB.revision,
    }),
  );

  /* ---- 故障夹具（显式标注，与正常种子分开）：损坏容器 / 失效依据 / 详情不可读回执 ---- */
  const unreadableObservation = createdObs.fault_unreadable;
  await run(`UPDATE observations SET guide_evidence = '"fixture: unreadable container"'::jsonb WHERE id = $1`, [
    unreadableObservation.id,
  ]);
  const partialObservation = createdObs.fault_partial;
  assert(partialObservation.class_context_snapshot, "故障夹具缺少发生时班级快照");
  const partialQuote = "这段文字刻意不在原始观察中";
  await run(
    `UPDATE observations
        SET guide_evidence = jsonb_build_object(
          'revision', 1,
          'links', jsonb_build_array(jsonb_build_object(
            'id', $2::text,
            'item_id', $3::text,
            'catalog_version', $4::text,
            'origin', 'manual',
            'status', 'confirmed_performance',
            'support', 'single_event',
            'adult_help_used', false,
            'basis', jsonb_build_array(jsonb_build_object(
              'observation_id', $1::text,
              'observed_at', $5::text,
              'quote', $6::text,
              'quote_source', 'raw_text',
              'quote_field', null,
              'class_context', $7::jsonb,
              'source_confirmed_at', $8::text
            )),
            'ai_reason', null,
            'teacher_note', $9::text,
            'revision', 1,
            'created_at', $8::text,
            'decided_at', $8::text,
            'withdrawn_at', null,
            'withdrawn_reason', null
          ))
        )
      WHERE id = $1`,
    [
      partialObservation.id,
      randomUUID(),
      behaviorItem.id,
      GUIDE_CATALOG_VERSION,
      partialObservation.observed_at,
      partialQuote,
      JSON.stringify(partialObservation.class_context_snapshot),
      partialObservation.confirmed_at ?? dateTTimestamp(partialObservation.observed_at),
      `${FAULT_MARK} 依据与原文不一致（故障夹具）`,
    ],
  );
  const faultConversationId = randomUUID();
  const faultProposalId = randomUUID();
  const faultBatchId = randomUUID();
  const faultOperationId = randomUUID();
  await run(
    `INSERT INTO yaya_conversations (id, account_id, title, revision)
     VALUES ($1, $2, $3, 1)`,
    [faultConversationId, teacherA.account_id, `${FAULT_MARK} 回执查询（合成）`],
  );
  await run(
    `INSERT INTO yaya_proposals
       (id, batch_id, conversation_id, owner_account_id, proposal_origin, auth, status)
     VALUES ($1, $2, $3, $4, 'teacher_card', '{"kind":"action","action":"observation.confirm","resource":"observation"}'::jsonb, 'closed')`,
    [faultProposalId, faultBatchId, faultConversationId, teacherA.account_id],
  );
  await run(
    `INSERT INTO yaya_proposal_items
       (id, proposal_id, item_key, operation_id, target_id, action, resource, resource_ref,
        payload, content_digest, status)
     VALUES ($1, $2, 'fixture-detail-unavailable', $3, $4, 'observation.confirm', 'observation',
             $5::jsonb, '{"fixture":"detail unavailable receipt"}'::jsonb, $6, 'approved')`,
    [
      randomUUID(),
      faultProposalId,
      faultOperationId,
      createdObs.a1_h1.id,
      JSON.stringify({ kind: "observation", observation_id: createdObs.a1_h1.id }),
      "f".repeat(64),
    ],
  );
  await run(
    `INSERT INTO yaya_operations
       (operation_id, proposal_id, item_key, batch_id, target_id, actor_account_id,
        status, effect, business_object_id, business_revision, started_at, recorded_at)
     VALUES ($1, $2, 'fixture-detail-unavailable', $3, $4, $5,
             'saved_detail_unavailable', 'committed', $4, 'fixture-revision-1', now(), now())`,
    [
      faultOperationId,
      faultProposalId,
      faultBatchId,
      createdObs.a1_h1.id,
      teacherA.account_id,
    ],
  );

  const manifest: AcceptanceSeedManifest = {
    seed_id: seedId,
    generated_at: new Date().toISOString(),
    semester,
    school_id: ACCEPTANCE_SCHOOL_ID,
    classes: classRefs,
    accounts: {
      admin: {
        account_id: admin.account_id,
        username: admin.username,
        display_name: admin.display_name,
        role: "admin",
        current_class_keys: [],
      },
      teacher_a: {
        account_id: teacherA.account_id,
        username: teacherA.username,
        display_name: teacherA.display_name,
        role: "teacher",
        current_class_keys: ["class_a", "class_b", "class_fault"],
      },
      teacher_b: {
        account_id: teacherB.account_id,
        username: teacherB.username,
        display_name: teacherB.display_name,
        role: "teacher",
        current_class_keys: ["class_c"],
      },
      teacher_c: {
        account_id: teacherC.account_id,
        username: teacherC.username,
        display_name: teacherC.display_name,
        role: "teacher",
        current_class_keys: [],
      },
    },
    children,
    observations,
    guide_items: {
      behavior_item_id: behaviorItem.id,
      sustained_item_id: sustainedItem.id,
      health_reference_item_id: healthItem.id,
      social_behavior_item_id: socialItem.id,
    },
    conversations: {
      teacher_a_scenario: {
        conversation_id: conversationA.conversation_id,
        restricted_title: restrictedTitle,
      },
      teacher_b_private: { conversation_id: conversationB.conversation_id },
    },
    media: {
      shared_photo: {
        attachment_id: attachmentId,
        object_key: mediaRecord.object_key,
        source_checksum: mediaRecord.source_checksum ?? "",
        linked_child_keys: ["class_a_shared_photo", "class_b_shared_photo"],
        linked_observation_keys: ["a2_photo", "b2_photo"],
      },
    },
    fault_fixtures: {
      unreadable_child_key: "fault_unreadable",
      partial_child_key: "fault_partial",
      unreadable_observation_key: "fault_unreadable",
      partial_observation_key: "fault_partial",
      operation: {
        operation_id: faultOperationId,
        proposal_id: faultProposalId,
        batch_id: faultBatchId,
        conversation_id: faultConversationId,
        business_object_id: createdObs.a1_h1.id,
        status: "saved_detail_unavailable",
      },
    },
  };
  return { manifest, credentials };
}
