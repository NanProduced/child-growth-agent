/**
 * YAYA-DATA1-R1 纯函数反例检查（先行编写；在当前实现上实际失败为 RED，修复后 GREEN）。
 *
 * 覆盖：
 * - A：损坏/缺失标题来源不得被当作“无来源手工标题”；对外投影必须移除原始 title；
 *     非 full 片段的 provenance 必须脱敏。
 * - B：附件引用写入的稳定锁序与租约状态机口径（pending/deletion_unknown）。
 * - D：媒体端口状态映射与租约令牌语义。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  attachmentLeaseTransition,
  conversationTitleSourceState,
  mapMediaAttachmentStatus,
  mediaAttachmentLeaseTransition,
  redactProvenanceForVisibility,
  sortAttachmentLockIds,
} from "../../src/lib/yaya/data/invariants";
import { toConversationView } from "../../src/lib/yaya/data/rows";
import type { YayaSourceRef } from "../../src/lib/yaya/types";

let passed = 0;
const failures: string[] = [];
function check(name: string, run: () => void): void {
  try {
    run();
    passed++;
  } catch (error: unknown) {
    failures.push(name);
    console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function requireFunction(name: string, value: unknown): void {
  assert.equal(typeof value, "function", `${name} 尚未实现（R1 待补齐）`);
}

const PRIVATE = "PRIVATE_CHILD_NAME_AND_FACT";

/* ------------------------------ A：标题来源状态 ------------------------------ */

check("标题来源状态：合法数组 / 空 / 损坏 / 缺失", () => {
  requireFunction("conversationTitleSourceState", conversationTitleSourceState);
  assert.equal(conversationTitleSourceState(["f-1"]), "valid");
  assert.equal(conversationTitleSourceState([]), "none");
  assert.equal(conversationTitleSourceState(['{"bad":1}']), "valid");
  assert.equal(conversationTitleSourceState({ bad: true }), "corrupt");
  assert.equal(conversationTitleSourceState("not-array"), "corrupt");
  assert.equal(conversationTitleSourceState([1, 2]), "corrupt");
  assert.equal(conversationTitleSourceState(null), "missing");
  assert.equal(conversationTitleSourceState(undefined), "missing");
});

check("存储视图：损坏/缺失 title_source_fragments 不得默认成空数组", () => {
  const corrupt = toConversationView({
    id: "conv-1",
    account_id: "acct-1",
    title: PRIVATE,
    title_source_fragments: { bad: true },
    revision: 1,
    created_at: "2026-10-05T00:00:00.000Z",
    updated_at: "2026-10-05T00:00:00.000Z",
    deleted_at: null,
  });
  assert.equal(corrupt.title_source_fragments, null, `损坏来源必须表达为 null（受限），不得是 []`);
  const missing = toConversationView({
    id: "conv-2",
    account_id: "acct-1",
    title: PRIVATE,
    title_source_fragments: null,
    revision: 1,
    created_at: "2026-10-05T00:00:00.000Z",
    updated_at: "2026-10-05T00:00:00.000Z",
    deleted_at: null,
  });
  assert.equal(missing.title_source_fragments, null);
  const valid = toConversationView({
    id: "conv-3",
    account_id: "acct-1",
    title: PRIVATE,
    title_source_fragments: ["f-1"],
    revision: 1,
    created_at: "2026-10-05T00:00:00.000Z",
    updated_at: "2026-10-05T00:00:00.000Z",
    deleted_at: null,
  });
  assert.deepEqual(valid.title_source_fragments, ["f-1"]);
});

/* ------------------------------ A：provenance 脱敏 ------------------------------ */

check("非 full 片段不得携带 provenance.label/ref_id/derived_from", () => {
  requireFunction("redactProvenanceForVisibility", redactProvenanceForVisibility);
  const provenance: YayaSourceRef = {
    kind: "child_fact",
    ref_id: "obs-secret",
    label: PRIVATE,
    derived_from: "raw-secret",
  };
  assert.equal(redactProvenanceForVisibility("hidden", provenance), null);
  assert.equal(redactProvenanceForVisibility("historical_read_only", provenance), null);
  assert.deepEqual(redactProvenanceForVisibility("full", provenance), provenance);
  assert.equal(redactProvenanceForVisibility("full", null), null);
});

/* ------------------------------ B：锁序 ------------------------------ */

check("附件锁序：去重并按 id 稳定排序", () => {
  requireFunction("sortAttachmentLockIds", sortAttachmentLockIds);
  assert.deepEqual(sortAttachmentLockIds(["att-b", "att-a", "att-b"]), ["att-a", "att-b"]);
  assert.deepEqual(sortAttachmentLockIds([]), []);
});

