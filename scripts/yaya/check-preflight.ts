/** Integration counterexamples; pure reference checks, no database/model/network. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  compareBatchReceipts,
  itemsToResend,
  queryOperationOutcome,
  receiptProvesSuccess,
  requiresBusinessTarget,
  YAYA_CONTRACT_FROZEN,
  YAYA_CONTRACT_VERSION,
  type YayaOperationReceipt,
  type YayaPlannedOperation,
  type YayaDomainPayload,
  payloadIsAllOrNothing,
} from "../../src/lib/yaya/types";

const plan: YayaPlannedOperation = {
  batch_id: "batch-1", proposal_id: "proposal-1", item_key: "item-1",
  operation_id: "op-1", target_id: "child-1", actor_account_id: "teacher-1",
};
const saved: YayaOperationReceipt = {
  ...plan, status: "saved", effect: "committed", business_object_id: "observation-1",
  business_revision: "rev-1", recorded_at: "2026-10-05T08:00:00.000Z",
};
const failed: YayaOperationReceipt = {
  ...saved, status: "failed", effect: "none", business_object_id: null, business_revision: null,
};
let passed = 0;
const failures: string[] = [];
function check(name: string, run: () => void): void {
  try { run(); passed++; } catch (error: unknown) {
    failures.push(name);
    console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// A raw failed receipt is not a verified retry decision.
function retryCandidates(receipts: readonly YayaOperationReceipt[]): readonly YayaOperationReceipt[] {
  return itemsToResend([plan], receipts);
}
check("contradictory success/failure never retries", () => {
  const receipts = [saved, failed];
  assert.equal(queryOperationOutcome(receipts, plan).kind, "unknown");
  assert.equal(retryCandidates(receipts).length, 0);
});
check("wrong identity never retries", () => {
  const receipts = [{ ...failed, actor_account_id: "other-teacher" }];
  assert.equal(queryOperationOutcome(receipts, plan).kind, "unknown");
  assert.equal(retryCandidates(receipts).length, 0);
});
check("identical failure retries once", () => {
  assert.equal(retryCandidates([failed, failed]).length, 1);
});
check("empty and blank business IDs do not prove success", () => {
  for (const business_object_id of ["", "   "]) {
    const receipt = { ...saved, business_object_id };
    assert.equal(receiptProvesSuccess(receipt), false);
    assert.equal(compareBatchReceipts([plan], [receipt]).all_saved, false);
    assert.equal(queryOperationOutcome([receipt], plan).kind, "unknown");
  }
});
check("list/catalog authorization does not require an object", () => {
  assert.equal(requiresBusinessTarget({ kind: "scope_query" }), false);
  assert.equal(requiresBusinessTarget(null), false);
});
check("verified no-effect failure remains retryable", () => {
  assert.equal(retryCandidates([failed]).length, 1);
  assert.equal(retryCandidates([saved]).length, 0);
});
check("invalid duplicate plan cannot authorize recovery", () => {
  assert.equal(itemsToResend([plan, plan], [failed]).length, 0);
  assert.equal(itemsToResend([{ ...plan, operation_id: "op-2" }, plan], [failed]).length, 0);
});
check("in-progress and unknown effects never retry", () => {
  for (const receipt of [
    { ...failed, status: "in_progress" as const, effect: "unknown" as const },
    { ...failed, effect: "unknown" as const },
  ]) assert.equal(itemsToResend([plan], [receipt]).length, 0);
});
check("shared core frozen, not a runtime certification", () => {
  assert.equal(YAYA_CONTRACT_FROZEN, true);
  assert.equal(YAYA_CONTRACT_VERSION, "yaya-v1.0");
});
check("new attachment append is explicit and does not overwrite content", () => {
  const payload: YayaDomainPayload = {
    kind: "attach_observation_images", observation_id: "observation-1", image_ids: ["image-1"],
    expected_attachment_revision: 1, source_confirmed_at: "2026-10-05T08:00:00.000Z",
  };
  assert.equal(payloadIsAllOrNothing(payload.kind), true);
  assert.equal("raw_text" in payload || "confirmed_content" in payload, false);
});
const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
check("archive conflict preserves draft but never repeats archive", () => {
  const text = read("docs/design/yaya-v1/recovery-spec.md");
  assert.ok(text.includes("本次归档结束") && text.includes("隐藏同一记录的再次归档入口"));
  assert.ok(!text.includes("自己的内容走新批准"));
});
check("C preview never submits already saved selection", () => {
  for (const file of ["05-direction-c-desktop.md", "06-direction-c-mobile.md"]) {
    const text = read(`docs/design/yaya-v1/prompts/${file}`);
    assert.ok(text.includes("确认已选 1 条") && text.includes("小满"));
    assert.ok(!text.includes("☑ 小满 已保存") && !text.includes("green text 已保存"));
  }
});
check("B drawer is before archive, not after success", () => {
  const text = read("docs/design/yaya-v1/prompts/03-direction-b-desktop.md");
  assert.ok(text.includes("原文已保存，草稿待确认"));
  assert.ok(!text.includes("已确认归档。档案已更新。"));
});
check("safety helper has approved git blob", () => {
  const bytes = readFileSync(new URL("../harness-safety.ts", import.meta.url));
  const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  assert.equal(blob, "6702f2ddf3b436e79f8c92ae8756c33f611a8503");
});
console.log(JSON.stringify({ passed, total: passed + failures.length, failures, reference_only: true }));
assert.equal(failures.length, 0);
