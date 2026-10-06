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
import { listGuideItems } from "../../../src/lib/guide/catalog";
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
import type {
  AcceptanceSeedManifest,
  AcceptanceVerification,
  SeedObservationKey,
  VerificationCheck,
} from "./types";
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

  /* ---------- 指南证据容器（正常种子）：结构 + 条目与事实语义对照 ---------- */
  const childObservationMap = async (childId: string): Promise<Map<string, EvidenceObservation>> => {
    const list = await listObservationsForChildren([childId]);
    return new Map(list.map((observation) => [observation.id, observation]));
  };
  const a1Map = await childObservationMap(manifest.children.class_a_same_name.id);
  const c1Map = await childObservationMap(manifest.children.class_c_transfer.id);
  const containerOf = (map: Map<string, EvidenceObservation>, key: SeedObservationKey) => {
    const observation = map.get(manifest.observations[key].id);
    return observation ? parseGuideEvidence(observation.guide_evidence) : { kind: "none" as const };
  };
  const a1H1 = containerOf(a1Map, "a1_h1");
  const a1H2 = containerOf(a1Map, "a1_h2");
  const a1H4 = containerOf(a1Map, "a1_h4");
  const c1New = containerOf(c1Map, "c1_new");
  expect(
    "指南：行为/持续性/保健参考/社会行为四类正常关联各 1 条",
    a1H1.kind === "ok" &&
      a1H1.links.length === 1 &&
      a1H2.kind === "ok" &&
      a1H2.links.length === 1 &&
      a1H4.kind === "ok" &&
      a1H4.links.length === 1 &&
      c1New.kind === "ok" &&
      c1New.links.length === 1,
    JSON.stringify({ h1: a1H1.kind, h2: a1H2.kind, h4: a1H4.kind, c1: c1New.kind }),
  );
  const normalContainers = [
    { key: "a1_h1" as const, childId: manifest.children.class_a_same_name.id, map: a1Map, parsed: a1H1 },
    { key: "a1_h2" as const, childId: manifest.children.class_a_same_name.id, map: a1Map, parsed: a1H2 },
    { key: "a1_h4" as const, childId: manifest.children.class_a_same_name.id, map: a1Map, parsed: a1H4 },
    { key: "c1_new" as const, childId: manifest.children.class_c_transfer.id, map: c1Map, parsed: c1New },
  ];
  expect(
    "指南：全部正常关联目录版本为当前版本",
    normalContainers.every(
      (entry) =>
        entry.parsed.kind === "ok" &&
        entry.parsed.links.every((link) => link.catalog_version === "moe-3-6-2012.v1"),
    ),
  );
  expect(
    "指南：全部正常关联依据逐条可核验（来源存在/同儿童/已确认/版本一致/片段可核对）",
    normalContainers.every(
      (entry) =>
        entry.parsed.kind === "ok" &&
        entry.parsed.links.every(
          (link) =>
            link.basis.length > 0 &&
            link.basis.every((basis) => checkBasis(basis, entry.childId, entry.map).valid),
        ),
    ),
  );
  // 条目与事实对照：条目文字、依据片段、原始事实必须指向同一语义关键词（不引入 LLM 评价）
  const guideItemsById = new Map((await listGuideItems()).map((item) => [item.id, item]));
  const semanticCases = [
    {
      label: "行为类（坐直站直）",
      item_id: manifest.guide_items.behavior_item_id,
      containerKey: "a1_h1" as const,
      phrase: "坐直、站直",
      keyword: "坐直",
      basisCount: 1,
    },
    {
      label: "持续性（情绪稳定）",
      item_id: manifest.guide_items.sustained_item_id,
      containerKey: "a1_h2" as const,
      phrase: "情绪比较稳定",
      keyword: "情绪",
      basisCount: 2,
    },
    {
      label: "保健参考（身高体重）",
      item_id: manifest.guide_items.health_reference_item_id,
      containerKey: "a1_h4" as const,
      phrase: "身高和体重适宜",
      keyword: "身高",
      basisCount: 1,
    },
    {
      label: "社会行为（愿意和同伴游戏）",
      item_id: manifest.guide_items.social_behavior_item_id,
      containerKey: "c1_new" as const,
      phrase: "愿意和小朋友一起游戏",
      keyword: "小朋友",
      basisCount: 1,
    },
  ];
  const rawTextById = new Map(
    Object.values(manifest.observations).map((observation) => [observation.id, observation.raw_text]),
  );
  for (const entry of semanticCases) {
    const item = guideItemsById.get(entry.item_id);
    const parsed = containerOf(entry.containerKey === "c1_new" ? c1Map : a1Map, entry.containerKey);
    const link = parsed.kind === "ok" ? parsed.links[0] : undefined;
    const itemText = item?.text ?? "";
    const basis = link?.basis ?? [];
    expect(
      `指南对照：${entry.label} 条目文字包含「${entry.phrase}」`,
      itemText.includes(entry.phrase),
      itemText,
    );
    expect(
      `指南对照：${entry.label} 关联条目 id 与声明一致`,
      link?.item_id === entry.item_id,
      String(link?.item_id),
    );
    expect(
      `指南对照：${entry.label} 依据 ${entry.basisCount} 条且片段与条目语义关键词一致`,
      basis.length === entry.basisCount &&
        basis.every((entryBasis) => entryBasis.quote.includes(entry.keyword)) &&
        basis.every((entryBasis) => rawTextById.get(entryBasis.observation_id)?.includes(entryBasis.quote) === true),
      JSON.stringify(basis.map((entryBasis) => entryBasis.quote)),
    );
  }
  const sustainedNote = a1H2.kind === "ok" ? a1H2.links[0]?.sustained_note : null;
  expect(
    "指南对照：持续性纪要覆盖两日依据且描述情绪稳定",
    sustainedNote !== null &&
      sustainedNote.description.includes("情绪") &&
      sustainedNote.period_start <= manifest.observations.a1_h2.observed_at &&
      sustainedNote.period_end >= manifest.observations.a1_h3.observed_at,
    JSON.stringify(sustainedNote ?? null),
  );

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
  const transferBook = await loadChildEvidenceBook(manifest.children.class_c_transfer.id, {
    scope: "current_semester",
  });
  expect("读模型：郑小舟（云杉班）证据册可读取", transferBook.ok === true);
  if (transferBook.ok) {
    const social = flattenChildItems(transferBook.value).get(manifest.guide_items.social_behavior_item_id);
    expect(
      "读模型：社会行为条目为 confirmed_observed 且 reliable",
      social?.status === "confirmed_observed" && social.reliability === "reliable",
      JSON.stringify({ status: social?.status, reliability: social?.reliability }),
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
