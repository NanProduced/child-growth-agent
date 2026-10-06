/**
 * YAYA-QA-SEED1 种子事实回读（只读，不写库、不调用模型）。
 *
 * 回读优先使用产品读路径：read model（loadChildEvidenceBook / loadClassEvidenceOverview）、
 * yayaDataRepository（会话/消息投影、附件、原操作查询）；底层 SQL 只用于核对表级事实。
 * 任一检查失败都会在收集完全部结果后抛错，便于一次性看到全部偏差。
 */
import fs from "node:fs";
import path from "node:path";

import type { QueryResultRow } from "pg";

import { buildPrincipal } from "../../../src/lib/accounts/repository";
import type { EvidenceObservation } from "../../../src/lib/guide/runtime";
import { checkBasis, parseGuideEvidence } from "../../../src/lib/guide/runtime";
import {
  loadChildEvidenceBook,
  loadClassEvidenceOverview,
} from "../../../src/lib/guide/read-model";
import type {
  ChildEvidenceBook,
  ChildGuideItemView,
  ClassEvidenceOverview,
  ClassGuideItemView,
} from "../../../src/lib/guide/view-types";
import { listObservationsForChildren } from "../../../src/lib/queries";
import { yayaDataRepository } from "../../../src/lib/yaya/data";
import { YayaDataError } from "../../../src/lib/yaya/storage-types";
import { withTransaction } from "../../../src/storage/database/pg-client";
import { sha256Hex } from "../../../src/lib/media/object-store";
import type { AcceptanceResources } from "./resources";
import { ACCEPTANCE_SCHOOL_ID } from "./resources";
import { syntheticSharedPhoto } from "./media";
import type { AcceptanceSeedManifest, AcceptanceVerification, VerificationCheck } from "./types";
import { FAULT_MARK, SYNTHETIC_MARK } from "./types";

export type { AcceptanceVerification, VerificationCheck } from "./types";

async function rows<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  return withTransaction(async (client) => (await client.query<T>(sql, params)).rows);
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const result = await rows<{ n: number }>(sql, params);
  return Number(result[0]?.n ?? -1);
}

function flattenChildItems(book: ChildEvidenceBook): Map<string, ChildGuideItemView> {
  const map = new Map<string, ChildGuideItemView>();
  for (const goal of book.goals) {
    for (const item of goal.items) map.set(item.item.id, item);
  }
  return map;
}

function flattenClassItems(overview: ClassEvidenceOverview): Map<string, ClassGuideItemView> {
  const map = new Map<string, ClassGuideItemView>();
  for (const goal of overview.goals) {
    for (const item of goal.items) map.set(item.item.id, item);
  }
  return map;
}

function listObjectFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

