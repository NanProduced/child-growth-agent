import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  createCommunicationSchema, resolveCommunicationRange, previousCommunicationMonth, updateCommunicationSchema, communicationViewSchema,
  type CommunicationSource,
} from "../src/lib/family-communication-contract";
import { validateCommunicationModel, validateCommunicationText } from "../src/lib/family-communication";

let passed = 0;
function check(name: string, work: () => void) { work(); passed++; process.stdout.write(`PASS ${name}\n`); }
const child = randomUUID(), sourceId = randomUUID();
const source: CommunicationSource = { id: sourceId, observed_at: "2026-09-02", context: "积木区", raw_text: "桥倒了，她把桥墩挪近，说：这次小车能过去了。", description: "幼儿调整了桥墩的位置。", fingerprint: "a".repeat(64) };
const input = { client_request_id: randomUUID(), child_id: child, period: { kind: "month", value: "2026-09" }, observation_ids: [sourceId], note: "多分享具体尝试" };
async function main() {
check("previous month handles year rollover", () => assert.equal(previousCommunicationMonth("2026-01-09"), "2025-12"));
check("month has explicit inclusive dates", () => assert.deepEqual(resolveCommunicationRange({ kind: "month", value: "2026-09" }, "2026-10-09"), { from: "2026-09-01", to: "2026-09-30", label: "2026年9月" }));
check("leap-month end", () => assert.equal(resolveCommunicationRange({ kind: "month", value: "2024-02" }, "2026-10-09").to, "2024-02-29"));
check("current month stops today", () => assert.equal(resolveCommunicationRange({ kind: "month", value: "2026-10" }, "2026-10-09").to, "2026-10-09"));
check("future month refused", () => assert.throws(() => resolveCommunicationRange({ kind: "month", value: "2027-01" }, "2026-10-09")));
check("semester uses real configured calendar", () => assert.equal(resolveCommunicationRange({ kind: "semester", value: "2026-2027-1" }, "2026-10-09").from, "2026-09-01"));
check("unfinished semester says so", () => assert.ok(resolveCommunicationRange({ kind: "semester", value: "2026-2027-1" }, "2026-10-09").label.includes("截至今天")));
check("unknown semester refused", () => assert.throws(() => resolveCommunicationRange({ kind: "semester", value: "unknown" }, "2026-10-09")));
check("year is last twelve months not school year", () => assert.deepEqual(resolveCommunicationRange({ kind: "year" }, "2026-10-09"), { from: "2025-10-10", to: "2026-10-09", label: "近一年" }));
check("leap-day twelve-month window", () => assert.equal(resolveCommunicationRange({ kind: "year" }, "2024-02-29").from, "2023-03-01"));
check("valid creation wire", () => assert.ok(createCommunicationSchema.safeParse(input).success));
for (const authority of ["principal", "role", "approved", "source_snapshot", "text", "actor_account_id"]) check(`reject ${authority} in request`, () => assert.equal(createCommunicationSchema.safeParse({ ...input, [authority]: "forged" }).success, false));
check("empty sources refused", () => assert.equal(createCommunicationSchema.safeParse({ ...input, observation_ids: [] }).success, false));
check("repeated source refused", () => assert.equal(createCommunicationSchema.safeParse({ ...input, observation_ids: [sourceId, sourceId] }).success, false));
check("more than sixty explicit sources refused", () => assert.equal(createCommunicationSchema.safeParse({ ...input, observation_ids: Array.from({ length: 61 }, () => randomUUID()) }).success, false));
check("update needs version and full text", () => assert.equal(updateCommunicationSchema.safeParse({ action: "review", text: "好" }).success, false));
check("version must fit real DB integer", () => assert.equal(updateCommunicationSchema.safeParse({ expected_revision: 2147483648, action: "review", text: "小禾家长您好，这是一段保留了事实和真实故事的可编辑分享文字。" }).success, false));
const wire = { id: randomUUID(), owner_account_id: randomUUID(), child_id: child, client_request_id: randomUUID(), period: input.period,
  range: { from: "2026-09-01", to: "2026-09-30", label: "九月" }, source_ids: [sourceId], text: "", note: "", author_name: "老师", status: "draft", revision: 1, updated_at: "2026-10-09" };
check("200 empty draft is not success proof", () => assert.equal(communicationViewSchema.safeParse(wire).success, false));
check("pending empty body is legitimate", () => assert.ok(communicationViewSchema.safeParse({ ...wire, status: "generating" }).success));
check("teacher wording passes", () => validateCommunicationText("她把桥墩挪近再试，家里可以一起玩搭桥的游戏。"));
for (const text of ["能力差", "明显进步", "越来越聪明", "每天都主动合作", "有多动症"]) check(`unsupported judgment ${text}`, () => assert.throws(() => validateCommunicationText(text)));
check("other child name removed from parent text", () => assert.throws(() => validateCommunicationText("小禾和陈沐阳一起玩积木。", ["陈沐阳"])));
const story = { observation_id: sourceId, text: "搭桥游戏中，她把桥墩挪近再试，说：“这次小车能过去了”。", quote: "这次小车能过去了" };
const output = { stories: [story], suggestion: "家里也可以一起试试搭桥。" };
check("literal factual source and parent prose", () => assert.equal(validateCommunicationModel(output, [source], []).text, `2026年9月2日，${story.text}\n\n${output.suggestion}`));
check("invented quote fails", () => assert.throws(() => validateCommunicationModel({ ...output, stories: [{ ...story, text: story.text.replace("这次小车能过去了", "我非常厉害"), quote: "我非常厉害" }] }, [source], [])));
check("wrong source identity fails", () => assert.throws(() => validateCommunicationModel({ ...output, stories: [{ ...story, observation_id: randomUUID() }] }, [source], [])));
check("unrelated citation fails", () => assert.throws(() => validateCommunicationModel({ ...output, stories: [{ ...story, quote: "桥倒了" }] }, [source], [])));
check("additional fabricated quoted speech fails", () => assert.throws(() => validateCommunicationModel({ ...output, stories: [{ ...story, text: `${story.text}她又说：“我每天都能独立完成”。` }] }, [source], [])));
const requireFromHere = createRequire(import.meta.url);
const esbuild = createRequire(requireFromHere.resolve("tsup"))("esbuild") as { buildSync(options: Record<string, unknown>): unknown };
esbuild.buildSync({ entryPoints: [fileURLToPath(new URL("../src/lib/family-communication-contract.ts", import.meta.url))], bundle: true, platform: "browser", write: false, logLevel: "silent" });
passed++;
console.log(JSON.stringify({ passed, pure_and_browser_bundle: true, real_model_requests: 0 }));
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
