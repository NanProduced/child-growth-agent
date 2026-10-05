/**
 * YAYA-MEDIA1 离线可运行验收（真实 sharp 处理 + 本地对象存储替身 + 内存元数据替身）。
 *
 * 覆盖：
 * - 合成图片真实解码/压缩：坏魔数、超像素、超限、EXIF 移除、缩略图/模型图；
 * - 上传限额与逐图错误保留、写一次 + checksum 回读、重复请求幂等、失败补偿；
 * - 授权正反例（未关联仅上传者、已关联按 record_kind+record_id、历史只读仅元数据、
 *   管理员只读、越权/撤权拒绝）；
 * - 归档后追加（revision/source/所有权/审计）、创建关联、共享多引用；
 * - 引用保护、删除租约、只解除自己会话引用、未知删除结果保留可核验状态、精确删除。
 *
 * 边界：不连接数据库/真实 S3/模型/搜索；不读 .env；只在本进程与自有临时目录内 I/O。
 * 真实桶、浏览器选图、真实模型看图、资料追加正式 DB 闭环均为 NOT_RUN（见交付文档）。
 *
 * 运行：pnpm exec tsx scripts/yaya/check-media.ts
 */

import assert from "node:assert/strict";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

import { authorizeAction } from "../../src/lib/accounts/authorize";
import type { Principal } from "../../src/lib/accounts/types";
import {
  appendObservationImages,
  associateObservationImagesOnCreate,
  assertHostChildWrite,
  type HostObservationFacts,
} from "../../src/lib/media/attachment-service";
import {
  assertBucketIdentityIsolated,
  buildObjectKey,
  createObjectStore,
  loadMediaStorageConfig,
  type MediaStorageConfig,
} from "../../src/lib/media/config";
import {
  attachmentMetadataView,
  evaluateAttachmentRead,
  loadAttachmentContent,
  type MediaViewer,
} from "../../src/lib/media/content-service";
import { MediaError } from "../../src/lib/media/errors";
import { processImage, sniffImageContentType } from "../../src/lib/media/image-processing";
import {
  MEDIA_MAX_IMAGE_BYTES,
  MEDIA_MAX_IMAGES_PER_UPLOAD,
  MEDIA_MAX_PIXELS,
  assertShortSignedUrlTtl,
} from "../../src/lib/media/limits";
import { MemoryAttachmentMetadata } from "../../src/lib/media/metadata-memory";
import { assertSafeObjectKey, sha256Hex } from "../../src/lib/media/object-store";
import { LocalMediaObjectStore } from "../../src/lib/media/object-store-local";
import { recycleAttachment, releaseConversationReferences } from "../../src/lib/media/retention-service";
import { createLocalMediaRuntime, type MediaServiceDeps } from "../../src/lib/media/runtime";
import { uploadImages } from "../../src/lib/media/upload-service";
import type { YayaImageViewerRecordAccess } from "../../src/lib/yaya/types";

const CHECK_ROOT = path.join(os.tmpdir(), "opencode", `yaya-media1-check-${process.pid}-${Date.now()}`);
const OWNER_A = "account-teacher-a";
const OWNER_B = "account-teacher-b";
const ADMIN = "account-admin";

let passed = 0;
const failures: string[] = [];

async function check(name: string, run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL - ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* --------------------------------- 合成素材 --------------------------------- */

async function jpegWithExif(): Promise<Buffer> {
  const base = await sharp({
    create: { width: 640, height: 480, channels: 3, background: { r: 210, g: 120, b: 60 } },
  })
    .jpeg()
    .toBuffer();
  return sharp(base)
    .withExif({
      IFD0: { Software: "yaya-media1-check", Copyright: "synthetic-only" },
      IFD2: { DateTimeOriginal: "2026:10:06 09:00:00" },
    })
    .jpeg()
    .toBuffer();
}

function pngBuffer(width = 320, height = 240): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 160, b: 90 } },
  })
    .png()
    .toBuffer();
}

function webpBuffer(): Promise<Buffer> {
  return sharp({
    create: { width: 300, height: 200, channels: 3, background: { r: 90, g: 90, b: 200 } },
  })
    .webp()
    .toBuffer();
}

function gifHeader(): Buffer {
  return Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(32, 1)]);
}

function corruptJpeg(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
}

function oversizedBytes(): Buffer {
  const body = Buffer.alloc(MEDIA_MAX_IMAGE_BYTES + 1, 0);
  body[0] = 0xff;
  body[1] = 0xd8;
  body[2] = 0xff;
  return body;
}

async function oversizedPixels(): Promise<Buffer> {
  // 7000×6000 = 42MP > 40MP 上限；合成 JPEG 编码体积很小，但解码前即被像素上限拒绝。
  return sharp({
    create: { width: 7000, height: 6000, channels: 3, background: { r: 1, g: 2, b: 3 } },
  })
    .jpeg({ quality: 10 })
    .toBuffer();
}