export async function verifyAcceptanceSeed(
  resources: AcceptanceResources,
  manifest: AcceptanceSeedManifest,
): Promise<AcceptanceVerification> {
  const checks: VerificationCheck[] = [];
  const record = (label: string, ok: boolean, detail = ""): void => {
    checks.push({ label, ok, detail });
  };
  const expect = (label: string, condition: boolean, detail = ""): void => record(label, condition, detail);

  /* ---------- 库身份 ---------- */
  const identity = await rows<{ db: string; usr: string }>(
    "SELECT current_database() AS db, current_user AS usr",
  );
  expect(
    "库身份：连接的是本轮隔离库",
    identity[0]?.db === resources.db_name && identity[0]?.usr === "postgres",
    JSON.stringify(identity[0] ?? null),
  );

  /* ---------- 账号/角色/任教 ---------- */
  const accountRows = await rows<{
    id: string;
    username: string;
    role: string;
    status: string;
  }>("SELECT id, username, role, status FROM app_accounts ORDER BY username");
  expect("账号：共 4 个且全部为本轮种子", accountRows.length === 4, `count=${accountRows.length}`);
  expect(
    "账号：全部 active 且用户名带本轮种子前缀",
    accountRows.every((row) => row.status === "active" && row.username.startsWith(manifest.seed_id)),
  );
  expect(
    "账号：管理员/教师角色数量",
    accountRows.filter((row) => row.role === "admin").length === 1 &&
      accountRows.filter((row) => row.role === "teacher").length === 3,
  );
  const teacherAClasses = await rows<{ class_id: string }>(
    "SELECT class_id FROM teacher_class_assignments WHERE account_id = $1 AND removed_at IS NULL ORDER BY class_id",
    [manifest.accounts.teacher_a.account_id],
  );
  expect(
    "任教：教师A 当前负责 3 个班（含故障隔离班）",
    teacherAClasses.length === 3 &&
      new Set(teacherAClasses.map((row) => row.class_id)).size === 3,
    `count=${teacherAClasses.length}`,
  );
  const teacherCClasses = await count(
    "SELECT count(*)::int AS n FROM teacher_class_assignments WHERE account_id = $1 AND removed_at IS NULL",
    [manifest.accounts.teacher_c.account_id],
  );
  expect("任教：未分配教师没有当前任教", teacherCClasses === 0, `count=${teacherCClasses}`);
  const removedAssignments = await count(
    `SELECT count(*)::int AS n FROM teacher_class_assignments
      WHERE account_id = $1 AND class_id = $2 AND removed_at IS NOT NULL`,
    [manifest.accounts.teacher_a.account_id, manifest.classes.class_c.id],
  );
  expect("撤权：教师A 对云杉班存在已撤销历史任教", removedAssignments >= 1, `count=${removedAssignments}`);

  /* ---------- 分班与日期派生 ---------- */
  const openEnrollmentCounts = await rows<{ child_id: string; n: number }>(
    `SELECT child_id, count(*)::int AS n FROM child_class_enrollments
      WHERE end_date IS NULL GROUP BY child_id`,
  );
  const seededChildIds = Object.values(manifest.children).map((child) => child.id);
  expect(
    "分班：每名种子幼儿恰有一条当前归属",
    seededChildIds.every(
      (id) => openEnrollmentCounts.find((row) => row.child_id === id)?.n === 1,
    ),
    JSON.stringify(openEnrollmentCounts),
  );
  const transferEnrollments = await rows<{ start_date: string; end_date: string | null }>(
    "SELECT start_date, end_date FROM child_class_enrollments WHERE child_id = $1 ORDER BY start_date",
    [manifest.children.class_c_transfer.id],
  );
  expect(
    "转班：郑小舟有两条归属且旧归属在转班日前结束",
    transferEnrollments.length === 2 &&
      transferEnrollments[0]?.end_date !== null &&
      transferEnrollments[1]?.start_date !== null &&
      transferEnrollments[0]?.end_date < transferEnrollments[1]?.start_date,
    JSON.stringify(transferEnrollments),
  );
  const observationsInEnrollment = await rows<{ id: string; observed_at: string; n: number }>(
    `SELECT o.id, o.observed_at,
            (SELECT count(*)::int FROM child_class_enrollments e
              WHERE e.child_id = o.child_id
                AND e.start_date <= o.observed_at
                AND (e.end_date IS NULL OR e.end_date >= o.observed_at)) AS n
       FROM observations o WHERE o.id = ANY($1::text[])`,
    [Object.values(manifest.observations).map((obs) => obs.id)],
  );
  expect(
    "日期：每条观察都落在其幼儿已保存的某段分班事实内",
    observationsInEnrollment.every((row) => row.n === 1),
    JSON.stringify(observationsInEnrollment.filter((row) => row.n !== 1)),
  );
  expect(
    `日期：全部观察日期都在当前学期 ${manifest.semester.id} 内`,
    Object.values(manifest.observations).every(
      (obs) => obs.observed_at >= manifest.semester.start_date && obs.observed_at <= manifest.semester.end_date,
    ),
  );

  /* ---------- 观察状态与合成标记 ---------- */
  const statusCounts = await rows<{ status: string; n: number }>(
    "SELECT status, count(*)::int AS n FROM observations GROUP BY status",
  );
  const statusOf = (status: string): number => statusCounts.find((row) => row.status === status)?.n ?? 0;
  expect(
    "状态：draft / needs_input / ai_organized / confirmed 均有种子",
    statusOf("draft") >= 1 && statusOf("needs_input") >= 1 && statusOf("ai_organized") >= 1 && statusOf("confirmed") >= 1,
    JSON.stringify(statusCounts),
  );
  const rawMismatch = await count(
    `SELECT count(*)::int AS n FROM observations WHERE id = ANY($1::text[]) AND raw_text NOT LIKE '%' || $2 || '%'`,
    [Object.values(manifest.observations).map((obs) => obs.id), SYNTHETIC_MARK],
  );
  expect("合成标记：全部观察原文带 [合成] 标记", rawMismatch === 0, `mismatch=${rawMismatch}`);
  const demoFlags = await rows<{ kind: string; n: number }>(
    `SELECT 'classes' AS kind, count(*)::int AS n FROM classes WHERE is_demo = false
     UNION ALL SELECT 'children', count(*)::int FROM children WHERE is_demo = false
     UNION ALL SELECT 'observations', count(*)::int FROM observations WHERE is_demo = false`,
  );
  expect(
    "合成标记：库内不存在非 is_demo 的班级/幼儿/观察",
    demoFlags.every((row) => row.n === 0),
    JSON.stringify(demoFlags),
  );

  /* ---------- 指南证据容器（正常种子） ---------- */
  const childObservationMap = async (childId: string): Promise<Map<string, EvidenceObservation>> => {
    const list = await listObservationsForChildren([childId]);
    return new Map(list.map((observation) => [observation.id, observation]));
  };
  const a1Map = await childObservationMap(manifest.children.class_a_same_name.id);
  const h1 = a1Map.get(manifest.observations.a1_h1.id);
  const h3 = a1Map.get(manifest.observations.a1_h3.id);
  const h1Parsed = h1 ? parseGuideEvidence(h1.guide_evidence) : { kind: "none" as const };
  const expectOk = h1Parsed.kind === "ok" ? h1Parsed : null;
  expect(
    "指南：a1_h1 容器可解析且含 2 条关联",
    expectOk !== null && expectOk.links.length === 2,
    `kind=${h1Parsed.kind}`,
  );
  if (expectOk && h1) {
    expect(
      "指南：a1_h1 两条关联目录版本为当前版本",
      expectOk.links.every((link) => link.catalog_version === "moe-3-6-2012.v1"),
    );
    const validChecks = expectOk.links.map((link) =>
      link.basis.map((basis) => checkBasis(basis, manifest.children.class_a_same_name.id, a1Map)),
    );
    expect(
      "指南：a1_h1 全部依据逐条可核验（来源存在/同儿童/已确认/版本一致/片段可核对）",
      validChecks.every((list) => list.length > 0 && list.every((entry) => entry.valid)),
      JSON.stringify(validChecks),
    );
  }
  const h3Parsed = h3 ? parseGuideEvidence(h3.guide_evidence) : { kind: "none" as const };
  expect("指南：a1_h3 保健参考关联存在且依据有效", h3Parsed.kind === "ok" && h3Parsed.links.length === 1);
  if (h3Parsed.kind === "ok" && h3) {
    expect(
      "指南：a1_h3 依据可核验",
      h3Parsed.links[0]?.basis.every((basis) =>
        checkBasis(basis, manifest.children.class_a_same_name.id, a1Map).valid,
      ) === true,
    );
  }

  /* ---------- 读模型：个人证据册 ---------- */
  const a1Book = await loadChildEvidenceBook(manifest.children.class_a_same_name.id, {
    scope: "current_semester",
  });
  expect("读模型：王一诺（松果班）证据册可读取", a1Book.ok === true);
  if (a1Book.ok) {
    const items = flattenChildItems(a1Book.value);
    const behavior = items.get(manifest.guide_items.behavior_item_id);
    const sustained = items.get(manifest.guide_items.sustained_item_id);
    const health = items.get(manifest.guide_items.health_reference_item_id);
    expect(
      "读模型：行为/持续性/保健参考三类条目均为 confirmed_observed 且 reliable",
      behavior?.status === "confirmed_observed" &&
        behavior.reliability === "reliable" &&
        sustained?.status === "confirmed_observed" &&
        sustained.reliability === "reliable" &&
        health?.status === "confirmed_observed" &&
        health.reliability === "reliable",
      JSON.stringify({
        behavior: behavior?.status,
        sustained: sustained?.status,
        health: health?.status,
      }),
    );
    expect(
      "读模型：保健参考条目不参与行为统计",
      health?.item.product_rules.counts_in_behavior_stats === false,
    );
    expect(
      "读模型：持续性关联带期间纪要且计入状态",
      sustained?.links.some(
        (link) =>
          link.support === "sustained" &&
          link.counts_toward_status &&
          link.sustained_note !== null &&
          link.sustained_note.description.length >= 10,
      ) === true,
    );
  }
  const emptyBook = await loadChildEvidenceBook(manifest.children.class_a_trusted_empty.id, {
    scope: "current_semester",
  });
  expect("读模型：可信空数据幼儿证据册可读取", emptyBook.ok === true);
  if (emptyBook.ok) {
    const items = flattenChildItems(emptyBook.value);
    const sample = items.get(manifest.guide_items.behavior_item_id);
    expect(
      "读模型：可信空数据 = no_records + reliable，并提示 empty_evidence",
      sample?.status === "no_records" &&
        sample.reliability === "reliable" &&
        emptyBook.value.notices.some((notice) => notice.code === "empty_evidence"),
      JSON.stringify({ status: sample?.status, reliability: sample?.reliability }),
    );
  }
  const unreadableBook = await loadChildEvidenceBook(manifest.children.fault_unreadable.id, {
    scope: "current_semester",
  });
  expect("读模型：损坏容器幼儿证据册可读取", unreadableBook.ok === true);
  if (unreadableBook.ok) {
    const sample = flattenChildItems(unreadableBook.value).get(manifest.guide_items.behavior_item_id);
    expect(
      "读模型：损坏容器 → 不可用（不冒充正常 0）",
      sample?.reliability === "unavailable",
      String(sample?.reliability),
    );
  }
  const partialBook = await loadChildEvidenceBook(manifest.children.fault_partial.id, {
    scope: "current_semester",
  });
  expect("读模型：失效依据幼儿证据册可读取", partialBook.ok === true);
  if (partialBook.ok) {
    const sample = flattenChildItems(partialBook.value).get(manifest.guide_items.behavior_item_id);
    expect(
      "读模型：依据失效 → 部分不可核验（partial）",
      sample?.reliability === "partial",
      String(sample?.reliability),
    );
  }

  /* ---------- 读模型：班级同期聚合 ---------- */
  const classA = await loadClassEvidenceOverview(manifest.classes.class_a.id, {
    scope: "current_semester",
  });
  expect("读模型：松果班聚合可读取", classA.ok === true);
  if (classA.ok) {
    const items = flattenClassItems(classA.value);
    const behavior = items.get(manifest.guide_items.behavior_item_id);
    const health = items.get(manifest.guide_items.health_reference_item_id);
    expect(
      "班级聚合：行为条目 reliable 且给出占比",
      behavior?.reliability === "reliable" && behavior.confirmed_ratio !== null,
      JSON.stringify({ reliability: behavior?.reliability, ratio: behavior?.confirmed_ratio }),
    );
    expect(
      "班级聚合：保健参考条目不显示行为占比",
      health !== undefined && health.confirmed_ratio === null,
    );
    expect(
      "班级聚合：名单为该班当前在班幼儿（不含转走的郑小舟）",
      classA.value.roster.child_count === 3,
      `count=${classA.value.roster.child_count}`,
    );
  }
  const classFault = await loadClassEvidenceOverview(manifest.classes.class_fault.id, {
    scope: "current_semester",
  });
  expect("读模型：故障隔离班聚合可读取", classFault.ok === true);
  if (classFault.ok) {
    const behavior = flattenClassItems(classFault.value).get(manifest.guide_items.behavior_item_id);
    expect(
      "班级聚合：故障名单使整体为 partial（混合可读/不可读）",
      behavior?.reliability === "partial",
      String(behavior?.reliability),
    );
    expect(
      "班级聚合：故障班名单只含两条故障夹具幼儿",
      classFault.value.roster.child_count === 2,
      `count=${classFault.value.roster.child_count}`,
    );
  }

  /* ---------- 媒体附件 ---------- */
  const media = await withTransaction((client) =>
    yayaDataRepository.getMediaAttachment(client, manifest.media.shared_photo.attachment_id),
  );
  const image = await syntheticSharedPhoto();
  expect(
    "媒体：附件 ready、owner 为教师A、原始 checksum 可核验",
    media !== null &&
      media.status === "ready" &&
      media.owner_account_id === manifest.accounts.teacher_a.account_id &&
      media.source_checksum === sha256Hex(image),
    JSON.stringify({
      status: media?.status,
      checksum: media?.source_checksum?.slice(0, 12) ?? null,
    }),
  );
  if (media) {
    const expectedKeys = [
      [media.object_key, media.checksum_sha256],
      [media.thumbnail_key, media.thumbnail_checksum],
      [media.model_key, media.model_checksum],
    ] as const;
    const files = listObjectFiles(resources.object_root);
    expect("媒体：对象目录只有本附件 3 个派生对象", files.length === 3, files.join(","));
    const diskOk = expectedKeys.every(([key, checksum]) => {
      const file = path.join(resources.object_root, ...key.split("/"));
      if (!fs.existsSync(file)) return false;
      return sha256Hex(fs.readFileSync(file)) === checksum;
    });
    expect("媒体：3 个对象落地且与元数据 checksum 一致", diskOk);
    const metadataRow = await rows<{ synthetic: boolean }>(
      "SELECT (metadata->>'synthetic')::boolean AS synthetic FROM yaya_attachments WHERE id = $1",
      [media.attachment_id],
    );
    expect("媒体：附件 metadata 带 synthetic 标记", metadataRow[0]?.synthetic === true);
  }
  const refRows = await rows<{ record_id: string }>(
    `SELECT record_id FROM yaya_attachment_refs
      WHERE attachment_id = $1 AND record_kind = 'observation' ORDER BY record_id`,
    [manifest.media.shared_photo.attachment_id],
  );
  const expectedPhotoObs = [manifest.observations.a2_photo.id, manifest.observations.b2_photo.id].sort();
  expect(
    "媒体：同一照片被两名幼儿的两条观察各自引用",
    refRows.length === 2 && JSON.stringify(refRows.map((row) => row.record_id).sort()) === JSON.stringify(expectedPhotoObs),
    JSON.stringify(refRows),
  );
  expect(
    "媒体：两名幼儿事实不同（原文不同、幼儿不同）",
    manifest.observations.a2_photo.raw_text !== manifest.observations.b2_photo.raw_text &&
      manifest.children.class_a_shared_photo.id !== manifest.children.class_b_shared_photo.id,
  );

  /* ---------- 会话与消息投影 ---------- */
  const principalA = buildPrincipal(
    {
      id: manifest.accounts.teacher_a.account_id,
      username: manifest.accounts.teacher_a.username,
      display_name: manifest.accounts.teacher_a.display_name,
      role: "teacher",
      status: "active",
      class_ids: [
        manifest.classes.class_a.id,
        manifest.classes.class_b.id,
        manifest.classes.class_fault.id,
      ],
    },
    ACCEPTANCE_SCHOOL_ID,
  );
  const messagesView = await withTransaction((client) =>
    yayaDataRepository.listMessages(
      client,
      principalA,
      ACCEPTANCE_SCHOOL_ID,
      manifest.conversations.teacher_a_scenario.conversation_id,
    ),
  );
  const visibilityOf = (fragmentId: string): string | null => {
    for (const message of messagesView.messages) {
      const found = message.fragments.find((fragment) => fragment.fragment_id === fragmentId);
      if (found) return found.visibility;
    }
    return null;
  };
  expect(
    "消息投影：当前班来源 full、历史班来源 historical_read_only、范围外来源 hidden",
    visibilityOf("f-full") === "full" &&
      visibilityOf("f-history") === "historical_read_only" &&
      visibilityOf("f-denied") === "hidden",
    JSON.stringify({
      full: visibilityOf("f-full"),
      history: visibilityOf("f-history"),
      denied: visibilityOf("f-denied"),
    }),
  );
  const historyFragment = messagesView.messages
    .flatMap((message) => message.fragments)
    .find((fragment) => fragment.fragment_id === "f-history");
  expect(
    "消息投影：historical_read_only 不返回正文与来源标签",
    historyFragment?.text === null && historyFragment.provenance === null,
  );
  expect(
    "会话标题：来源片段受限时回退通用标题并标记 restricted",
    messagesView.conversation.projected_title === "受限会话" &&
      messagesView.conversation.title_restricted === true,
  );
  const teacherBConversation = await withTransaction((client) =>
    yayaDataRepository.getConversationSummary(
      client,
      principalA,
      ACCEPTANCE_SCHOOL_ID,
      manifest.conversations.teacher_b_private.conversation_id,
    ),
  );
  expect("账号私有：教师A 读不到教师B 的会话（不泄漏存在性）", teacherBConversation === null);
  let privateReadDenied = false;
  try {
    await withTransaction((client) =>
      yayaDataRepository.listMessages(
        client,
        principalA,
        ACCEPTANCE_SCHOOL_ID,
        manifest.conversations.teacher_b_private.conversation_id,
      ),
    );
  } catch (error) {
    privateReadDenied = error instanceof YayaDataError && error.code === "not_found";
  }
  expect("账号私有：教师A 读取教师B 会话消息按 not_found 拒绝", privateReadDenied);

  /* ---------- 故障夹具：原操作查询 / 已保存详情不可读 ---------- */
  const operationView = await withTransaction((client) =>
    yayaDataRepository.queryOperation(
      client,
      manifest.accounts.teacher_a.account_id,
      manifest.fault_fixtures.operation.operation_id,
    ),
  );
  expect(
    "故障夹具：原 operation 查询给出 saved_detail_unavailable（不冒充完整成功）",
    operationView?.outcome.kind === "saved_detail_unavailable" &&
      operationView.outcome.receipt.business_object_id === manifest.fault_fixtures.operation.business_object_id,
    JSON.stringify(operationView?.outcome ?? null),
  );
  const faultMarkers = await count(
    `SELECT count(*)::int AS n FROM observations
      WHERE id = $1 AND raw_text LIKE '%' || $2 || '%'`,
    [manifest.observations.fault_unreadable.id, FAULT_MARK],
  );
  expect("故障夹具：异常存储观察带 [故障夹具] 标记", faultMarkers === 1);

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    throw new Error(
      `种子事实回读失败 ${failed.length} 项：${failed.map((check) => `${check.label}（${check.detail}）`).join("；")}`,
    );
  }
  return { checks, passed: checks.length, failed: 0 };
}