check("内部租约状态机保持 ready→deleting CAS（旧口径不回归）", () => {
  const begin = attachmentLeaseTransition(
    { status: "ready", revision: 3, delete_result: null },
    { action: "begin", expected_revision: 3 },
  );
  assert.deepEqual(begin, { ok: true, next: { status: "deleting", revision: 4, delete_result: null } });
  const unknown = attachmentLeaseTransition(
    { status: "deleting", revision: 4, delete_result: null },
    { action: "fail_delete", expected_revision: 4 },
  );
  assert.deepEqual(unknown, { ok: true, next: { status: "deleting", revision: 5, delete_result: "unknown" } });
});

/* ------------------------------ D：媒体端口映射 ------------------------------ */

check("媒体端口状态映射：pending/deleting/null/unknown/deleted", () => {
  requireFunction("mapMediaAttachmentStatus", mapMediaAttachmentStatus);
  assert.equal(mapMediaAttachmentStatus("pending", null), "pending");
  assert.equal(mapMediaAttachmentStatus("ready", null), "ready");
  assert.equal(mapMediaAttachmentStatus("deleting", null), "deleting");
  assert.equal(mapMediaAttachmentStatus("deleting", "unknown"), "deletion_unknown");
  assert.equal(mapMediaAttachmentStatus("deleted", "deleted"), "deleted");
});

check("媒体端口租约：ready 与 deletion_unknown 都可获取租约，pending 不可", () => {
  requireFunction("mediaAttachmentLeaseTransition", mediaAttachmentLeaseTransition);
  const ready = mediaAttachmentLeaseTransition(
    { status: "ready", delete_result: null, deletion_lease_id: null },
    { action: "begin", lease_token: "lease-1" },
  );
  assert.deepEqual(ready, {
    ok: true,
    next: { status: "deleting", delete_result: null, deletion_lease_id: "lease-1" },
  });
  const unknown = mediaAttachmentLeaseTransition(
    { status: "deleting", delete_result: "unknown", deletion_lease_id: null },
    { action: "begin", lease_token: "lease-2" },
  );
  assert.deepEqual(unknown, {
    ok: true,
    next: { status: "deleting", delete_result: null, deletion_lease_id: "lease-2" },
  });
  const busy = mediaAttachmentLeaseTransition(
    { status: "deleting", delete_result: null, deletion_lease_id: "lease-x" },
    { action: "begin", lease_token: "lease-3" },
  );
  assert.deepEqual(busy, { ok: false, reason: "already_deleting" });
  const pending = mediaAttachmentLeaseTransition(
    { status: "pending", delete_result: null, deletion_lease_id: null },
    { action: "begin", lease_token: "lease-4" },
  );
  assert.deepEqual(pending, { ok: false, reason: "not_ready" });
  const deleted = mediaAttachmentLeaseTransition(
    { status: "deleted", delete_result: "deleted", deletion_lease_id: null },
    { action: "begin", lease_token: "lease-5" },
  );
  assert.deepEqual(deleted, { ok: false, reason: "already_deleted" });
});

check("媒体端口租约完成：令牌核对；unknown 不恢复 ready，failed 才回 ready", () => {
  requireFunction("mediaAttachmentLeaseTransition", mediaAttachmentLeaseTransition);
  const wrong = mediaAttachmentLeaseTransition(
    { status: "deleting", delete_result: null, deletion_lease_id: "lease-a" },
    { action: "complete", lease_token: "lease-b", outcome: "deleted" },
  );
  assert.deepEqual(wrong, { ok: false, reason: "lease_mismatch" });
  const unknown = mediaAttachmentLeaseTransition(
    { status: "deleting", delete_result: null, deletion_lease_id: "lease-a" },
    { action: "complete", lease_token: "lease-a", outcome: "unknown" },
  );
  assert.deepEqual(unknown, {
    ok: true,
    next: { status: "deleting", delete_result: "unknown", deletion_lease_id: null },
  });
  const failed = mediaAttachmentLeaseTransition(
    { status: "deleting", delete_result: null, deletion_lease_id: "lease-a" },
    { action: "complete", lease_token: "lease-a", outcome: "failed" },
  );
  assert.deepEqual(failed, {
    ok: true,
    next: { status: "ready", delete_result: null, deletion_lease_id: null },
  });
  const deleted = mediaAttachmentLeaseTransition(
    { status: "deleting", delete_result: null, deletion_lease_id: "lease-a" },
    { action: "complete", lease_token: "lease-a", outcome: "deleted" },
  );
  assert.deepEqual(deleted, {
    ok: true,
    next: { status: "deleted", delete_result: "deleted", deletion_lease_id: null },
  });
});

check("harness blob 保持 6702f2ddf3b436e79f8c92ae8756c33f611a8503", () => {
  const bytes = readFileSync(new URL("../harness-safety.ts", import.meta.url));
  const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  assert.equal(blob, "6702f2ddf3b436e79f8c92ae8756c33f611a8503");
});

console.log(JSON.stringify({ passed, total: passed + failures.length, failures, data_layer: true, r1: true }));
assert.equal(failures.length, 0);
