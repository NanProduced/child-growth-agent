/**
 * YAYA-CORE-INTEGRATE1 联合验收（媒体/数据/代理上下文）：
 * 一次性隔离 PostgreSQL + 真实 sharp 处理 + 自有本地对象存储 + DATA1 正式适配器。
 *
 * 分层：
 * - 服务层反例（点 6）：进程内元数据替身 + 本地对象 I/O（未知结果重试身份绑定）；
 * - 真实 repository：DATA1 附件 repository 经 data-adapter（短事务 + 绑定事务）消费；
 * - Agent 上下文：真实观察/授权事实 + 进程内模型替身；
 * - 真实 provider/搜索/S3/托管库 NOT_RUN；本进程出口经模型守门计数。
 *
 * 运行：pnpm exec tsx scripts/yaya/check-integration-media-db.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import sharp from "sharp";
import { z } from "zod";

import { authorizeAction } from "../../src/lib/accounts/authorize";
import type { Principal } from "../../src/lib/accounts/types";
import {
  runYayaAgent,
  zodToolParams,
  type YayaAgentDependencies,
} from "../../src/lib/yaya/agent";
import {
  bindDataAttachmentMetadataPort,
  createDataAttachmentMetadataPort,
} from "../../src/lib/media/data-adapter";
import { MediaError } from "../../src/lib/media/errors";
import { MemoryAttachmentMetadata } from "../../src/lib/media/metadata-memory";
import { LocalMediaObjectStore } from "../../src/lib/media/object-store-local";
import { sha256Hex } from "../../src/lib/media/object-store";
import { recycleAttachment } from "../../src/lib/media/retention-service";
import {
  bindMediaRuntime,
  mediaRuntimeOrThrow,
  type MediaServiceDeps,
} from "../../src/lib/media/runtime";
import { contentAttachmentId, uploadImages } from "../../src/lib/media/upload-service";
import type { UploadAttachmentView, UploadFileResult } from "../../src/lib/media/upload-service";
import { getChild, getObservation } from "../../src/lib/queries";
import { yayaDataRepository } from "../../src/lib/yaya/data";
import type { YayaSourceRef } from "../../src/lib/yaya/types";
import type { TransactionClient } from "../../src/storage/database/pg-client";
import {
  assertCleanupComplete,
  runCleanupSteps,
  startIsolatedPostgres,
  startModelRequestGuard,
  type IsolatedPostgres,
} from "../harness-safety";

const RUN = `int-media-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const LABEL_KEY = "yaya.integrate1.media";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PRIVATE_MARKER = "PRIVATE_CHILD_FACT_MARKER_INTEGRATE1";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
const failures: string[] = [];
function check(label: string, condition: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`ok - ${label}`);
  } else {
    failures.push(label);
    console.error(`FAIL - ${label}`);
  }
}
function stage(label: string): void {
  console.error(`[stage] ${label}`);
}
function errorCode(error: unknown): string | null {
  if (error instanceof MediaError) return error.code;
  if (error !== null && typeof error === "object" && "code" in error) {
    return String((error as { code: unknown }).code);
  }
  return null;
}

async function expectMediaCode(
  run: () => Promise<unknown>,
  code: string,
  label: string,
): Promise<void> {
  let caught: unknown = null;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  check(label, errorCode(caught) === code);
}

async function withRawTransaction<T>(
  client: RawQueryable,
  fn: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await fn(client as unknown as TransactionClient);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

interface RawQueryable {
  query: Client["query"];
}

type PoolClient = Awaited<ReturnType<Pool["connect"]>>;

function requireUploaded(
  result: UploadFileResult | undefined,
  label: string,
): UploadAttachmentView {
  if (result === undefined || !result.ok) {
    throw new Error(`${label}: 上传失败（${result !== undefined && !result.ok ? result.code : "missing"}）`);
  }
  return result.attachment;
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full);
    }
  }
  await walk(dir);
  return out.sort();
}

function pngBuffer(width = 64, height = 48): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
}

function principalOf(accountId: string, classIds: readonly string[]): Principal {
  return {
    account_id: accountId,
    username: `teacher-${accountId.slice(0, 8)}`,
    display_name: "教师A",
    role: "teacher",
    account_status: "active",
    scope: { kind: "classes", class_ids: [...classIds] },
  };
}

async function main(): Promise<void> {
  const guard = await startModelRequestGuard();
  const cleanupIssues: string[] = [];
  let isolated: IsolatedPostgres | null = null;
  let database: Client | null = null;
  let pool: Pool | null = null;
  const tempRoots: string[] = [];

  try {
    isolated = await startIsolatedPostgres({
      runId: RUN,
      containerName: `yaya-int-media-${RUN}`,
      dbName: "yaya_integrate1",
      labelKey: LABEL_KEY,
    });
    const url = isolated.url;
    database = new Client({ connectionString: url });
    await database.connect();
    await database.query("SET TIME ZONE 'UTC'");
    stage("container-ready");

    // 基线与 yaya 迁移（与 DATA1 实库检查同一装置）
    await database.query(fs.readFileSync(path.join(ROOT, "scripts/initialize-demo-db.sql"), "utf8"));
    await database.query(fs.readFileSync(path.join(ROOT, "scripts/upgrade-auth-v1.sql"), "utf8"));
    await database.query(fs.readFileSync(path.join(ROOT, "scripts/upgrade-yaya-v1.sql"), "utf8"));
    stage("migrated");

    process.env.DATABASE_URL = url;

    const teacherAId = randomUUID();
    const teacherBId = randomUUID();
    const classA = randomUUID();
    const classB = randomUUID();
    const childA = randomUUID();
    const observationId = randomUUID();
    for (const [id, name] of [
      [teacherAId, "integrate1-teacher-a"],
      [teacherBId, "integrate1-teacher-b"],
    ] as const) {
      await database.query(
        "INSERT INTO app_accounts (id, username, display_name, password_hash, role, status) VALUES ($1,$2,$2,'test-never-logged-in','teacher','active')",
        [id, name],
      );
    }
    for (const [id, name] of [
      [classA, "整合班A"],
      [classB, "整合班B"],
    ] as const) {
      await database.query(
        `INSERT INTO classes (id, name, stage, school_year, is_active) VALUES ($1,$2,'middle','2026','true')`,
        [id, name],
      );
    }
    await database.query(
      "INSERT INTO children (id, name, gender, birth_date, class_name) VALUES ($1,'整合幼儿','女','2022-06-01','整合班A')",
      [childA],
    );
    await database.query(
      "INSERT INTO child_class_enrollments (child_id, class_id, start_date) VALUES ($1,$2,'2026-01-01')",
      [childA, classA],
    );
    await database.query(
      `INSERT INTO observations (id, child_id, class_id, observed_at, raw_text, status)
       VALUES ($1,$2,$3,'2026-06-01',$4,'ai_organized')`,
      [observationId, childA, classA, `幼儿把积木按颜色分类。${PRIVATE_MARKER}`],
    );
    const principalA = principalOf(teacherAId, [classA]);
    stage("seeded");

    /* ============================ D. 运行绑定 fail closed ============================ */
    const savedEnv = {
      MEDIA_ENVIRONMENT: process.env.MEDIA_ENVIRONMENT,
      MEDIA_STORAGE_MODE: process.env.MEDIA_STORAGE_MODE,
      MEDIA_LOCAL_ROOT: process.env.MEDIA_LOCAL_ROOT,
    };
    delete process.env.MEDIA_ENVIRONMENT;
    delete process.env.MEDIA_STORAGE_MODE;
    delete process.env.MEDIA_LOCAL_ROOT;
    bindMediaRuntime(null);
    await expectMediaCode(
      async () => mediaRuntimeOrThrow(),
      "media_unavailable",
      "D 未配置存储时运行绑定 fail closed",
    );

    const storeRoot = await mkdtemp(path.join(os.tmpdir(), "yaya-int-media-store-"));
    tempRoots.push(storeRoot);
    process.env.MEDIA_ENVIRONMENT = "development";
    process.env.MEDIA_STORAGE_MODE = "local";
    process.env.MEDIA_LOCAL_ROOT = storeRoot;
    const runtime = mediaRuntimeOrThrow();
    check(
      "D 真实装配按环境构造 DATA 适配器 + 本地对象存储",
      runtime.environment === "development" &&
        typeof runtime.metadata.registerAttachment === "function" &&
        runtime.store instanceof LocalMediaObjectStore,
    );
    check("D 未回退内存 repository", !(runtime.metadata instanceof MemoryAttachmentMetadata));
    bindMediaRuntime(null);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    /* ============================ 点 6：回收后重传身份绑定（服务层反例） ============================ */
    const probeRoot = await mkdtemp(path.join(os.tmpdir(), "yaya-int-media-probe-"));
    tempRoots.push(probeRoot);
    const memory = new MemoryAttachmentMetadata();
    const probeStore = new LocalMediaObjectStore(probeRoot);
    const probeDeps: MediaServiceDeps = {
      metadata: memory,
      store: probeStore,
      environment: "development",
    };
    const recyclable = await pngBuffer(80, 60);
    const firstUpload = await uploadImages(probeDeps, {
      owner_account_id: teacherAId,
      files: [
        { filename: "a.png", declared_content_type: null, body: recyclable, client_upload_id: null },
      ],
    });
    const first = firstUpload.uploads[0];
    assert.ok(first && first.ok);
    const contentId = contentAttachmentId(teacherAId, sha256Hex(recyclable));
    check("点6 无键上传按内容派生身份", first.attachment.attachment_id === contentId);
    const recycled = await recycleAttachment(probeDeps, {
      attachment_id: contentId,
      actor_account_id: teacherAId,
    });
    check("点6 前置：内容身份可回收", recycled.status === "deleted");

    memory.failNext("register_late_commit");
    const lostUpload = await uploadImages(probeDeps, {
      owner_account_id: teacherAId,
      files: [
        { filename: "a.png", declared_content_type: null, body: recyclable, client_upload_id: null },
      ],
    });
    const lost = lostUpload.uploads[0];
    assert.ok(lost && !lost.ok && lost.code === "upload_unknown");
    const recoverableId = lost.recoverable?.attachment_id ?? "";
    check(
      "点6 回收后重传：未知结果保留确定性回退身份",
      recoverableId.length > 0 && recoverableId !== contentId,
    );
    await memory.settleLateCommit();
    const objectsBeforeRetry = (await listFiles(probeRoot)).length;
    const recordsBeforeRetry = memory.countAttachments();
    const retry = await uploadImages(probeDeps, {
      owner_account_id: teacherAId,
      files: [
        { filename: "a.png", declared_content_type: null, body: recyclable, client_upload_id: null },
      ],
    });
    const retried = retry.uploads[0];
    check(
      "点6 未知结果重试绑定同一身份（不产生新对象/新记录）",
      retried !== undefined &&
        retried.ok &&
        retried.attachment.attachment_id === recoverableId &&
        (await listFiles(probeRoot)).length === objectsBeforeRetry &&
        memory.countAttachments() === recordsBeforeRetry,
    );
    const retryAgain = await uploadImages(probeDeps, {
      owner_account_id: teacherAId,
      files: [
        { filename: "a.png", declared_content_type: null, body: recyclable, client_upload_id: null },
      ],
    });
    check(
      "点6 再次重试仍为同一身份",
      retryAgain.uploads[0]?.ok === true &&
        retryAgain.uploads[0]?.attachment.attachment_id === recoverableId,
    );

    /* ============================ A. 真实 repository：字段与上传 ============================ */
    pool = new Pool({ connectionString: url, max: 5 });
    const store = new LocalMediaObjectStore(storeRoot);
    const metadata = createDataAttachmentMetadataPort(() => pool!.connect());
    const deps: MediaServiceDeps = { metadata, store, environment: "development" };

    const rawPng = await pngBuffer(96, 72);
    const upload = await uploadImages(deps, {
      owner_account_id: teacherAId,
      files: [
        { filename: "real.png", declared_content_type: "image/png", body: rawPng, client_upload_id: null },
      ],
    });
    const uploaded = upload.uploads[0];
    assert.ok(uploaded && uploaded.ok);
    const attachmentId = uploaded.attachment.attachment_id;
    const record = await metadata.get(attachmentId);
    assert.ok(record !== null);
    check("A 原始字节 source_checksum 真实持久化并回传", record.source_checksum === sha256Hex(rawPng));
    check(
      "A 处理后对象 checksum 与原始字节 checksum 区分",
      record.checksum_sha256 !== record.source_checksum &&
        record.thumbnail_checksum.length === 64 &&
        record.model_checksum.length === 64,
    );
    const row = await database.query<{
      source_checksum: string | null;
      checksum_sha256: string;
      object_key: string;
      thumbnail_key: string;
      model_key: string;
      width: number;
      height: number;
      media_type: string;
      status: string;
      revision: number;
    }>(
      "SELECT source_checksum, checksum_sha256, object_key, thumbnail_key, model_key, width, height, media_type, status, revision FROM yaya_attachments WHERE id = $1",
      [attachmentId],
    );
    const dbRow = row.rows[0];
    check(
      "A 显式列完整：source_checksum/三 key 与记录往返一致",
      dbRow !== undefined &&
        dbRow.source_checksum === sha256Hex(rawPng) &&
        dbRow.object_key === record.object_key &&
        dbRow.thumbnail_key === record.thumbnail_key &&
        dbRow.model_key === record.model_key,
    );
    check(
      "A 尺寸/类型/ready/revision 显式往返",
      dbRow !== undefined &&
        dbRow.width === record.width &&
        dbRow.height === record.height &&
        dbRow.media_type === record.content_type &&
        dbRow.status === "ready" &&
        dbRow.revision === record.revision &&
        record.revision >= 1,
    );
    const originalStored = await store.get(record.object_key);
    const thumbnailStored = await store.get(record.thumbnail_key);
    const modelStored = await store.get(record.model_key);
    check(
      "A 三个派生对象真实落地且 checksum 匹配磁盘内容",
      (await listFiles(storeRoot)).length === 3 &&
        originalStored !== null &&
        thumbnailStored !== null &&
        modelStored !== null &&
        originalStored.body.length === record.byte_size &&
        sha256Hex(originalStored.body) === record.checksum_sha256 &&
        sha256Hex(thumbnailStored.body) === record.thumbnail_checksum &&
        sha256Hex(modelStored.body) === record.model_checksum,
    );
    const uploadViewJson = JSON.stringify(uploaded.attachment);
    check(
      "A 上传响应不含对象 key/签名 URL",
      !uploadViewJson.includes("object_key") &&
        !uploadViewJson.includes(record.object_key) &&
        !uploadViewJson.includes("http"),
    );

    const keyedFirst = await uploadImages(deps, {
      owner_account_id: teacherAId,
      files: [
        { filename: "k.png", declared_content_type: null, body: rawPng, client_upload_id: "integ-key-1" },
      ],
    });
    assert.ok(keyedFirst.uploads[0]?.ok);
    const keyedId = requireUploaded(keyedFirst.uploads[0], "keyedFirst").attachment_id;
    const filesBeforeKeyedRetry = (await listFiles(storeRoot)).length;
    const keyedAgain = await uploadImages(deps, {
      owner_account_id: teacherAId,
      files: [
        { filename: "k.png", declared_content_type: null, body: rawPng, client_upload_id: "integ-key-1" },
      ],
    });
    check(
      "A 同键同内容恢复原附件且不重复写对象",
      keyedAgain.uploads[0]?.ok === true &&
        keyedAgain.uploads[0]?.attachment.attachment_id === keyedId &&
        (await listFiles(storeRoot)).length === filesBeforeKeyedRetry,
    );
    const different = await pngBuffer(50, 50);
    const differentResult = await uploadImages(deps, {
      owner_account_id: teacherAId,
      files: [
        {
          filename: "k.png",
          declared_content_type: null,
          body: different,
          client_upload_id: "integ-key-1",
        },
      ],
    });
    check(
      "A 同键异内容明确冲突",
      differentResult.uploads[0]?.ok === false && differentResult.uploads[0]?.code === "idempotency_conflict",
    );
    const noKeyAgain = await uploadImages(deps, {
      owner_account_id: teacherAId,
      files: [{ filename: "real.png", declared_content_type: null, body: rawPng, client_upload_id: null }],
    });
    check(
      "A 无键同内容恢复同一附件",
      noKeyAgain.uploads[0]?.ok === true &&
        noKeyAgain.uploads[0]?.attachment.attachment_id === attachmentId,
    );

    // pending 不可当 ready：直接插入 pending 行，媒体端口必须按不可核验拒绝
    const pendingProbeId = randomUUID();
    await withRawTransaction(pool, (tx) =>
      yayaDataRepository.insertPendingAttachment(tx, {
        attachment_id: pendingProbeId,
        owner_account_id: teacherAId,
        status: "pending",
        revision: 0,
        object_key: `${RUN}/pending-original`,
        thumbnail_key: `${RUN}/pending-thumb`,
        model_key: `${RUN}/pending-model`,
        content_type: "image/png",
        byte_size: 10,
        checksum_sha256: "1".repeat(64),
        thumbnail_checksum: "2".repeat(64),
        model_checksum: "3".repeat(64),
        source_checksum: "4".repeat(64),
        width: 10,
        height: 10,
        client_upload_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deleting_started_at: null,
        deleted_at: null,
        deletion_lease_id: null,
      }),
    );
    const pendingRecord = await metadata.get(pendingProbeId);
    check("A pending 记录可见且不是 ready", pendingRecord !== null && pendingRecord.status === "pending");
    await expectMediaCode(
      async () =>
        metadata.linkObservationReferences({
          observation_id: observationId,
          attachment_ids: [pendingProbeId],
          actor_account_id: teacherAId,
        }),
      "attachment_gone",
      "A pending 不得新增引用",
    );
    const pendingHostId = randomUUID();
    const pendingHostConfirmedAt = "2026-06-02T00:00:00.000Z";
    await database.query(
      `INSERT INTO observations (id, child_id, class_id, observed_at, raw_text, status, confirmed_at)
       VALUES ($1,$2,$3,'2026-06-02','pending 追加宿主。','confirmed',$4)`,
      [pendingHostId, childA, classA, pendingHostConfirmedAt],
    );
    await expectMediaCode(
      async () =>
        metadata.appendObservationAttachments({
          observation_id: pendingHostId,
          attachment_ids: [pendingProbeId],
          expected_attachment_revision: 0,
          actor_account_id: teacherAId,
          source_confirmed_at: pendingHostConfirmedAt,
          request_id: null,
          approval_id: null,
        }),
      "attachment_gone",
      "A pending 不得追加",
    );
    const noSourceId = randomUUID();
    await database.query(
      `INSERT INTO yaya_attachments
         (id, uploader_account_id, object_key, thumbnail_key, model_key, media_type, byte_size,
          checksum_sha256, thumbnail_checksum, model_checksum, source_checksum, width, height,
          source_kind, status)
       VALUES ($1,$2,$3,$4,$5,'image/png',10,$6,$7,$8,NULL,10,10,'raw_input','ready')`,
      [
        noSourceId,
        teacherAId,
        `${RUN}/nosrc-original`,
        `${RUN}/nosrc-thumb`,
        `${RUN}/nosrc-model`,
        "5".repeat(64),
        "6".repeat(64),
        "7".repeat(64),
      ],
    );
    await expectMediaCode(
      async () => metadata.get(noSourceId),
      "metadata_unavailable",
      "A 缺 source_checksum 的既有行保留不可核验语义",
    );

    // 响应丢失 / 读回失败：注册异常不等于未提交，主键读回核对
    const lostBody = await pngBuffer(70, 70);
    const lostWriteDeps: MediaServiceDeps = {
      metadata: {
        ...metadata,
        registerAttachment: async (input) => {
          await metadata.registerAttachment(input);
          throw new MediaError("metadata_unavailable", "登记已提交，但响应丢失。");
        },
      },
      store,
      environment: "development",
    };
    const lostResult = await uploadImages(lostWriteDeps, {
      owner_account_id: teacherAId,
      files: [{ filename: "lost.png", declared_content_type: null, body: lostBody, client_upload_id: null }],
    });
    check("A 注册已提交但响应丢失：按原身份读回恢复", lostResult.uploads[0]?.ok === true);

    let getCalls = 0;
    const lostRecoverableDeps: MediaServiceDeps = {
      metadata: {
        ...metadata,
        get: async (id) => {
          getCalls += 1;
          if (getCalls === 2) throw new MediaError("metadata_unavailable", "读回失败");
          return metadata.get(id);
        },
        registerAttachment: async () => {
          throw new MediaError("metadata_unavailable", "登记结果未知。");
        },
      },
      store,
      environment: "development",
    };
    const lostUnknown = await uploadImages(lostRecoverableDeps, {
      owner_account_id: teacherAId,
      files: [
        { filename: "lost2.png", declared_content_type: null, body: different, client_upload_id: null },
      ],
    });
    const unknownEntry = lostUnknown.uploads[0];
    check(
      "A 读回也失败：保留对象与可恢复身份，不假成功",
      unknownEntry !== undefined &&
        !unknownEntry.ok &&
        unknownEntry.code === "upload_unknown" &&
        typeof unknownEntry.recoverable?.attachment_id === "string",
    );
    const unknownId =
      unknownEntry !== undefined && !unknownEntry.ok
        ? (unknownEntry.recoverable?.attachment_id ?? "")
        : "";
    const recover = await uploadImages(deps, {
      owner_account_id: teacherAId,
      files: [
        { filename: "lost2.png", declared_content_type: null, body: different, client_upload_id: null },
      ],
    });
    check(
      "A 未知结果重试按原身份完成写入",
      recover.uploads[0]?.ok === true && recover.uploads[0]?.attachment.attachment_id === unknownId,
    );

    // 登记原子性：重复主键/键冲突不留下 pending
    const atomicId = randomUUID();
    const atomicInput = {
      attachment_id: atomicId,
      owner_account_id: teacherAId,
      object_key: `${RUN}/atomic-original`,
      thumbnail_key: `${RUN}/atomic-thumb`,
      model_key: `${RUN}/atomic-model`,
      content_type: "image/png" as const,
      byte_size: 10,
      checksum_sha256: "a".repeat(64),
      thumbnail_checksum: "b".repeat(64),
      model_checksum: "c".repeat(64),
      source_checksum: "d".repeat(64),
      width: 10,
      height: 10,
      client_upload_id: "integ-atomic",
    };
    await metadata.registerAttachment(atomicInput);
    await expectMediaCode(
      async () => metadata.registerAttachment(atomicInput),
      "idempotency_conflict",
      "A 重复登记明确冲突",
    );
    const pendingLeft = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM yaya_attachments WHERE status = 'pending' AND id = $1",
      [atomicId],
    );
    check("A 冲突登记不留下 pending 中间态", pendingLeft.rows[0]?.count === "0");
    stage("a-done");

    /* ============================ B. 删除租约 ============================ */
    const leaseBody = await pngBuffer(60, 60);
    const leased = await uploadImages(deps, {
      owner_account_id: teacherAId,
      files: [{ filename: "lease.png", declared_content_type: null, body: leaseBody, client_upload_id: null }],
    });
    const leasedId = requireUploaded(leased.uploads[0], "leased").attachment_id;
    const leasedRecord = await metadata.get(leasedId);
    assert.ok(leasedRecord !== null);

    await expectMediaCode(
      async () =>
        metadata.beginDeletionLease({
          attachment_id: leasedId,
          expected_revision: -1,
          actor_account_id: teacherAId,
        }),
      "invalid_request",
      "B 非法版本前提直接拒绝",
    );
    const staleLease = await metadata.beginDeletionLease({
      attachment_id: leasedId,
      expected_revision: leasedRecord.revision + 3,
      actor_account_id: teacherAId,
    });
    check("B 版本冲突单独表达", staleLease.outcome === "revision_conflict");
    await expectMediaCode(
      async () =>
        metadata.beginDeletionLease({
          attachment_id: leasedId,
          expected_revision: leasedRecord.revision,
          actor_account_id: teacherBId,
        }),
      "not_owner",
      "B 非上传者不能取得回收租约",
    );
    await expectMediaCode(
      async () =>
        metadata.beginDeletionLease({
          attachment_id: leasedId,
          expected_revision: leasedRecord.revision,
        }),
      "invalid_request",
      "B 缺少可信操作者身份 fail closed（不用上传者冒充）",
    );

    const refTargetId = randomUUID();
    await withRawTransaction(pool, async (tx) => {
      await tx.query(
        `INSERT INTO observations (id, child_id, class_id, observed_at, raw_text, status)
         VALUES ($1,$2,$3,'2026-06-02','引用保护夹具。','ai_organized')`,
        [refTargetId, childA, classA],
      );
      const bound = bindDataAttachmentMetadataPort(tx);
      await bound.linkObservationReferences({
        observation_id: refTargetId,
        attachment_ids: [leasedId],
        actor_account_id: teacherAId,
      });
    });
    const referencedRecycle = await recycleAttachment(deps, {
      attachment_id: leasedId,
      actor_account_id: teacherAId,
    });
    check("B 已引用照片不能回收", referencedRecycle.status === "referenced");
    const referencedLease = await metadata.beginDeletionLease({
      attachment_id: leasedId,
      expected_revision: leasedRecord.revision,
      actor_account_id: teacherAId,
    });
    check("B 租约核引用单独表达 referenced", referencedLease.outcome === "referenced");
    const statusStillReady = await database.query<{ status: string }>(
      "SELECT status FROM yaya_attachments WHERE id = $1",
      [leasedId],
    );
    check("B 有引用附件保持 ready", statusStillReady.rows[0]?.status === "ready");

    const danglingId = randomUUID();
    await database.query(
      `INSERT INTO yaya_attachments
         (id, uploader_account_id, object_key, thumbnail_key, model_key, media_type, byte_size,
          checksum_sha256, thumbnail_checksum, model_checksum, source_checksum, width, height,
          source_kind, status)
       VALUES ($1,$2,$3,$4,$5,'image/png',10,$6,$7,$8,$9,10,10,'raw_input','ready')`,
      [
        danglingId,
        teacherAId,
        `${RUN}/dangling-original`,
        `${RUN}/dangling-thumb`,
        `${RUN}/dangling-model`,
        "1".repeat(64),
        "2".repeat(64),
        "3".repeat(64),
        "4".repeat(64),
      ],
    );
    await database.query(
      `INSERT INTO yaya_attachment_refs (attachment_id, record_kind, record_id, linked_by_account_id)
       VALUES ($1, 'observation', $2, $3)`,
      [danglingId, randomUUID(), teacherAId],
    );
    const danglingLease = await metadata.beginDeletionLease({
      attachment_id: danglingId,
      expected_revision: 1,
      actor_account_id: teacherAId,
    });
    check("B 引用查询不完整单独表达", danglingLease.outcome === "reference_incomplete");
    await expectMediaCode(
      async () => recycleAttachment(deps, { attachment_id: danglingId, actor_account_id: teacherAId }),
      "reference_query_incomplete",
      "B 悬空引用禁止回收（服务层保守拒绝）",
    );

    const recyclableUpload = await uploadImages(deps, {
      owner_account_id: teacherAId,
      files: [
        { filename: "r.png", declared_content_type: null, body: await pngBuffer(40, 40), client_upload_id: null },
      ],
    });
    const recyclableId = requireUploaded(recyclableUpload.uploads[0], "recyclableUpload").attachment_id;
    const recyclableRecord = await metadata.get(recyclableId);
    assert.ok(recyclableRecord !== null);
    const recycleOk = await recycleAttachment(deps, {
      attachment_id: recyclableId,
      actor_account_id: teacherAId,
    });
    check(
      "B 无引用回收：删除三个对象并落 deleted",
      recycleOk.status === "deleted" &&
        recycleOk.objects.every((entry) => entry.outcome === "deleted") &&
        (await store.get(recyclableRecord.object_key)) === null,
    );
    const deletedAfter = await metadata.get(recyclableId);
    const deletedLease = deletedAfter
      ? await metadata.beginDeletionLease({
          attachment_id: recyclableId,
          expected_revision: deletedAfter.revision,
          actor_account_id: teacherAId,
        })
      : null;
    check(
      "B 已删除单独表达且不可再取租约",
      deletedAfter?.status === "deleted" &&
        deletedLease?.outcome === "not_ready" &&
        deletedLease.status === "deleted",
    );

    const unknownDeleteUpload = await uploadImages(deps, {
      owner_account_id: teacherAId,
      files: [
        { filename: "u.png", declared_content_type: null, body: await pngBuffer(41, 41), client_upload_id: null },
      ],
    });
    const unknownDeleteId = requireUploaded(unknownDeleteUpload.uploads[0], "unknownDeleteUpload").attachment_id;
    const unknownStore: MediaServiceDeps["store"] = {
      putOnce: (input) => store.putOnce(input),
      get: (key) => store.get(key),
      delete: async () => "unknown" as const,
    };
    const unknownDelete = await recycleAttachment(
      { metadata, store: unknownStore, environment: "development" },
      { attachment_id: unknownDeleteId, actor_account_id: teacherAId },
    );
    const unknownRow = await database.query<{ status: string; delete_result: string | null }>(
      "SELECT status, delete_result FROM yaya_attachments WHERE id = $1",
      [unknownDeleteId],
    );
    check(
      "B 删除未知保留 deleting+unknown，不恢复 ready",
      unknownDelete.status === "deletion_unknown" &&
        unknownRow.rows[0]?.status === "deleting" &&
        unknownRow.rows[0]?.delete_result === "unknown",
    );
    const retryDelete = await recycleAttachment(deps, {
      attachment_id: unknownDeleteId,
      actor_account_id: teacherAId,
    });
    check("B 未知删除可核验重试并落 deleted", retryDelete.status === "deleted");

    // 受控双连接交错 1：引用先成立（未提交）→ 租约在附件锁上等待 → 提交后被拒
    const interleaveA = await uploadImages(deps, {
      owner_account_id: teacherAId,
      files: [
        { filename: "i1.png", declared_content_type: null, body: await pngBuffer(42, 42), client_upload_id: null },
      ],
    });
    const interleaveAId = requireUploaded(interleaveA.uploads[0], "interleaveA").attachment_id;
    const interleaveRecord = await metadata.get(interleaveAId);
    assert.ok(interleaveRecord !== null);
    const writer1 = await pool.connect();
    let leaseSettledWhileLocked = false;
    await withRawTransaction(writer1, async (tx) => {
      const bound = bindDataAttachmentMetadataPort(tx);
      await bound.linkObservationReferences({
        observation_id: refTargetId,
        attachment_ids: [interleaveAId],
        actor_account_id: teacherAId,
      });
      const leaseAttempt = metadata
        .beginDeletionLease({
          attachment_id: interleaveAId,
          expected_revision: interleaveRecord.revision,
          actor_account_id: teacherAId,
        })
        .catch(() => null);
      await sleep(200);
      let settled = false;
      void leaseAttempt.then(() => {
        settled = true;
      });
      await sleep(150);
      leaseSettledWhileLocked = settled;
      return undefined;
    });
    await writer1.release();
    check("B 引用先成立：租约在附件锁上等待", leaseSettledWhileLocked === false);
    const leaseAfterRef = await metadata.beginDeletionLease({
      attachment_id: interleaveAId,
      expected_revision: interleaveRecord.revision,
      actor_account_id: teacherAId,
    });
    check("B 引用先成立：租约最终被引用拒绝", leaseAfterRef.outcome === "referenced");

    // 受控双连接交错 2：租约先成立（未提交）→ 新引用等待 → 提交后被拒
    const interleaveB = await uploadImages(deps, {
      owner_account_id: teacherAId,
      files: [
        { filename: "i2.png", declared_content_type: null, body: await pngBuffer(43, 43), client_upload_id: null },
      ],
    });
    const interleaveBId = requireUploaded(interleaveB.uploads[0], "interleaveB").attachment_id;
    const interleaveBRecord = await metadata.get(interleaveBId);
    assert.ok(interleaveBRecord !== null);
    const holder2 = await pool.connect();
    await holder2.query("BEGIN");
    const boundHolder = bindDataAttachmentMetadataPort(holder2 as unknown as TransactionClient);
    const heldLease = await boundHolder.beginDeletionLease({
      attachment_id: interleaveBId,
      expected_revision: interleaveBRecord.revision,
      actor_account_id: teacherAId,
    });
    check("B 租约先成立：acquired", heldLease.outcome === "acquired");
    const blockedRef = metadata
      .linkObservationReferences({
        observation_id: refTargetId,
        attachment_ids: [interleaveBId],
        actor_account_id: teacherAId,
      })
      .then(
        () => ({ state: "resolved" as const }),
        (error: unknown) => ({ state: "rejected" as const, code: errorCode(error) }),
      );
    await sleep(250);
    await holder2.query("COMMIT");
    await holder2.release();
    const blockedResult = await blockedRef;
    check(
      "B 租约先成立：新引用等待后被拒（attachment_deleting）",
      blockedResult.state === "rejected" && blockedResult.code === "attachment_deleting",
    );
    stage("b-done");

    /* ============================ C. 创建关联与归档追加 ============================ */
    const createAtt = await uploadImages(deps, {
      owner_account_id: teacherAId,
      files: [
        { filename: "c.png", declared_content_type: null, body: await pngBuffer(44, 44), client_upload_id: null },
      ],
    });
    const createAttId = requireUploaded(createAtt.uploads[0], "createAtt").attachment_id;
    const createObsId = randomUUID();
    const createClient = await pool.connect();
    await withRawTransaction(createClient, async (tx) => {
      await tx.query(
        `INSERT INTO observations (id, child_id, class_id, observed_at, raw_text, status)
         VALUES ($1,$2,$3,'2026-06-03','创建观察附图夹具。','ai_organized')`,
        [createObsId, childA, classA],
      );
      const bound = bindDataAttachmentMetadataPort(tx);
      await bound.linkObservationReferences({
        observation_id: createObsId,
        attachment_ids: [createAttId],
        actor_account_id: teacherAId,
      });
    });
    await createClient.release();
    const createRefs = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM yaya_attachment_refs WHERE record_kind = 'observation' AND record_id = $1",
      [createObsId],
    );
    const createRevision = await metadata.getObservationAttachmentRevision(createObsId);
    const createAudits = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM yaya_attachment_appends WHERE observation_id = $1",
      [createObsId],
    );
    check(
      "C 创建关联随创建事务：引用写入、不递增追加修订、不写追加审计",
      createRefs.rows[0]?.count === "1" && createRevision === 0 && createAudits.rows[0]?.count === "0",
    );

    const rollbackObsId = randomUUID();
    const rollbackAtt = await uploadImages(deps, {
      owner_account_id: teacherAId,
      files: [
        { filename: "cr.png", declared_content_type: null, body: await pngBuffer(45, 45), client_upload_id: null },
      ],
    });
    const rollbackAttId = requireUploaded(rollbackAtt.uploads[0], "rollbackAtt").attachment_id;
    const rollbackClient = await pool.connect();
    let rollbackThrew = false;
    try {
      await withRawTransaction(rollbackClient, async (tx) => {
        await tx.query(
          `INSERT INTO observations (id, child_id, class_id, observed_at, raw_text, status)
           VALUES ($1,$2,$3,'2026-06-03','回滚夹具。','ai_organized')`,
          [rollbackObsId, childA, classA],
        );
        const bound = bindDataAttachmentMetadataPort(tx);
        await bound.linkObservationReferences({
          observation_id: rollbackObsId,
          attachment_ids: [rollbackAttId],
          actor_account_id: teacherAId,
        });
        throw new Error("injected business failure");
      });
    } catch {
      rollbackThrew = true;
    }
    await rollbackClient.release();
    const rollbackRefs = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM yaya_attachment_refs WHERE record_id = $1",
      [rollbackObsId],
    );
    check(
      "C 创建观察注入失败后零部分记录",
      rollbackThrew && rollbackRefs.rows[0]?.count === "0",
    );

    const appendObsId = randomUUID();
    const appendConfirmedAt = "2026-06-04T00:00:00.000Z";
    await database.query(
      `INSERT INTO observations (id, child_id, class_id, observed_at, raw_text, status, confirmed_at)
       VALUES ($1,$2,$3,'2026-06-04','归档追加夹具。','confirmed',$4)`,
      [appendObsId, childA, classA, appendConfirmedAt],
    );
    const appendAtt = await uploadImages(deps, {
      owner_account_id: teacherAId,
      files: [
        { filename: "ap.png", declared_content_type: null, body: await pngBuffer(46, 46), client_upload_id: null },
      ],
    });
    const appendAttId = requireUploaded(appendAtt.uploads[0], "appendAtt").attachment_id;
    const appendResult = await metadata.appendObservationAttachments({
      observation_id: appendObsId,
      attachment_ids: [appendAttId],
      expected_attachment_revision: 0,
      actor_account_id: teacherAId,
      source_confirmed_at: appendConfirmedAt,
      request_id: "req-integrate-1",
      approval_id: null,
    });
    check(
      "C 归档追加：revision/引用/审计同事务",
      appendResult.attachment_revision === 1 && appendResult.appended[0] === appendAttId,
    );
    const appendAudit = await database.query<{
      count: string;
      source_confirmed_at: Date | string;
      request_id: string;
      action: string;
    }>(
      "SELECT count(*) OVER ()::text AS count, source_confirmed_at, request_id, action FROM yaya_attachment_appends WHERE observation_id = $1",
      [appendObsId],
    );
    const auditRow = appendAudit.rows[0];
    check(
      "C 追加审计独立落库且带来源前提/请求身份",
      auditRow !== undefined &&
        auditRow.count === "1" &&
        auditRow.request_id === "req-integrate-1" &&
        auditRow.action === "attach_observation_images" &&
        new Date(auditRow.source_confirmed_at).getTime() === new Date(appendConfirmedAt).getTime(),
    );

    const draftObsId = randomUUID();
    const draftAtt = await uploadImages(deps, {
      owner_account_id: teacherAId,
      files: [
        { filename: "d.png", declared_content_type: null, body: await pngBuffer(47, 47), client_upload_id: null },
      ],
    });
    const draftAttId = requireUploaded(draftAtt.uploads[0], "draftAtt").attachment_id;
    await database.query(
      `INSERT INTO observations (id, child_id, class_id, observed_at, raw_text, status)
       VALUES ($1,$2,$3,'2026-06-05','草稿夹具。','draft')`,
      [draftObsId, childA, classA],
    );
    await expectMediaCode(
      async () =>
        metadata.appendObservationAttachments({
          observation_id: draftObsId,
          attachment_ids: [draftAttId],
          expected_attachment_revision: 0,
          actor_account_id: teacherAId,
          source_confirmed_at: appendConfirmedAt,
          request_id: null,
          approval_id: null,
        }),
      "observation_not_confirmed",
      "C 预检后宿主状态变为 draft：拒绝且零写入",
    );
    const draftWrites = await database.query<{ refs: string; audits: string }>(
      `SELECT
         (SELECT count(*)::text FROM yaya_attachment_refs WHERE record_id = $1) AS refs,
         (SELECT count(*)::text FROM yaya_attachment_appends WHERE observation_id = $1) AS audits`,
      [draftObsId],
    );
    check(
      "C 宿主不满足时零引用/零审计/修订不变",
      draftWrites.rows[0]?.refs === "0" &&
        draftWrites.rows[0]?.audits === "0" &&
        (await metadata.getObservationAttachmentRevision(draftObsId)) === 0,
    );

    const appendAtt2 = await uploadImages(deps, {
      owner_account_id: teacherAId,
      files: [
        { filename: "ap2.png", declared_content_type: null, body: await pngBuffer(48, 48), client_upload_id: null },
      ],
    });
    const appendAttId2 = requireUploaded(appendAtt2.uploads[0], "appendAtt2").attachment_id;
    await expectMediaCode(
      async () =>
        metadata.appendObservationAttachments({
          observation_id: appendObsId,
          attachment_ids: [appendAttId2],
          expected_attachment_revision: 1,
          actor_account_id: teacherAId,
          source_confirmed_at: "2026-06-04T00:00:05.000Z",
          request_id: null,
          approval_id: null,
        }),
      "source_conflict",
      "C 来源确认时间变化：拒绝且零写入",
    );
    await expectMediaCode(
      async () =>
        metadata.appendObservationAttachments({
          observation_id: appendObsId,
          attachment_ids: [appendAttId2],
          expected_attachment_revision: 0,
          actor_account_id: teacherAId,
          source_confirmed_at: appendConfirmedAt,
          request_id: null,
          approval_id: null,
        }),
      "revision_conflict",
      "C 版本前提过期：拒绝",
    );
    const appendAtt3 = await uploadImages(deps, {
      owner_account_id: teacherAId,
      files: [
        { filename: "ap3.png", declared_content_type: null, body: await pngBuffer(49, 49), client_upload_id: null },
      ],
    });
    const appendAttId3 = requireUploaded(appendAtt3.uploads[0], "appendAtt3").attachment_id;
    await expectMediaCode(
      async () =>
        metadata.appendObservationAttachments({
          observation_id: appendObsId,
          attachment_ids: [appendAttId3],
          expected_attachment_revision: 1,
          actor_account_id: teacherAId,
          source_confirmed_at: appendConfirmedAt,
          request_id: null,
          approval_id: "00000000-0000-0000-0000-000000000000",
        }),
      "metadata_unavailable",
      "C 审计写入失败（悬空批准引用）整单回滚",
    );
    const afterAuditFailure = await database.query<{ refs: string; audits: string }>(
      `SELECT
         (SELECT count(*)::text FROM yaya_attachment_refs WHERE record_id = $1 AND attachment_id = $2) AS refs,
         (SELECT count(*)::text FROM yaya_attachment_appends WHERE observation_id = $1) AS audits`,
      [appendObsId, appendAttId3],
    );
    check(
      "C 审计失败后引用/修订/审计不变",
      afterAuditFailure.rows[0]?.refs === "0" &&
        afterAuditFailure.rows[0]?.audits === "1" &&
        (await metadata.getObservationAttachmentRevision(appendObsId)) === 1,
    );

    // 同 revision 竞争：一成一冲突（真实双连接）
    const raceObsId = randomUUID();
    const raceConfirmedAt = "2026-06-06T00:00:00.000Z";
    await database.query(
      `INSERT INTO observations (id, child_id, class_id, observed_at, raw_text, status, confirmed_at)
       VALUES ($1,$2,$3,'2026-06-06','竞争夹具。','confirmed',$4)`,
      [raceObsId, childA, classA, raceConfirmedAt],
    );
    const raceAttA = await uploadImages(deps, {
      owner_account_id: teacherAId,
      files: [
        { filename: "ra.png", declared_content_type: null, body: await pngBuffer(51, 51), client_upload_id: null },
      ],
    });
    const raceAttB = await uploadImages(deps, {
      owner_account_id: teacherAId,
      files: [
        { filename: "rb.png", declared_content_type: null, body: await pngBuffer(52, 52), client_upload_id: null },
      ],
    });
    const raceAttAId = requireUploaded(raceAttA.uploads[0], "raceAttA").attachment_id;
    const raceAttBId = requireUploaded(raceAttB.uploads[0], "raceAttB").attachment_id;
    const raceClient1 = await pool.connect();
    await raceClient1.query("BEGIN");
    const raceBound = bindDataAttachmentMetadataPort(raceClient1 as unknown as TransactionClient);
    const raceFirst = await raceBound.appendObservationAttachments({
      observation_id: raceObsId,
      attachment_ids: [raceAttAId],
      expected_attachment_revision: 0,
      actor_account_id: teacherAId,
      source_confirmed_at: raceConfirmedAt,
      request_id: null,
      approval_id: null,
    });
    check("C 竞争首个 expected=0 成功", raceFirst.attachment_revision === 1);
    const raceSecond = metadata.appendObservationAttachments({
      observation_id: raceObsId,
      attachment_ids: [raceAttBId],
      expected_attachment_revision: 0,
      actor_account_id: teacherAId,
      source_confirmed_at: raceConfirmedAt,
      request_id: null,
      approval_id: null,
    });
    let raceSecondSettled = false;
    void raceSecond.then(
      () => {
        raceSecondSettled = true;
      },
      () => {
        raceSecondSettled = true;
      },
    );
    await sleep(250);
    check("C 竞争第二个请求在宿主/META 锁上等待", raceSecondSettled === false);
    await raceClient1.query("COMMIT");
    await raceClient1.release();
    let raceSecondError: unknown = null;
    try {
      await raceSecond;
    } catch (error) {
      raceSecondError = error;
    }
    check("C 相同 expected_revision 竞争一成一冲突", errorCode(raceSecondError) === "revision_conflict");
    const raceFinalRevision = await metadata.getObservationAttachmentRevision(raceObsId);
    check("C 竞争后修订只递增一次", raceFinalRevision === 1);
    stage("c-done");

    /* ============================ Agent：DATA 事实 + 重核不重送 ============================ */
    const agentImage = await uploadImages(deps, {
      owner_account_id: teacherAId,
      files: [
        { filename: "agent.png", declared_content_type: null, body: await pngBuffer(64, 64), client_upload_id: null },
      ],
    });
    const agentImageId = requireUploaded(agentImage.uploads[0], "agentImage").attachment_id;
    await withRawTransaction(pool, async (tx) => {
      const bound = bindDataAttachmentMetadataPort(tx);
      await bound.linkObservationReferences({
        observation_id: observationId,
        attachment_ids: [agentImageId],
        actor_account_id: teacherAId,
      });
    });
    const agentImageRecord = await metadata.get(agentImageId);
    assert.ok(agentImageRecord !== null);

    const observationResource = async (obsId: string) => {
      const obs = await getObservation(obsId);
      if (obs === null) return null;
      const child = await getChild(obs.child_id);
      return {
        obs,
        resource: {
          kind: "observation" as const,
          observation_id: obs.id,
          child_id: obs.child_id,
          current_class_id: child?.class_id ?? null,
          observed_class_id: obs.class_id,
          author_account_id: null,
        },
      };
    };
    const sourceRef: YayaSourceRef = {
      kind: "child_fact",
      ref_id: observationId,
      label: "观察记录",
      derived_from: null,
    };

    interface StubModelRecorder {
      modelCalls: string[][];
    }
    const createAgentDeps = (input: {
      firstAction: "read" | "answer";
      revalidateHook: (() => Promise<void>) | null;
      identity: { run_id: string; session_valid: boolean };
    }): YayaAgentDependencies & StubModelRecorder => {
      const modelCalls: string[][] = [];
      const deps: YayaAgentDependencies = {
        model: {
          generate: async (request) => {
            modelCalls.push(
              request.messages.map(
                (message) =>
                  `${message.text}${message.images ? `#images:${message.images.length}` : ""}`,
              ),
            );
            const action =
              modelCalls.length === 1 && input.firstAction === "read"
                ? {
                    action: "read",
                    content: "",
                    tool: "child_observation",
                    params_json: JSON.stringify({ observation_id: observationId }),
                    source_refs: [],
                  }
                : {
                    action: "answer",
                    content: "整理完成",
                    tool: "",
                    params_json: "",
                    source_refs: [],
                  };
            return {
              content: JSON.stringify(action),
              provider: "integrate1-stub",
              model: "stub",
              usage: null,
            };
          },
        },
        resolveCurrentIdentity: async () => ({
          run_id: input.identity.run_id,
          identity_state: "authenticated",
          principal: principalA,
          session_valid: input.identity.session_valid,
        }),
        loadProjectedContext: async (contextInput) => {
          const facts = await observationResource(observationId);
          if (facts === null) throw new Error("observation missing");
          const decision = authorizeAction(
            contextInput.identity.principal!,
            "observation.read",
            facts.resource,
          );
          if (!decision.allowed) throw new Error("denied");
          const history =
            decision.projection === "full"
              ? [{ role: "user" as const, content: facts.obs.raw_text }]
              : [];
          const images = [];
          if (decision.projection === "full") {
            const stored = await store.get(agentImageRecord.model_key);
            if (stored !== null) {
              images.push({
                image_id: agentImageId,
                media_type: "image/jpeg" as const,
                data_base64: stored.body.toString("base64"),
                source: sourceRef,
              });
            }
          }
          return { history, sources: [sourceRef], images, guide_catalog: null };
        },
        revalidateProjectedContext: async (revalidateInput) => {
          if (input.revalidateHook) await input.revalidateHook();
          const denied: string[] = [];
          for (const source of revalidateInput.sources) {
            if (source.kind !== "child_fact" || source.ref_id === null) continue;
            const facts = await observationResource(source.ref_id);
            if (facts === null) {
              denied.push(source.ref_id);
              continue;
            }
            const decision = authorizeAction(
              revalidateInput.identity.principal!,
              "observation.read",
              facts.resource,
            );
            if (!decision.allowed || decision.projection !== "full") denied.push(source.ref_id);
          }
          for (const imageId of revalidateInput.image_ids) {
            const image = await metadata.get(imageId);
            if (image === null || image.status !== "ready") denied.push(imageId);
          }
          return denied.length > 0
            ? { ok: false as const, reason: "context_revoked" as const, denied_refs: denied }
            : { ok: true as const };
        },
        readTool: async () => {
          // 模拟读取等待期间幼儿被转班（当前归属离开教师范围，原班仅历史只读）
          await database!.query(
            "UPDATE child_class_enrollments SET class_id = $2 WHERE child_id = $1 AND end_date IS NULL",
            [childA, classB],
          );
          const obs = await getObservation(observationId);
          return {
            ok: true as const,
            data: { text: obs?.raw_text ?? "" },
            source: sourceRef,
          };
        },
        proposeWrite: async () => ({ ok: false, code: "unsupported", message: "not used" }),
        queryOperation: async () => ({ kind: "unknown", reason: "no_receipt" }),
        publicSearchPolicy: { provider_enabled: false, scanChildIdentifiers: async () => "unknown" },
        tools: {
          read_tools: [
            {
              tool: "child_observation",
              description: "读取单个观察",
              scope_policy: "business_scope",
              params: zodToolParams(z.object({ observation_id: z.string().min(1) })),
            },
          ],
          write_tools: [],
        },
      };
      return Object.assign(deps, { modelCalls }) as YayaAgentDependencies & StubModelRecorder;
    };

    // 场景 1：read 等待中转班 → 不消费旧结果、不二次派发
    const identityState: { run_id: string; session_valid: boolean } = { run_id: randomUUID(), session_valid: true };
    const scenario1 = createAgentDeps({
      firstAction: "read",
      revalidateHook: null,
      identity: identityState,
    });
    const run1 = await runYayaAgent(scenario1, {
      run_id: identityState.run_id,
      user_text: "这条观察说了什么？",
    });
    check(
      "Agent read 等待中撤权：停止且不重送受限私域内容（model=1）",
      run1.outcome.kind === "stopped" &&
        run1.outcome.reason === "context_revoked" &&
        scenario1.modelCalls.length === 1 &&
        !run1.events.some((event) => event.type === "tool_result") &&
        !run1.events.some((event) => event.type === "answer"),
    );

    // 场景 2：发布前重核等待中 run 被替换 → 不发布旧答案
    await database.query(
      "UPDATE child_class_enrollments SET class_id = $2 WHERE child_id = $1 AND end_date IS NULL",
      [childA, classA],
    );
    const identityState2: { run_id: string; session_valid: boolean } = { run_id: randomUUID(), session_valid: true };
    let revalidateCount = 0;
    const scenario2 = createAgentDeps({
      firstAction: "answer",
      revalidateHook: async () => {
        revalidateCount += 1;
        if (revalidateCount === 3) {
          identityState2.run_id = "replaced-run";
        }
      },
      identity: identityState2,
    });
    const run2 = await runYayaAgent(scenario2, {
      run_id: identityState2.run_id,
      user_text: "解释一下这条观察。",
    });
    check(
      "Agent 重核等待中 run 替换：不发布旧答案（model=1，run_replaced）",
      run2.outcome.kind === "stopped" &&
        run2.outcome.reason === "run_replaced" &&
        scenario2.modelCalls.length === 1 &&
        !run2.events.some((event) => event.type === "answer"),
    );

    // 场景 3：发布前重核等待中会话失效 → 不发布旧答案
    const identityState3: { run_id: string; session_valid: boolean } = { run_id: randomUUID(), session_valid: true };
    revalidateCount = 0;
    const scenario3 = createAgentDeps({
      firstAction: "answer",
      revalidateHook: async () => {
        revalidateCount += 1;
        if (revalidateCount === 3) {
          identityState3.session_valid = false;
        }
      },
      identity: identityState3,
    });
    const run3 = await runYayaAgent(scenario3, {
      run_id: identityState3.run_id,
      user_text: "解释一下这条观察。",
    });
    check(
      "Agent 重核等待中会话失效：不发布旧答案（model=1，session_invalid）",
      run3.outcome.kind === "stopped" &&
        run3.outcome.reason === "session_invalid" &&
        scenario3.modelCalls.length === 1 &&
        !run3.events.some((event) => event.type === "answer"),
    );
    stage("agent-done");

    check("模型守门未被触发（真实 provider 出口 0 次）", guard.hits === 0);
  } finally {
    await runCleanupSteps(
      [
        { label: "pool", run: () => pool?.end().then(() => undefined) },
        {
          label: "global-pg-pool",
          run: async () => {
            const holder = globalThis as { __pgPool?: { end: () => Promise<void> } };
            await holder.__pgPool?.end();
          },
        },
        {
          label: "temp-roots",
          run: async () => {
            for (const root of tempRoots) await rm(root, { recursive: true, force: true });
          },
        },
        { label: "database", run: () => database?.end().then(() => undefined) },
        {
          label: "container",
          run: () => {
            if (!isolated) return;
            const report = isolated.teardown();
            if (!report.ok) throw new Error(report.detail);
          },
        },
        { label: "model-guard", run: () => guard.close() },
      ],
      (label, detail) => cleanupIssues.push(`${label}: ${detail}`),
    );
    for (const root of tempRoots) {
      const remaining = await listFiles(root);
      if (remaining.length > 0) cleanupIssues.push(`temp-root 残留：${root} (${remaining.length})`);
    }
    assertCleanupComplete(cleanupIssues);
  }

  console.log(
    JSON.stringify({
      passed,
      total: passed + failures.length,
      failures,
      run_id: RUN,
      layers: {
        adapter: "real DATA repository (short txn + bound txn)",
        processing: "real sharp",
        storage: "local object store (real local I/O)",
        agent_model: "in-process stub",
        real_provider: "not_run",
      },
    }),
  );
  if (failures.length > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