/* --------------------------------- 替身设施 --------------------------------- */

function principalOf(
  role: "admin" | "teacher",
  classIds: readonly string[] = [],
): Principal {
  if (role === "admin") {
    return {
      account_id: ADMIN,
      username: "admin",
      display_name: "管理员",
      role,
      account_status: "active",
      scope: { kind: "school", school_id: "school-1" },
    };
  }
  return {
    account_id: OWNER_A,
    username: "teacher.a",
    display_name: "教师A",
    role,
    account_status: "active",
    scope: { kind: "classes", class_ids: [...classIds] },
  };
}

function teacherB(classIds: readonly string[] = ["class-a"]): Principal {
  return {
    account_id: OWNER_B,
    username: "teacher.b",
    display_name: "教师B",
    role: "teacher",
    account_status: "active",
    scope: { kind: "classes", class_ids: [...classIds] },
  };
}

function hostFacts(overrides: Partial<HostObservationFacts> = {}): HostObservationFacts {
  return {
    observation_id: "observation-1",
    child_id: "child-a",
    status: "confirmed",
    confirmed_at: "2026-10-05T08:00:00.000Z",
    current_class_id: "class-a",
    observed_class_id: "class-a",
    ...overrides,
  };
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

async function uploadOne(
  deps: MediaServiceDeps,
  owner: string,
  body: Buffer,
  options: { client?: string } = {},
): Promise<{ attachment_id: string }> {
  const batch = await uploadImages(deps, {
    owner_account_id: owner,
    files: [
      {
        filename: "photo.jpg",
        declared_content_type: null,
        body,
        client_upload_id: options.client ?? null,
      },
    ],
  });
  const first = batch.uploads[0];
  if (!first || !first.ok) {
    throw new Error(`upload failed: ${first && !first.ok ? `${first.code} ${first.message}` : "missing"}`);
  }
  return { attachment_id: first.attachment.attachment_id };
}

function fullAccess(recordId: string): YayaImageViewerRecordAccess {
  return { record_kind: "observation", record_id: recordId, projection: "full" };
}

function historicalAccess(recordId: string): YayaImageViewerRecordAccess {
  return { record_kind: "observation", record_id: recordId, projection: "historical_read_only" };
}

const viewerA: MediaViewer = { account_id: OWNER_A, role: "teacher" };
const viewerB: MediaViewer = { account_id: OWNER_B, role: "teacher" };
const viewerAdmin: MediaViewer = { account_id: ADMIN, role: "admin" };

async function main(): Promise<void> {
  await mkdir(CHECK_ROOT, { recursive: true });
  const metadata = new MemoryAttachmentMetadata();
  const store = new LocalMediaObjectStore(CHECK_ROOT);
  const deps: MediaServiceDeps = { metadata, store, environment: "development" };

  /* ------------------------------ 格式与处理 ------------------------------ */

  await check("魔数识别只认 JPEG/PNG/WebP", async () => {
    const [jpeg, png, webp] = await Promise.all([jpegWithExif(), pngBuffer(), webpBuffer()]);
    assert.equal(sniffImageContentType(jpeg), "image/jpeg");
    assert.equal(sniffImageContentType(png), "image/png");
    assert.equal(sniffImageContentType(webp), "image/webp");
    assert.equal(sniffImageContentType(gifHeader()), null);
    assert.equal(sniffImageContentType(Buffer.from("%PDF-1.7")), null);
    assert.equal(sniffImageContentType(Buffer.alloc(0)), null);
  });

  await check("EXIF 移除与派生图（真实解码/压缩）", async () => {
    const input = await jpegWithExif();
    const inputMeta = await sharp(input).metadata();
    assert.ok(inputMeta.exif !== undefined, "合成素材必须带 EXIF 才有效");
    const processed = await processImage(input);
    assert.equal(processed.content_type, "image/jpeg");
    assert.equal(processed.width, 640);
    assert.equal(processed.height, 480);
    for (const variant of [processed.original, processed.thumbnail, processed.model]) {
      const meta = await sharp(variant).metadata();
      assert.equal(meta.exif, undefined, "输出不得携带 EXIF");
    }
    const thumbMeta = await sharp(processed.thumbnail).metadata();
    assert.ok((thumbMeta.width ?? 0) <= 320 && (thumbMeta.height ?? 0) <= 320);
    const modelMeta = await sharp(processed.model).metadata();
    assert.ok((modelMeta.width ?? 0) <= 1024 && (modelMeta.height ?? 0) <= 1024);
    assert.ok(!processed.model.includes(Buffer.from("2026:10:06")), "拍摄时间不得随图保留");
    assert.deepEqual(
      Object.keys(processed).sort(),
      ["content_type", "height", "model", "original", "thumbnail", "width"],
      "处理结果不得包含人脸/拍摄时间/幼儿识别字段",
    );
  });

  await check("坏魔数/坏解码/超字节/超像素明确拒绝", async () => {
    await assert.rejects(processImage(corruptJpeg()), (error: unknown) => {
      assert.ok(error instanceof MediaError);
      assert.equal(error.code, "decode_failed");
      return true;
    });
    await assert.rejects(processImage(gifHeader()), (error: unknown) => {
      assert.ok(error instanceof MediaError);
      assert.equal(error.code, "unsupported_format");
      assert.ok(error.message.includes("JPEG"));
      return true;
    });
    await assert.rejects(processImage(oversizedBytes()), (error: unknown) => {
      assert.ok(error instanceof MediaError);
      assert.equal(error.code, "file_too_large");
      return true;
    });
    const big = await oversizedPixels();
    await assert.rejects(processImage(big), (error: unknown) => {
      assert.ok(error instanceof MediaError);
      assert.equal(error.code, "pixel_limit_exceeded");
      return true;
    });
    assert.ok(MEDIA_MAX_PIXELS < 7000 * 6000);
  });

  /* -------------------------------- 上传 -------------------------------- */

  await check("混合批次逐图保留：好图成功、坏图明确报错", async () => {
    const batch = await uploadImages(deps, {
      owner_account_id: OWNER_A,
      files: [
        { filename: "a.jpg", declared_content_type: "image/jpeg", body: await jpegWithExif(), client_upload_id: null },
        { filename: "b.png", declared_content_type: "image/png", body: await pngBuffer(), client_upload_id: null },
        { filename: "c.gif", declared_content_type: null, body: gifHeader(), client_upload_id: null },
        { filename: "d.jpg", declared_content_type: null, body: corruptJpeg(), client_upload_id: null },
      ],
    });
    assert.equal(batch.uploads.length, 4);
    assert.equal(batch.uploads[0]?.ok, true);
    assert.equal(batch.uploads[1]?.ok, true);
    const third = batch.uploads[2];
    assert.ok(third && !third.ok && third.code === "unsupported_format");
    const fourth = batch.uploads[3];
    assert.ok(fourth && !fourth.ok && fourth.code === "decode_failed");
    assert.equal(metadata.countAttachments(), 2, "只登记成功图片");
    assert.equal((await listFiles(CHECK_ROOT)).length, 6, "每张成功图片三个精确对象");
  });

  await check("重复请求幂等：同 client_upload_id 返回原附件，不重复写对象", async () => {
    const before = await listFiles(CHECK_ROOT);
    const first = await uploadOne(deps, OWNER_A, await pngBuffer(), { client: "client-1" });
    const afterFirst = await listFiles(CHECK_ROOT);
    const second = await uploadOne(deps, OWNER_A, await pngBuffer(), { client: "client-1" });
    const afterSecond = await listFiles(CHECK_ROOT);
    assert.equal(second.attachment_id, first.attachment_id);
    assert.equal(afterSecond.length, afterFirst.length);
    assert.ok(afterFirst.length > before.length);
  });

  await check("每次上限 8 张：8 张可用、9 张整批拒绝", async () => {
    const tiny = await pngBuffer(24, 24);
    const eight = await uploadImages(deps, {
      owner_account_id: OWNER_A,
      files: Array.from({ length: MEDIA_MAX_IMAGES_PER_UPLOAD }, () => ({
        filename: "t.png",
        declared_content_type: null,
        body: tiny,
        client_upload_id: null,
      })),
    });
    assert.equal(eight.uploads.filter((entry) => entry.ok).length, MEDIA_MAX_IMAGES_PER_UPLOAD);
    await assert.rejects(
      uploadImages(deps, {
        owner_account_id: OWNER_A,
        files: Array.from({ length: MEDIA_MAX_IMAGES_PER_UPLOAD + 1 }, () => ({
          filename: "t.png",
          declared_content_type: null,
          body: tiny,
          client_upload_id: null,
        })),
      }),
      (error: unknown) => {
        assert.ok(error instanceof MediaError && error.code === "too_many_images");
        return true;
      },
    );
  });

  await check("声明类型与内容不符拒绝", async () => {
    const batch = await uploadImages(deps, {
      owner_account_id: OWNER_A,
      files: [
        {
          filename: "mismatch.png",
          declared_content_type: "image/jpeg",
          body: await pngBuffer(),
          client_upload_id: null,
        },
      ],
    });
    const result = batch.uploads[0];
    assert.ok(result && !result.ok && result.code === "content_type_mismatch");
  });

  await check("对象只写一次：同字节幂等、异字节冲突", async () => {
    const key = buildObjectKey({
      environment: "development",
      owner_account_id: OWNER_A,
      attachment_id: "write-once-check",
      variant: "original",
    });
    const body = Buffer.from("write-once");
    const first = await store.putOnce({ key, content_type: "image/png", body });
    assert.equal(first.outcome, "created");
    const again = await store.putOnce({ key, content_type: "image/png", body });
    assert.equal(again.outcome, "already_present");
    const different = await store.putOnce({ key, content_type: "image/png", body: Buffer.from("other") });
    assert.equal(different.outcome, "conflict");
    assert.equal(sha256Hex(body), first.checksum_sha256);
    await store.delete(key);
  });

  await check("半上传补偿：markReady 失败删本轮对象并清 pending", async () => {
    const beforeFiles = (await listFiles(CHECK_ROOT)).length;
    const beforeRecords = metadata.countAttachments();
    metadata.failNext("markReady");
    const batch = await uploadImages(deps, {
      owner_account_id: OWNER_A,
      files: [{ filename: "x.png", declared_content_type: null, body: await pngBuffer(), client_upload_id: null }],
    });
    const result = batch.uploads[0];
    assert.ok(result && !result.ok && result.code === "metadata_unavailable");
    assert.equal((await listFiles(CHECK_ROOT)).length, beforeFiles, "补偿必须删掉本轮三个对象");
    assert.equal(metadata.countAttachments(), beforeRecords, "pending 记录已清理");
  });

  await check("半上传补偿：insertPending 失败同样精确清理", async () => {
    const beforeFiles = (await listFiles(CHECK_ROOT)).length;
    metadata.failNext("insertPending");
    const batch = await uploadImages(deps, {
      owner_account_id: OWNER_A,
      files: [{ filename: "y.png", declared_content_type: null, body: await pngBuffer(), client_upload_id: null }],
    });
    const result = batch.uploads[0];
    assert.ok(result && !result.ok && result.code === "metadata_unavailable");
    assert.equal((await listFiles(CHECK_ROOT)).length, beforeFiles);
  });

  await check("补偿不按前缀清空：同前缀的他轮对象保留", async () => {
    const foreignKey = buildObjectKey({
      environment: "development",
      owner_account_id: OWNER_A,
      attachment_id: "foreign-round-object",
      variant: "original",
    });
    await store.putOnce({ key: foreignKey, content_type: "image/png", body: Buffer.from("foreign") });
    metadata.failNext("markReady");
    const batch = await uploadImages(deps, {
      owner_account_id: OWNER_A,
      files: [{ filename: "z.png", declared_content_type: null, body: await pngBuffer(), client_upload_id: null }],
    });
    assert.ok(batch.uploads[0] && !batch.uploads[0].ok);
    assert.ok((await store.get(foreignKey)) !== null, "其他轮对象不得被前缀清空");
    await store.delete(foreignKey);
  });

  /* ------------------------------ 授权读取 ------------------------------ */

  const unattached = await uploadOne(deps, OWNER_A, await jpegWithExif());
  const attached = await uploadOne(deps, OWNER_A, await pngBuffer());

  await check("未关联图片：仅上传者可读，同班教师/管理员拒绝", async () => {
    const noAccess = async () => null;
    const ownerView = await evaluateAttachmentRead(deps, {
      attachment_id: unattached.attachment_id,
      viewer: viewerA,
      loadRecordAccess: noAccess,
    });
    assert.equal(ownerView.decision.readable, true);
    assert.equal(ownerView.decision.readable && ownerView.decision.via, "uploader_private");
    for (const viewer of [viewerB, viewerAdmin]) {
      const view = await evaluateAttachmentRead(deps, {
        attachment_id: unattached.attachment_id,
        viewer,
        loadRecordAccess: noAccess,
      });
      assert.equal(view.decision.readable, false);
      assert.equal(!view.decision.readable && view.decision.reason, "not_attached_and_not_uploader");
    }
  });

  await check("内容代理：上传者读原图/缩略图/模型图，checksum 校验", async () => {
    const record = await metadata.get(unattached.attachment_id);
    assert.ok(record);
    const expected: Record<"original" | "thumbnail" | "model", string> = {
      original: record.checksum_sha256,
      thumbnail: record.thumbnail_checksum,
      model: record.model_checksum,
    };
    for (const variant of ["original", "thumbnail", "model"] as const) {
      const content = await loadAttachmentContent(deps, {
        attachment_id: unattached.attachment_id,
        viewer: viewerA,
        loadRecordAccess: async () => null,
        variant,
      });
      assert.ok(content.byte_size > 0);
      assert.equal(sha256Hex(content.body), expected[variant]);
    }
  });

  await check("已关联：按 record_kind+record_id 授权，历史只读仅元数据", async () => {
    await metadata.addObservationReferences({
      observation_id: "observation-1",
      attachment_ids: [attached.attachment_id],
      actor_account_id: OWNER_A,
    });
    metadata.seedObservation("observation-1", "draft");
    const withFull = await evaluateAttachmentRead(deps, {
      attachment_id: attached.attachment_id,
      viewer: viewerB,
      loadRecordAccess: async () => fullAccess("observation-1"),
    });
    assert.equal(withFull.decision.readable, true);
    assert.equal(withFull.decision.readable && withFull.decision.via, "business_record");
    const historical = await evaluateAttachmentRead(deps, {
      attachment_id: attached.attachment_id,
      viewer: viewerB,
      loadRecordAccess: async () => historicalAccess("observation-1"),
    });
    assert.equal(historical.decision.readable, false);
    assert.equal(!historical.decision.readable && historical.decision.metadata_only, true);
    assert.equal(!historical.decision.readable && historical.decision.reason, "historical_metadata_only");
    await assert.rejects(
      loadAttachmentContent(deps, {
        attachment_id: attached.attachment_id,
        viewer: viewerB,
        loadRecordAccess: async () => historicalAccess("observation-1"),
        variant: "original",
      }),
      (error: unknown) => {
        assert.ok(error instanceof MediaError && error.code === "metadata_only");
        return true;
      },
    );
    const noRecordAccess = await evaluateAttachmentRead(deps, {
      attachment_id: attached.attachment_id,
      viewer: viewerB,
      loadRecordAccess: async () => null,
    });
    assert.equal(!noRecordAccess.decision.readable && noRecordAccess.decision.reason, "attached_but_no_record_access");
    const uploaderLosesPrivate = await evaluateAttachmentRead(deps, {
      attachment_id: attached.attachment_id,
      viewer: viewerA,
      loadRecordAccess: async () => null,
    });
    assert.equal(!uploaderLosesPrivate.decision.readable && uploaderLosesPrivate.decision.reason, "attached_but_no_record_access");
    const metadataView = attachmentMetadataView(historical);
    assert.equal(metadataView.metadata_only, true);
    assert.equal(metadataView.readable, false);
    assert.ok(!("object_key" in metadataView));
  });

  await check("对象被篡改：拒绝返回损坏内容", async () => {
    const record = await metadata.get(attached.attachment_id);
    assert.ok(record);
    const objectPath = path.join(CHECK_ROOT, ...record.object_key.split("/"));
    await writeFile(objectPath, Buffer.from("tampered"));
    await assert.rejects(
      loadAttachmentContent(deps, {
        attachment_id: attached.attachment_id,
        viewer: viewerB,
        loadRecordAccess: async () => fullAccess("observation-1"),
        variant: "original",
      }),
      (error: unknown) => {
        assert.ok(error instanceof MediaError && error.code === "checksum_mismatch");
        return true;
      },
    );
  });

  await check("引用查询不完整：保守拒绝读取", async () => {
    metadata.failNext("getReferenceFacts");
    await assert.rejects(
      evaluateAttachmentRead(deps, {
        attachment_id: unattached.attachment_id,
        viewer: viewerA,
        loadRecordAccess: async () => null,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MediaError && error.code === "reference_query_incomplete");
        return true;
      },
    );
  });

  /* --------------------------- 关联与追加（授权） --------------------------- */

  const appendImage = await uploadOne(deps, OWNER_A, await webpBuffer());
  const teacherA = principalOf("teacher", ["class-a"]);

  await check("创建观察事务内关联：draft 可关联并写独立审计", async () => {
    const createHost = hostFacts({
      observation_id: "observation-create",
      status: "draft",
      confirmed_at: null,
    });
    const frozen = JSON.stringify(createHost);
    const result = await associateObservationImagesOnCreate(deps, {
      host: createHost,
      principal: teacherA,
      image_ids: [appendImage.attachment_id],
      request_id: "req-create",
    });
    assert.equal(result.attachment_revision, 1);
    assert.equal(JSON.stringify(createHost), frozen, "关联不得改动宿主观察事实");
    const audit = metadata.audits().at(-1);
    assert.ok(audit);
    assert.equal(audit.action, "create_observation_attachments");
    assert.deepEqual([...audit.attachment_ids], [appendImage.attachment_id]);
    assert.ok(!("raw_text" in audit) && !("confirmed_content" in audit));
  });

  await check("归档后追加：核 source_confirmed_at/revision/所有权并写审计", async () => {
    const host = hostFacts({ observation_id: "observation-append" });
    const frozen = JSON.stringify(host);
    const result = await appendObservationImages(deps, {
      host,
      principal: teacherA,
      image_ids: [appendImage.attachment_id],
      expected_attachment_revision: 0,
      source_confirmed_at: host.confirmed_at,
      request_id: "req-append",
    });
    assert.equal(result.attachment_revision, 1);
    assert.equal(JSON.stringify(host), frozen);
    const audit = metadata.audits().at(-1);
    assert.ok(audit);
    assert.equal(audit.action, "attach_observation_images");
    assert.equal(audit.source_confirmed_at, host.confirmed_at);
    await assert.rejects(
      appendObservationImages(deps, {
        host,
        principal: teacherA,
        image_ids: [appendImage.attachment_id],
        expected_attachment_revision: 0,
        source_confirmed_at: host.confirmed_at,
        request_id: null,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MediaError && error.code === "revision_conflict");
        return true;
      },
    );
    await assert.rejects(
      appendObservationImages(deps, {
        host,
        principal: teacherA,
        image_ids: [appendImage.attachment_id],
        expected_attachment_revision: 1,
        source_confirmed_at: "2026-10-04T08:00:00.000Z",
        request_id: null,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MediaError && error.code === "source_conflict");
        return true;
      },
    );
  });

  await check("追加授权正反例：未确认/非本人/管理员/越权/撤权全拒绝", async () => {
    const draftHost = hostFacts({ observation_id: "observation-append", status: "ai_organized" });
    await assert.rejects(
      appendObservationImages(deps, {
        host: draftHost,
        principal: teacherA,
        image_ids: [appendImage.attachment_id],
        expected_attachment_revision: 1,
        source_confirmed_at: draftHost.confirmed_at,
        request_id: null,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MediaError && error.code === "observation_not_confirmed");
        return true;
      },
    );
    const host = hostFacts({ observation_id: "observation-append" });
    await assert.rejects(
      appendObservationImages(deps, {
        host,
        principal: teacherB(),
        image_ids: [appendImage.attachment_id],
        expected_attachment_revision: 1,
        source_confirmed_at: host.confirmed_at,
        request_id: null,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MediaError && error.code === "not_owner");
        return true;
      },
    );
    assert.throws(
      () => assertHostChildWrite(principalOf("admin"), host),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "forbidden_role");
        return true;
      },
    );
    assert.throws(
      () => assertHostChildWrite(teacherB(["class-b"]), host),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "out_of_scope");
        return true;
      },
    );
    assert.throws(
      () => assertHostChildWrite(principalOf("teacher", []), host),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "empty_scope");
        return true;
      },
    );
    const decision = authorizeAction(principalOf("admin"), "observation.read", {
      kind: "observation",
      observation_id: "observation-append",
      child_id: "child-a",
      current_class_id: "class-a",
      observed_class_id: "class-a",
      author_account_id: null,
    });
    assert.equal(decision.allowed, true, "管理员只读观察");
  });

  await check("共同照片多引用：不复制对象、不重复上传", async () => {
    const before = (await listFiles(CHECK_ROOT)).length;
    const hostTwo = hostFacts({ observation_id: "observation-2" });
    const result = await appendObservationImages(deps, {
      host: hostTwo,
      principal: teacherA,
      image_ids: [appendImage.attachment_id],
      expected_attachment_revision: 0,
      source_confirmed_at: hostTwo.confirmed_at,
      request_id: null,
    });
    assert.equal(result.attachment_revision, 1);
    assert.equal((await listFiles(CHECK_ROOT)).length, before);
  });

  await check("删除租约阻止新引用；失败结果恢复 ready", async () => {
    const lease = await metadata.beginDeletionLease(appendImage.attachment_id);
    assert.equal(lease.outcome, "acquired");
    if (lease.outcome !== "acquired") return;
    await assert.rejects(
      appendObservationImages(deps, {
        host: hostFacts({ observation_id: "observation-2" }),
        principal: teacherA,
        image_ids: [appendImage.attachment_id],
        expected_attachment_revision: 1,
        source_confirmed_at: "2026-10-05T08:00:00.000Z",
        request_id: null,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MediaError && error.code === "attachment_deleting");
        return true;
      },
    );
    const busy = await metadata.beginDeletionLease(appendImage.attachment_id);
    assert.equal(busy.outcome, "already_deleting");
    await metadata.completeDeletion(appendImage.attachment_id, lease.lease_token, "failed");
    const record = await metadata.get(appendImage.attachment_id);
    assert.equal(record?.status, "ready");
  });

  /* ------------------------------ 引用与回收 ------------------------------ */

  await check("观察全状态引用保护；删除会话只解除自己引用", async () => {
    const shared = await uploadOne(deps, OWNER_A, await pngBuffer());
    metadata.seedConversation("conversation-1", OWNER_A);
    metadata.seedConversation("conversation-2", OWNER_A);
    for (const [observationId, status] of [
      ["observation-draft", "draft"],
      ["observation-needs", "needs_input"],
      ["observation-organized", "ai_organized"],
      ["observation-confirmed", "confirmed"],
    ] as const) {
      metadata.seedObservation(observationId, status);
      await metadata.addObservationReferences({
        observation_id: observationId,
        attachment_ids: [shared.attachment_id],
        actor_account_id: OWNER_A,
      });
    }
    metadata.seedReference({
      attachment_id: shared.attachment_id,
      ref_kind: "message",
      ref_id: "message-1",
      conversation_id: "conversation-1",
    });
    metadata.seedReference({
      attachment_id: shared.attachment_id,
      ref_kind: "message",
      ref_id: "message-2",
      conversation_id: "conversation-2",
    });
    metadata.seedReference({
      attachment_id: shared.attachment_id,
      ref_kind: "proposal",
      ref_id: "proposal-1",
      conversation_id: null,
    });
    const protectedResult = await recycleAttachment(deps, { attachment_id: shared.attachment_id });
    assert.equal(protectedResult.status, "referenced");
    await assert.rejects(
      releaseConversationReferences(deps, {
        conversation_id: "conversation-1",
        message_ids: ["message-1"],
        owner_account_id: OWNER_B,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MediaError && error.code === "not_owner");
        return true;
      },
    );
    const released = await releaseConversationReferences(deps, {
      conversation_id: "conversation-1",
      message_ids: ["message-1"],
      owner_account_id: OWNER_A,
    });
    assert.equal(released.released, 1);
    const facts = await metadata.getReferenceFacts(shared.attachment_id);
    assert.equal(facts.observation_refs.length, 4, "draft/needs_input/ai_organized/confirmed 全保护");
    assert.equal(facts.message_refs.length, 1, "其他会话引用仍保护");
    assert.equal(facts.proposal_refs.length, 1, "提案引用仍保护");
  });

  await check("无引用回收：精确删除三个对象并落 deleted", async () => {
    const disposable = await uploadOne(deps, OWNER_A, await pngBuffer());
    const record = await metadata.get(disposable.attachment_id);
    assert.ok(record);
    const objectPaths = [record.object_key, record.thumbnail_key, record.model_key].map((key) =>
      path.join(CHECK_ROOT, ...key.split("/")),
    );
    for (const objectPath of objectPaths) {
      assert.ok((await listFiles(CHECK_ROOT)).includes(objectPath));
    }
    const result = await recycleAttachment(deps, { attachment_id: disposable.attachment_id });
    assert.equal(result.status, "deleted");
    assert.deepEqual(
      result.objects.map((entry) => entry.outcome).sort(),
      ["deleted", "deleted", "deleted"],
    );
    for (const objectPath of objectPaths) {
      assert.ok(!(await listFiles(CHECK_ROOT)).includes(objectPath));
    }
    const after = await metadata.get(disposable.attachment_id);
    assert.equal(after?.status, "deleted");
  });

  await check("引用查询不完整禁止回收", async () => {
    const disposable = await uploadOne(deps, OWNER_A, await pngBuffer());
    const before = (await listFiles(CHECK_ROOT)).length;
    metadata.failNext("getReferenceFacts");
    await assert.rejects(
      recycleAttachment(deps, { attachment_id: disposable.attachment_id }),
      (error: unknown) => {
        assert.ok(error instanceof MediaError && error.code === "reference_query_incomplete");
        return true;
      },
    );
    assert.equal((await listFiles(CHECK_ROOT)).length, before, "查询不完整不得删对象");
    const record = await metadata.get(disposable.attachment_id);
    assert.equal(record?.status, "ready");
  });

  await check("外部删除结果未知：保留 deletion_unknown，可核验后重试", async () => {
    const disposable = await uploadOne(deps, OWNER_A, await pngBuffer());
    const flakyStore = {
      putOnce: store.putOnce.bind(store),
      get: store.get.bind(store),
      delete: async (key: string) =>
        key.endsWith("/thumbnail") ? ("unknown" as const) : store.delete(key),
    };
    const flakyDeps: MediaServiceDeps = { metadata, store: flakyStore, environment: "development" };
    const result = await recycleAttachment(flakyDeps, { attachment_id: disposable.attachment_id });
    assert.equal(result.status, "deletion_unknown");
    const record = await metadata.get(disposable.attachment_id);
    assert.equal(record?.status, "deletion_unknown", "未知结果不得伪装成功或恢复 ready");
    const retry = await recycleAttachment(deps, { attachment_id: disposable.attachment_id });
    assert.equal(retry.status, "deleted");
    const finalRecord = await metadata.get(disposable.attachment_id);
    assert.equal(finalRecord?.status, "deleted");
  });

  await check("回收租约互斥：进行中的回收不可重入", async () => {
    const disposable = await uploadOne(deps, OWNER_A, await pngBuffer());
    const lease = await metadata.beginDeletionLease(disposable.attachment_id);
    assert.equal(lease.outcome, "acquired");
    const second = await recycleAttachment(deps, { attachment_id: disposable.attachment_id });
    assert.equal(second.status, "lease_busy");
    if (lease.outcome === "acquired") {
      await metadata.completeDeletion(disposable.attachment_id, lease.lease_token, "deleted");
    }
  });

  /* ------------------------------- 配置边界 ------------------------------- */

  await check("开发/生产桶身份隔离；前缀不是权限", () => {
    assert.throws(
      () =>
        assertBucketIdentityIsolated(
          { environment: "development", endpoint: "https://bucket.example", bucket: "same" },
          { environment: "production", endpoint: "https://bucket.example", bucket: "same" },
        ),
      (error: unknown) => {
        assert.ok(error instanceof MediaError && error.code === "bucket_identity_not_isolated");
        return true;
      },
    );
    assertBucketIdentityIsolated(
      { environment: "development", endpoint: "https://dev.example", bucket: "dev-bucket" },
      { environment: "production", endpoint: "https://prod.example", bucket: "prod-bucket" },
    );
    const devKey = buildObjectKey({
      environment: "development",
      owner_account_id: OWNER_A,
      attachment_id: "id-1",
      variant: "original",
    });
    const prodKey = buildObjectKey({
      environment: "production",
      owner_account_id: OWNER_A,
      attachment_id: "id-1",
      variant: "original",
    });
    assert.notEqual(devKey, prodKey);
    assert.throws(() => assertSafeObjectKey("../escape"));
    assert.throws(() => assertSafeObjectKey("media//double"));
    assert.throws(() => assertSafeObjectKey("media\\windows"));
    assertShortSignedUrlTtl(60);
    assert.throws(() => assertShortSignedUrlTtl(86400), "长期签名必须拒绝");
    assert.throws(() => assertShortSignedUrlTtl(0));
    assert.throws(() => assertShortSignedUrlTtl(Number.NaN));
  });

  await check("存储配置 fail closed：缺变量返回 null；本地/S3 组装", () => {
    assert.equal(loadMediaStorageConfig({}), null);
    assert.equal(loadMediaStorageConfig({ MEDIA_ENVIRONMENT: "development", MEDIA_STORAGE_MODE: "local" }), null);
    assert.equal(loadMediaStorageConfig({ MEDIA_ENVIRONMENT: "production", MEDIA_STORAGE_MODE: "s3" }), null);
    const local = loadMediaStorageConfig({
      MEDIA_ENVIRONMENT: "development",
      MEDIA_STORAGE_MODE: "local",
      MEDIA_LOCAL_ROOT: CHECK_ROOT,
    });
    assert.ok(local);
    assert.equal(createObjectStore(local) instanceof LocalMediaObjectStore, true);
    const s3 = loadMediaStorageConfig({
      MEDIA_ENVIRONMENT: "production",
      MEDIA_STORAGE_MODE: "s3",
      MEDIA_BUCKET_NAME: "prod-bucket",
      MEDIA_BUCKET_ENDPOINT: "https://prod.example",
      MEDIA_BUCKET_REGION: "auto",
    });
    assert.ok(s3);
    assert.equal(createObjectStore(s3).constructor.name, "S3MediaObjectStore");
    const runtime = createLocalMediaRuntime({ root: CHECK_ROOT, environment: "development" });
    assert.ok(runtime.metadata && runtime.store);
  });

  /* -------------------------------- 收尾 -------------------------------- */

  const leftovers = await listFiles(CHECK_ROOT);
  const summary = {
    passed,
    total: passed + failures.length,
    failures,
    check_root: CHECK_ROOT,
    leftover_objects: leftovers.length,
    metadata_records: metadata.countAttachments(),
    references: metadata.countReferences(),
    audits: metadata.audits().length,
    environment: "development",
    storage: "local-substitute",
    metadata: "in-memory-substitute",
    real_egress: { database: 0, s3: 0, model: 0, search: 0 },
  };
  console.log(JSON.stringify(summary));
  assert.equal(failures.length, 0);
}

async function run(): Promise<void> {
  let cleanupError: string | null = null;
  try {
    await main();
  } catch (error) {
    console.error(`unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
    failures.push("unexpected");
  } finally {
    // 精确清理自有临时目录（按本次创建的身份；不碰其他进程/其他任务的目录）
    try {
      await rm(CHECK_ROOT, { recursive: true, force: true });
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error);
    }
  }
  if (cleanupError !== null) {
    console.error(`cleanup failed: ${cleanupError}`);
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ cleanup: "removed", check_root: CHECK_ROOT }));
  }
  if (failures.length > 0) process.exitCode = 1;
}

void run();
