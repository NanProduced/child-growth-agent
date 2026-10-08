/**
 * YAYA-MEDIA1-R1 反例验收（真实 sharp 上传 + 本地对象 I/O + 内存元数据替身）。
 *
 * 覆盖主评审三个复现的 RED→GREEN 反例与双向时序：
 * A 引用核验与删除租约原子协调（引用先成立/租约先成立/查询与租约之间新增引用/
 *   多引用与共享照片/查询失败与悬空引用/revision 不匹配/未知删除不可引用）；
 * B 上传未知结果不破坏已提交对象（提交前失败/提交后响应丢失/读回失败/
 *   迟到提交交错/补偿删除未知/同键同内容与异内容/混合批次）；
 * C 附图 expected_revision 进入共同原子保存条件（并发同前提一成功一冲突/
 *   部分附件失败不半成功/审计与修订同源/来源前提进入边界/完整性拒绝）。
 *
 * 边界：不连接数据库/真实 S3/模型/搜索；不读 .env；只在本进程与自有临时目录内 I/O。
 *
 * 运行：pnpm exec tsx scripts/yaya/check-media-r1.ts
 */

import assert from "node:assert/strict";
import { mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

import type { Principal } from "../../src/lib/accounts/types";
import { appendObservationImages, type HostObservationFacts } from "../../src/lib/media/attachment-service";
import { buildObjectKey } from "../../src/lib/media/config";
import { MediaError } from "../../src/lib/media/errors";
import { MemoryAttachmentMetadata } from "../../src/lib/media/metadata-memory";
import type { RegisterAttachmentInput } from "../../src/lib/media/metadata-port";
import { LocalMediaObjectStore } from "../../src/lib/media/object-store-local";
import { sha256Hex } from "../../src/lib/media/object-store";
import { recycleAttachment } from "../../src/lib/media/retention-service";
import type { MediaServiceDeps } from "../../src/lib/media/runtime";
import {
  contentAttachmentId,
  deterministicAttachmentId,
  recycledContentAttachmentId,
  uploadImages,
} from "../../src/lib/media/upload-service";

const CHECK_ROOT = path.join(os.tmpdir(), "opencode", `yaya-media1-r1-${process.pid}-${Date.now()}`);
const OWNER_A = "account-teacher-a";
const OWNER_B = "account-teacher-b";

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

function pngBuffer(width = 48, height = 48): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
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

function principalOf(role: "admin" | "teacher", classIds: readonly string[] = []): Principal {
  if (role === "admin") {
    return {
      account_id: "account-admin",
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

async function uploadOne(
  deps: MediaServiceDeps,
  owner: string,
  body: Buffer,
  client: string | null = null,
): Promise<{ attachment_id: string }> {
  const batch = await uploadImages(deps, {
    owner_account_id: owner,
    files: [{ filename: "photo.png", declared_content_type: null, body, client_upload_id: client }],
  });
  const first = batch.uploads[0];
  if (!first || !first.ok) {
    throw new Error(`upload failed: ${first && !first.ok ? `${first.code} ${first.message}` : "missing"}`);
  }
  return { attachment_id: first.attachment.attachment_id };
}

/** 每次需要“全新附件”时使用显式唯一键；无键上传按内容派生身份，同内容会去重。 */
let freshCounter = 0;
async function freshUpload(deps: MediaServiceDeps, owner: string): Promise<{ attachment_id: string }> {
  freshCounter += 1;
  return uploadOne(deps, owner, await pngBuffer(), `r2-fresh-${freshCounter}`);
}

async function main(): Promise<void> {
  await mkdir(CHECK_ROOT, { recursive: true });
  const metadata = new MemoryAttachmentMetadata();
  const store = new LocalMediaObjectStore(CHECK_ROOT);
  const deps: MediaServiceDeps = { metadata, store, environment: "development" };
  const teacherA = principalOf("teacher", ["class-a"]);

  /* ============================ A. 租约原子协调 ============================ */

  await check("A1 引用先成立 → 回收拒绝且对象保留", async () => {
    const image = await freshUpload(deps, OWNER_A);
    metadata.seedObservation("observation-a1", "draft");
    await metadata.linkObservationReferences({
      observation_id: "observation-a1",
      attachment_ids: [image.attachment_id],
      actor_account_id: OWNER_A,
    });
    const before = (await listFiles(CHECK_ROOT)).length;
    const result = await recycleAttachment(deps, { attachment_id: image.attachment_id, actor_account_id: OWNER_A });
    assert.equal(result.status, "referenced");
    assert.equal((await listFiles(CHECK_ROOT)).length, before, "引用存在时不得删对象");
    assert.equal(metadata.statusOf(image.attachment_id), "ready");
  });

  await check("A2 租约先成立 → 新引用（追加/关联）被拒", async () => {
    const image = await freshUpload(deps, OWNER_A);
    const record = await metadata.get(image.attachment_id);
    assert.ok(record);
    const lease = await metadata.beginDeletionLease({
      attachment_id: image.attachment_id,
      expected_revision: record.revision,
    });
    assert.equal(lease.outcome, "acquired");
    await assert.rejects(
      metadata.linkObservationReferences({
        observation_id: "observation-a2",
        attachment_ids: [image.attachment_id],
        actor_account_id: OWNER_A,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MediaError && error.code === "attachment_deleting");
        return true;
      },
    );
    await assert.rejects(
      appendObservationImages(deps, {
        host: hostFacts({ observation_id: "observation-a2" }),
        principal: teacherA,
        image_ids: [image.attachment_id],
        expected_attachment_revision: 0,
        source_confirmed_at: "2026-10-05T08:00:00.000Z",
        request_id: null,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MediaError && error.code === "attachment_deleting");
        return true;
      },
    );
    const facts = await metadata.getReferenceFacts(image.attachment_id);
    assert.equal(facts.observation_refs.length, 0, "租约后不得写入任何引用");
    const after = await metadata.get(image.attachment_id);
    assert.equal(after?.status, "deleting");
  });

  await check("A3 查询与租约之间新增引用 → 租约拒绝、对象保留", async () => {
    const image = await freshUpload(deps, OWNER_A);
    metadata.seedObservation("observation-a3", "draft");
    const before = (await listFiles(CHECK_ROOT)).length;
    metadata.onNextReferenceFacts = () => {
      // 模拟另一操作在前置无引用查询返回之后、租约之前创建观察引用。
      metadata.seedReference({
        attachment_id: image.attachment_id,
        ref_kind: "observation",
        ref_id: "observation-a3",
        conversation_id: null,
      });
    };
    const result = await recycleAttachment(deps, { attachment_id: image.attachment_id, actor_account_id: OWNER_A });
    assert.equal(result.status, "referenced", "前置查询不能单独授权删除");
    assert.equal((await listFiles(CHECK_ROOT)).length, before, "竞态引用必须保护对象");
    assert.equal(metadata.statusOf(image.attachment_id), "ready");
  });

  await check("A4 多引用/共享照片：观察+消息+提案全部保护", async () => {
    const image = await freshUpload(deps, OWNER_A);
    metadata.seedConversation("conversation-a4", OWNER_A);
    for (const [observationId, status] of [
      ["observation-a4-draft", "draft"],
      ["observation-a4-confirmed", "confirmed"],
    ] as const) {
      metadata.seedObservation(observationId, status);
      await metadata.linkObservationReferences({
        observation_id: observationId,
        attachment_ids: [image.attachment_id],
        actor_account_id: OWNER_A,
      });
    }
    metadata.seedReference({
      attachment_id: image.attachment_id,
      ref_kind: "message",
      ref_id: "message-a4",
      conversation_id: "conversation-a4",
    });
    metadata.seedReference({
      attachment_id: image.attachment_id,
      ref_kind: "proposal",
      ref_id: "proposal-a4",
      conversation_id: null,
    });
    assert.equal((await recycleAttachment(deps, { attachment_id: image.attachment_id, actor_account_id: OWNER_A })).status, "referenced");
    const detached = metadata.detachConversationReferences("conversation-a4", OWNER_A);
    assert.equal(detached, 1);
    assert.equal(
      (await recycleAttachment(deps, { attachment_id: image.attachment_id, actor_account_id: OWNER_A })).status,
      "referenced",
      "解除会话引用后观察/提案引用仍保护",
    );
  });

  await check("A5 引用查询失败/悬空引用 → 禁止回收", async () => {
    const image = await freshUpload(deps, OWNER_A);
    const before = (await listFiles(CHECK_ROOT)).length;
    metadata.failNext("getReferenceFacts");
    await assert.rejects(
      recycleAttachment(deps, { attachment_id: image.attachment_id, actor_account_id: OWNER_A }),
      (error: unknown) => {
        assert.ok(error instanceof MediaError && error.code === "reference_query_incomplete");
        return true;
      },
    );
    assert.equal((await listFiles(CHECK_ROOT)).length, before);
    metadata.seedReference({
      attachment_id: image.attachment_id,
      ref_kind: "observation",
      ref_id: "observation-dangling",
      conversation_id: null,
    });
    await assert.rejects(
      recycleAttachment(deps, { attachment_id: image.attachment_id, actor_account_id: OWNER_A }),
      (error: unknown) => {
        assert.ok(error instanceof MediaError && error.code === "reference_query_incomplete");
        return true;
      },
    );
    assert.equal(metadata.statusOf(image.attachment_id), "ready");
    assert.equal((await listFiles(CHECK_ROOT)).length, before, "悬空引用不得导致删除");
  });

  await check("A6 revision 不匹配 → 租约拒绝且不删对象", async () => {
    const image = await freshUpload(deps, OWNER_A);
    const record = await metadata.get(image.attachment_id);
    assert.ok(record);
    const stale = await metadata.beginDeletionLease({
      attachment_id: image.attachment_id,
      expected_revision: record.revision + 5,
    });
    assert.deepEqual(stale, { outcome: "revision_conflict" });
    const before = (await listFiles(CHECK_ROOT)).length;
    metadata.onNextReferenceFacts = () => {
      metadata.bumpAttachmentRevision(image.attachment_id);
    };
    const result = await recycleAttachment(deps, { attachment_id: image.attachment_id, actor_account_id: OWNER_A });
    assert.equal(result.status, "revision_conflict");
    assert.equal((await listFiles(CHECK_ROOT)).length, before, "revision 变化后不得继续删除");
    assert.equal(metadata.statusOf(image.attachment_id), "ready");
  });

  await check("A7 未知删除状态不可新增引用", async () => {
    const image = await freshUpload(deps, OWNER_A);
    const record = await metadata.get(image.attachment_id);
    assert.ok(record);
    const lease = await metadata.beginDeletionLease({
      attachment_id: image.attachment_id,
      expected_revision: record.revision,
    });
    assert.equal(lease.outcome, "acquired");
    if (lease.outcome !== "acquired") return;
    await metadata.failDeletion({
      attachment_id: image.attachment_id,
      expected_revision: lease.record.revision,
    });
    const unknown = await metadata.get(image.attachment_id);
    assert.equal(unknown?.status, "deleting");
    assert.equal(unknown?.delete_result, "unknown");
    await assert.rejects(
      metadata.linkObservationReferences({
        observation_id: "observation-a7",
        attachment_ids: [image.attachment_id],
        actor_account_id: OWNER_A,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MediaError && error.code === "attachment_deleting");
        return true;
      },
    );
    assert.equal((await recycleAttachment(deps, { attachment_id: image.attachment_id, actor_account_id: OWNER_A })).status, "deleted");
  });

  /* ========================== B. 上传未知结果 ========================== */

  await check("B1 提交前失败（对象阶段）：带幂等键保留对象、重试完成", async () => {
    metadata.clearFailpoints();
    const failingStore = {
      putOnce: async (input: { key: string; content_type: string; body: Buffer }) => {
        if (input.key.endsWith("/thumbnail")) {
          throw new MediaError("object_store_unavailable", "store down");
        }
        return store.putOnce(input);
      },
      get: store.get.bind(store),
      delete: store.delete.bind(store),
    };
    const failingDeps: MediaServiceDeps = { metadata, store: failingStore, environment: "development" };
    const before = (await listFiles(CHECK_ROOT)).length;
    const recordsBefore = metadata.countAttachments();
    const batch = await uploadImages(failingDeps, {
      owner_account_id: OWNER_A,
      files: [{ filename: "b1.png", declared_content_type: null, body: await pngBuffer(), client_upload_id: "r1-b1" }],
    });
    const failed = batch.uploads[0];
    assert.ok(failed && !failed.ok && failed.code === "object_store_unavailable");
    assert.equal(metadata.countAttachments(), recordsBefore, "注册未发生");
    assert.equal((await listFiles(CHECK_ROOT)).length, before + 1, "带幂等键的原图对象保留供重试");
    const retry = await uploadOne(deps, OWNER_A, await pngBuffer(), "r1-b1");
    assert.equal(retry.attachment_id, deterministicAttachmentId(OWNER_A, "r1-b1"));
    assert.equal((await listFiles(CHECK_ROOT)).length, before + 3);
  });

  await check("B2 提交后响应丢失：读回恢复、对象保留、重试不重写", async () => {
    metadata.clearFailpoints();
    const before = (await listFiles(CHECK_ROOT)).length;
    metadata.failNext("register_after_commit");
    const batch = await uploadImages(deps, {
      owner_account_id: OWNER_A,
      files: [{ filename: "b2.png", declared_content_type: null, body: await pngBuffer(), client_upload_id: "r1-b2" }],
    });
    const first = batch.uploads[0];
    assert.ok(first && first.ok, "已提交必须恢复原结果");
    const attachmentId = first.attachment.attachment_id;
    assert.equal(attachmentId, deterministicAttachmentId(OWNER_A, "r1-b2"));
    assert.equal(metadata.statusOf(attachmentId), "ready");
    assert.equal((await listFiles(CHECK_ROOT)).length, before + 3);
    const retry = await uploadOne(deps, OWNER_A, await pngBuffer(), "r1-b2");
    assert.equal(retry.attachment_id, attachmentId);
    assert.equal((await listFiles(CHECK_ROOT)).length, before + 3);
  });

  await check("B3 读回也失败：保留对象与可恢复身份，不假成功", async () => {
    metadata.clearFailpoints();
    const before = (await listFiles(CHECK_ROOT)).length;
    // 第一次 get 是幂等前置读（成功）；第二次 get 是注册后的读回（失败）。
    let getCalls = 0;
    const flakyMetadata = new Proxy(metadata, {
      get(target, prop, receiver) {
        if (prop === "get") {
          return async (id: string) => {
            getCalls += 1;
            if (getCalls >= 2) {
              throw new MediaError("metadata_unavailable", "readback down");
            }
            return target.get(id);
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const flakyDeps: MediaServiceDeps = { metadata: flakyMetadata, store, environment: "development" };
    metadata.failNext("register_after_commit");
    const batch = await uploadImages(flakyDeps, {
      owner_account_id: OWNER_A,
      files: [{ filename: "b3.png", declared_content_type: null, body: await pngBuffer(), client_upload_id: "r1-b3" }],
    });
    const first = batch.uploads[0];
    assert.ok(first && !first.ok && first.code === "upload_unknown");
    assert.ok(first.recoverable, "未知结果必须给出可恢复身份");
    assert.equal(first.recoverable.attachment_id, deterministicAttachmentId(OWNER_A, "r1-b3"));
    assert.equal((await listFiles(CHECK_ROOT)).length, before + 3, "读回失败不得破坏对象");
    assert.equal(metadata.statusOf(first.recoverable.attachment_id), "ready", "已提交记录保留");
    const retry = await uploadOne(deps, OWNER_A, await pngBuffer(), "r1-b3");
    assert.equal(retry.attachment_id, first.recoverable.attachment_id);
    assert.equal((await listFiles(CHECK_ROOT)).length, before + 3);
  });

  await check("B4 迟到提交与补偿交错：对象保留，迟到记录可恢复", async () => {
    metadata.clearFailpoints();
    const before = (await listFiles(CHECK_ROOT)).length;
    metadata.failNext("register_late_commit");
    const batch = await uploadImages(deps, {
      owner_account_id: OWNER_A,
      files: [{ filename: "b4.png", declared_content_type: null, body: await pngBuffer(), client_upload_id: "r1-b4" }],
    });
    const first = batch.uploads[0];
    assert.ok(first && !first.ok && first.code === "upload_unknown");
    assert.equal((await listFiles(CHECK_ROOT)).length, before + 3, "迟到提交窗口内不得做破坏性补偿");
    await metadata.settleLateCommit();
    const lateId = deterministicAttachmentId(OWNER_A, "r1-b4");
    assert.equal(metadata.statusOf(lateId), "ready", "迟到提交最终落库");
    const retry = await uploadOne(deps, OWNER_A, await pngBuffer(), "r1-b4");
    assert.equal(retry.attachment_id, lateId);
    assert.equal((await listFiles(CHECK_ROOT)).length, before + 3);
  });

  await check("B5 回收后稳定身份失败：保留共享对象、不宣称清理成功", async () => {
    metadata.clearFailpoints();
    // Recycled identities are deterministic too: a failed sibling never owns
    // exclusive deletion rights. Unknown deletion remains covered by A7.
    const content = await pngBuffer(150, 150);
    const recycled = await uploadOne(deps, OWNER_A, content);
    assert.equal((await recycleAttachment(deps, { attachment_id: recycled.attachment_id, actor_account_id: OWNER_A })).status, "deleted");
    const recordsBefore = metadata.countAttachments();
    const objectsBefore = (await listFiles(CHECK_ROOT)).length;
    let deleteAttempts = 0;
    const unknownStore = {
      putOnce: async (input: { key: string; content_type: string; body: Buffer }) => {
        if (input.key.endsWith("/thumbnail")) {
          throw new MediaError("object_store_unavailable", "store down");
        }
        return store.putOnce(input);
      },
      get: store.get.bind(store),
      delete: async (key: string) => {
          deleteAttempts++;
        if (key.endsWith("/original")) return "unknown" as const;
        return store.delete(key);
      },
    };
    const unknownDeps: MediaServiceDeps = { metadata, store: unknownStore, environment: "development" };
    const batch = await uploadImages(unknownDeps, {
      owner_account_id: OWNER_A,
      files: [{ filename: "b5.png", declared_content_type: null, body: content, client_upload_id: null }],
    });
    const first = batch.uploads[0];
    assert.ok(first && !first.ok && first.code === "object_store_unavailable");
    assert.equal(metadata.countAttachments(), recordsBefore);
    assert.equal(deleteAttempts, 0, "failed request cannot delete objects shared by a stable identity");
    assert.equal((await listFiles(CHECK_ROOT)).length, objectsBefore + 1, "partial original remains retryable");
    const retry = await uploadOne(deps, OWNER_A, content);
    assert.equal(retry.attachment_id, recycledContentAttachmentId(OWNER_A, sha256Hex(content), recycled.attachment_id));
    assert.equal(metadata.countAttachments(), recordsBefore + 1);
    assert.equal((await listFiles(CHECK_ROOT)).length, objectsBefore + 3, "retry completes the same object family without orphan duplication");
  });

  await check("B6 同键同内容恢复；同键异内容明确冲突", async () => {
    metadata.clearFailpoints();
    const before = (await listFiles(CHECK_ROOT)).length;
    const first = await uploadOne(deps, OWNER_A, await pngBuffer(), "r1-b6");
    assert.equal((await listFiles(CHECK_ROOT)).length, before + 3);
    const replay = await uploadOne(deps, OWNER_A, await pngBuffer(), "r1-b6");
    assert.equal(replay.attachment_id, first.attachment_id, "同键同内容恢复原结果");
    assert.equal((await listFiles(CHECK_ROOT)).length, before + 3, "恢复不重写对象");
    const conflictBody = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .png()
      .toBuffer();
    const batch = await uploadImages(deps, {
      owner_account_id: OWNER_A,
      files: [{ filename: "b6b.png", declared_content_type: null, body: conflictBody, client_upload_id: "r1-b6" }],
    });
    const conflict = batch.uploads[0];
    assert.ok(conflict && !conflict.ok && conflict.code === "idempotency_conflict");
    assert.equal((await listFiles(CHECK_ROOT)).length, before + 3, "冲突不得静默复用或新增对象");
    const record = await metadata.get(first.attachment_id);
    assert.equal(record?.status, "ready", "原记录不被冲突请求改写");
  });

  await check("B7 混合批次：一张未知不清空其余图片与文字", async () => {
    metadata.clearFailpoints();
    const middleId = deterministicAttachmentId(OWNER_A, "r1-b7-mid");
    const middleOriginalKey = buildObjectKey({
      environment: "development",
      owner_account_id: OWNER_A,
      attachment_id: middleId,
      variant: "original",
    });
    const mixedStore = {
      putOnce: async (input: { key: string; content_type: string; body: Buffer }) => {
        if (input.key === middleOriginalKey) {
          throw new MediaError("object_store_unavailable", "store down for one file");
        }
        return store.putOnce(input);
      },
      get: store.get.bind(store),
      delete: store.delete.bind(store),
    };
    const mixedDeps: MediaServiceDeps = { metadata, store: mixedStore, environment: "development" };
    const batch = await uploadImages(mixedDeps, {
      owner_account_id: OWNER_A,
      files: [
        { filename: "b7a.png", declared_content_type: null, body: await pngBuffer(), client_upload_id: "r1-b7-a" },
        { filename: "b7b.png", declared_content_type: null, body: await pngBuffer(), client_upload_id: "r1-b7-mid" },
        { filename: "b7c.png", declared_content_type: null, body: await pngBuffer(), client_upload_id: "r1-b7-c" },
      ],
    });
    assert.equal(batch.uploads.length, 3);
    assert.equal(batch.uploads[0]?.ok, true);
    const middle = batch.uploads[1];
    assert.ok(middle && !middle.ok && middle.code === "object_store_unavailable");
    assert.equal(batch.uploads[2]?.ok, true);
    const retryMiddle = await uploadOne(deps, OWNER_A, await pngBuffer(), "r1-b7-mid");
    assert.equal(retryMiddle.attachment_id, middleId);
  });

  /* ========================== C. 附图原子条件 ========================== */

  await check("C1 并发同 expected_revision：一成功一明确冲突", async () => {
    metadata.clearFailpoints();
    metadata.seedObservation("observation-c1", "confirmed", "2026-10-05T08:00:00.000Z");
    const image = await freshUpload(deps, OWNER_A);
    const input = {
      host: hostFacts({ observation_id: "observation-c1" }),
      principal: teacherA,
      image_ids: [image.attachment_id],
      expected_attachment_revision: 0,
      source_confirmed_at: "2026-10-05T08:00:00.000Z",
      request_id: null,
    };
    const settled = await Promise.allSettled([
      appendObservationImages(deps, input),
      appendObservationImages(deps, input),
    ]);
    const fulfilled = settled.filter((entry) => entry.status === "fulfilled").length;
    const rejected = settled.filter(
      (entry): entry is PromiseRejectedResult => entry.status === "rejected",
    );
    const rejectedReasons = rejected.map((entry) =>
      entry.reason instanceof MediaError ? entry.reason.code : String(entry.reason),
    );
    assert.equal(fulfilled, 1, `only one append may succeed; rejected=${rejectedReasons.join(",")}`);
    assert.equal(rejected.length, 1);
    assert.ok(
      rejected[0]?.reason instanceof MediaError && rejected[0].reason.code === "revision_conflict",
    );
    assert.equal(await metadata.getObservationAttachmentRevision("observation-c1"), 1, "revision-after-append");
    const facts = await metadata.getReferenceFacts(image.attachment_id);
    assert.equal(facts.observation_refs.length, 1, "refs-after-append");
  });

  await check("C2 部分附件不可用：不产生半成功引用与修订", async () => {
    metadata.clearFailpoints();
    metadata.seedObservation("observation-c2", "confirmed", "2026-10-05T08:00:00.000Z");
    const first = await freshUpload(deps, OWNER_A);
    const second = await freshUpload(deps, OWNER_A);
    const secondRecord = await metadata.get(second.attachment_id);
    assert.ok(secondRecord);
    const lease = await metadata.beginDeletionLease({
      attachment_id: second.attachment_id,
      expected_revision: secondRecord.revision,
    });
    assert.equal(lease.outcome, "acquired");
    await assert.rejects(
      appendObservationImages(deps, {
        host: hostFacts({ observation_id: "observation-c2" }),
        principal: teacherA,
        image_ids: [first.attachment_id, second.attachment_id],
        expected_attachment_revision: 0,
        source_confirmed_at: "2026-10-05T08:00:00.000Z",
        request_id: null,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MediaError && error.code === "attachment_deleting");
        return true;
      },
    );
    assert.equal(await metadata.getObservationAttachmentRevision("observation-c2"), 0);
    const facts = await metadata.getReferenceFacts(first.attachment_id);
    assert.equal(facts.observation_refs.length, 0, "后一附件失败不得留下前一附件的引用");
    assert.equal(metadata.audits().filter((entry) => entry.observation_id === "observation-c2").length, 0);
  });

  await check("C3 引用、修订与审计同一原子边界（含来源前提）", async () => {
    metadata.clearFailpoints();
    metadata.seedObservation("observation-c3", "confirmed", "2026-10-05T08:00:00.000Z");
    const referencesBefore = metadata.countReferences();
    const first = await freshUpload(deps, OWNER_A);
    const second = await freshUpload(deps, OWNER_A);
    const result = await appendObservationImages(deps, {
      host: hostFacts({ observation_id: "observation-c3" }),
      principal: teacherA,
      image_ids: [first.attachment_id, second.attachment_id],
      expected_attachment_revision: 0,
      source_confirmed_at: "2026-10-05T08:00:00.000Z",
      request_id: "req-c3",
    });
    assert.equal(result.attachment_revision, 1);
    const audits = metadata
      .audits()
      .filter((entry) => entry.observation_id === "observation-c3");
    assert.equal(audits.length, 2, "每个附件一条追加审计");
    for (const audit of audits) {
      assert.equal(audit.attachment_revision, 1);
      assert.equal(audit.source_confirmed_at, "2026-10-05T08:00:00.000Z");
      assert.equal(audit.request_id, "req-c3");
    }
    assert.equal(metadata.countReferences(), referencesBefore + 2);
  });

  await check("C4 来源前提不一致：端口原子边界不被调用、修订不变", async () => {
    metadata.seedObservation("observation-c4", "confirmed", "2026-10-05T08:00:00.000Z");
    const image = await freshUpload(deps, OWNER_A);
    await assert.rejects(
      appendObservationImages(deps, {
        host: hostFacts({ observation_id: "observation-c4" }),
        principal: teacherA,
        image_ids: [image.attachment_id],
        expected_attachment_revision: 0,
        source_confirmed_at: "2026-10-04T00:00:00.000Z",
        request_id: null,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MediaError && error.code === "source_conflict");
        return true;
      },
    );
    assert.equal(await metadata.getObservationAttachmentRevision("observation-c4"), 0);
    assert.equal(metadata.audits().filter((entry) => entry.observation_id === "observation-c4").length, 0);
  });

  await check("C5 登记完整性：缺 checksum/尺寸一律拒绝，不默认 ready", async () => {
    const incomplete: RegisterAttachmentInput = {
      attachment_id: "incomplete-1",
      owner_account_id: OWNER_A,
      object_key: "media/dev/x/incomplete-1/original",
      thumbnail_key: "media/dev/x/incomplete-1/thumbnail",
      model_key: "media/dev/x/incomplete-1/model",
      content_type: "image/png",
      byte_size: 10,
      checksum_sha256: "",
      thumbnail_checksum: "t",
      model_checksum: "m",
      width: 10,
      height: 10,
      source_checksum: "s",
      client_upload_id: null,
    };
    await assert.rejects(
      metadata.registerAttachment(incomplete),
      (error: unknown) => {
        assert.ok(error instanceof MediaError && error.code === "invalid_request");
        return true;
      },
    );
    assert.equal(metadata.statusOf("incomplete-1"), null);
  });

  await check("C6 管理员/越权/非本人追加仍拒绝（原子边界不绕过授权）", async () => {
    metadata.seedObservation("observation-c6", "confirmed", "2026-10-05T08:00:00.000Z");
    const image = await freshUpload(deps, OWNER_A);
    const host = hostFacts({ observation_id: "observation-c6" });
    await assert.rejects(
      appendObservationImages(deps, {
        host,
        principal: principalOf("admin"),
        image_ids: [image.attachment_id],
        expected_attachment_revision: 0,
        source_confirmed_at: host.confirmed_at,
        request_id: null,
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "forbidden_role");
        return true;
      },
    );
    await assert.rejects(
      appendObservationImages(deps, {
        host,
        principal: {
          account_id: OWNER_B,
          username: "teacher.b",
          display_name: "教师B",
          role: "teacher",
          account_status: "active",
          scope: { kind: "classes", class_ids: ["class-a"] },
        },
        image_ids: [image.attachment_id],
        expected_attachment_revision: 0,
        source_confirmed_at: host.confirmed_at,
        request_id: null,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MediaError && error.code === "not_owner");
        return true;
      },
    );
    assert.equal(await metadata.getObservationAttachmentRevision("observation-c6"), 0);
  });

  /* ==================== D. R2 评审复现（无键恢复/回应核对/宿主前提） ==================== */

  await check("D1 无键未知上传：同一输入重试按内容身份恢复", async () => {
    metadata.clearFailpoints();
    const body = await pngBuffer(300, 200);
    const contentId = contentAttachmentId(OWNER_A, sha256Hex(body));
    const beforeFiles = (await listFiles(CHECK_ROOT)).length;
    const recordsBefore = metadata.countAttachments();
    metadata.failNext("register_before");
    const first = await uploadImages(deps, {
      owner_account_id: OWNER_A,
      files: [{ filename: "d1.png", declared_content_type: null, body, client_upload_id: null }],
    });
    const firstResult = first.uploads[0];
    assert.ok(firstResult && !firstResult.ok && firstResult.code === "upload_unknown");
    assert.equal(firstResult.recoverable?.attachment_id, contentId, "可恢复身份必须稳定可推导");
    assert.equal(metadata.countAttachments(), recordsBefore);
    assert.equal((await listFiles(CHECK_ROOT)).length, beforeFiles + 3, "未知结果保留对象");
    const retry = await uploadImages(deps, {
      owner_account_id: OWNER_A,
      files: [{ filename: "d1.png", declared_content_type: null, body, client_upload_id: null }],
    });
    const retryResult = retry.uploads[0];
    assert.ok(retryResult?.ok, "同一输入重试必须恢复原身份，不新建操作");
    assert.equal(retryResult.attachment.attachment_id, contentId);
    assert.equal(metadata.countAttachments(), recordsBefore + 1, "恢复为唯一记录");
    assert.equal((await listFiles(CHECK_ROOT)).length, beforeFiles + 3, "对象不重复");
  });

  await check("D2 注册正常返回但非 ready：不显示成功、保留对象", async () => {
    class BadAck extends MemoryAttachmentMetadata {
      override async registerAttachment(input: RegisterAttachmentInput) {
        const record = await super.registerAttachment(input);
        return { ...record, status: "deleting" as const };
      }
    }
    const badMetadata = new BadAck();
    const badDeps: MediaServiceDeps = { metadata: badMetadata, store, environment: "development" };
    const before = (await listFiles(CHECK_ROOT)).length;
    const batch = await uploadImages(badDeps, {
      owner_account_id: OWNER_A,
      files: [{ filename: "d2.png", declared_content_type: null, body: await pngBuffer(), client_upload_id: "r2-bad-ack" }],
    });
    const result = batch.uploads[0];
    assert.ok(result && !result.ok, "非 ready 回应不得显示成功");
    assert.equal(!result.ok && result.code, "attachment_gone");
    assert.equal((await listFiles(CHECK_ROOT)).length, before + 3, "对象保留，不做破坏性补偿");
    const stored = await badMetadata.get(deterministicAttachmentId(OWNER_A, "r2-bad-ack"));
    assert.equal(stored?.status, "ready", "存储记录不被回应伪造改写");
  });

  await check("D3 宿主前提在保存边界变化：拒绝且零写入", async () => {
    class ChangedHost extends MemoryAttachmentMetadata {
      changeOnRead = false;
      override async get(id: string) {
        const record = await super.get(id);
        if (this.changeOnRead) {
          this.changeOnRead = false;
          this.seedObservation("observation-d3", "draft");
        }
        return record;
      }
    }
    const hostMetadata = new ChangedHost();
    const hostDeps: MediaServiceDeps = { metadata: hostMetadata, store, environment: "development" };
    hostMetadata.seedObservation("observation-d3", "confirmed", "2026-10-05T08:00:00.000Z");
    const image = await uploadOne(hostDeps, OWNER_A, await pngBuffer(), "r2-d3");
    hostMetadata.changeOnRead = true;
    await assert.rejects(
      appendObservationImages(hostDeps, {
        host: hostFacts({ observation_id: "observation-d3" }),
        principal: teacherA,
        image_ids: [image.attachment_id],
        expected_attachment_revision: 0,
        source_confirmed_at: "2026-10-05T08:00:00.000Z",
        request_id: "req-d3",
      }),
      (error: unknown) => {
        assert.ok(error instanceof MediaError && error.code === "observation_not_confirmed");
        return true;
      },
    );
    assert.equal(await hostMetadata.getObservationAttachmentRevision("observation-d3"), 0, "修订不得写入");
    assert.equal(hostMetadata.countReferences(), 0, "引用不得写入");
    assert.equal(hostMetadata.audits().length, 0, "审计不得写入");
  });

  await check("D4 宿主确认来源在保存边界变化：source_conflict 零写入", async () => {
    class ChangedSource extends MemoryAttachmentMetadata {
      changeOnRead = false;
      override async get(id: string) {
        const record = await super.get(id);
        if (this.changeOnRead) {
          this.changeOnRead = false;
          this.seedObservation("observation-d4", "confirmed", "2026-10-06T00:00:00.000Z");
        }
        return record;
      }
    }
    const sourceMetadata = new ChangedSource();
    const sourceDeps: MediaServiceDeps = { metadata: sourceMetadata, store, environment: "development" };
    sourceMetadata.seedObservation("observation-d4", "confirmed", "2026-10-05T08:00:00.000Z");
    const image = await uploadOne(sourceDeps, OWNER_A, await pngBuffer(), "r2-d4");
    sourceMetadata.changeOnRead = true;
    await assert.rejects(
      appendObservationImages(sourceDeps, {
        host: hostFacts({ observation_id: "observation-d4" }),
        principal: teacherA,
        image_ids: [image.attachment_id],
        expected_attachment_revision: 0,
        source_confirmed_at: "2026-10-05T08:00:00.000Z",
        request_id: "req-d4",
      }),
      (error: unknown) => {
        assert.ok(error instanceof MediaError && error.code === "source_conflict");
        return true;
      },
    );
    assert.equal(await sourceMetadata.getObservationAttachmentRevision("observation-d4"), 0);
    assert.equal(sourceMetadata.countReferences(), 0);
    assert.equal(sourceMetadata.audits().length, 0);
  });

  await check("D5 无键上传内容绑定：同内容去重、异内容不同身份", async () => {
    metadata.clearFailpoints();
    const body = await pngBuffer(320, 210);
    const before = (await listFiles(CHECK_ROOT)).length;
    const first = await uploadOne(deps, OWNER_A, body);
    const second = await uploadOne(deps, OWNER_A, body);
    assert.equal(second.attachment_id, first.attachment_id, "同内容同身份，不重复上传");
    assert.equal((await listFiles(CHECK_ROOT)).length, before + 3);
    const other = await pngBuffer(321, 210);
    const third = await uploadOne(deps, OWNER_A, other);
    assert.notEqual(third.attachment_id, first.attachment_id, "异内容不同身份");
    assert.equal((await listFiles(CHECK_ROOT)).length, before + 6);
  });

  const leftovers = await listFiles(CHECK_ROOT);
  const summary = {
    passed,
    total: passed + failures.length,
    failures,
    check_root: CHECK_ROOT,
    leftover_objects: leftovers.length,
    metadata_records: metadata.countAttachments(),
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
