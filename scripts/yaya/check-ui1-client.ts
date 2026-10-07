/**
 * YAYA-UI1 纯函数检查（离线，不接真实 API / 不调用模型）。
 *
 * 覆盖：NDJSON 流消费守门、Markdown 安全渲染、消息↔投影映射、
 * 提案计划与执行回执语义核验、错误分层文案。
 * 运行：pnpm tsx scripts/yaya/check-ui1-client.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { assessYayaOperationsExecutionResponse } from "../../src/lib/yaya/api-contract";
import { receiptProvesSuccess, type YayaOperationQueryOutcome } from "../../src/lib/yaya/types";
import type { ThreadMessage } from "@assistant-ui/react";

import { yayaApiErrorToPart, yayaAttachmentIdFromUrl, YayaApiError } from "../../src/components/yaya/client/api";
import { planFromProjection, reconcileOriginalOperationQuery } from "../../src/components/yaya/client/actions";
import {
  collectUserFacts,
  composeRunUserText,
  persistShape,
  projectedToThreadMessageLike,
} from "../../src/components/yaya/client/mapping";
import { YAYA_PART_NAMES } from "../../src/components/yaya/client/parts";
import type { ProjectedProposal } from "../../src/components/yaya/client/schemas";
import { readYayaRunStream } from "../../src/components/yaya/client/wire";
import { parseYayaInline, parseYayaMarkdown } from "../../src/components/yaya/yaya-markdown";
import { proposalPayloadIsReviewable } from "../../src/components/yaya/yaya-proposal";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(path.join(here, "__fixtures__", "yaya-ui-fixtures.json"), "utf8")
) as Record<string, never>;

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}${detail === "" ? "" : ` :: ${detail}`}`);
  }
}

function ndjson(lines: readonly unknown[]): Response {
  return new Response(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

function malformedDetail(result: Awaited<ReturnType<typeof readYayaRunStream>>): string {
  return !result.ok && result.kind === "malformed" ? result.detail : "";
}

const abort = new AbortController().signal;

async function streamChecks(): Promise<void> {
  const answerEvents = fixtures["answer_stream"] as unknown as unknown[];
  const seen: string[] = [];
  const answer = await readYayaRunStream(ndjson(answerEvents), abort, (event) => {
    seen.push(event.type);
  });
  check("valid answer stream ok", answer.ok === true);
  check(
    "valid answer stream outcome answered",
    answer.ok && answer.outcome.kind === "answered" && answer.outcome.content.includes("小满"),
    JSON.stringify(!answer.ok ? answer : answer.outcome.kind)
  );
  check("run_end not delivered to onEvent", seen.length === answerEvents.length - 1 && !seen.includes("run_end"), String(seen.length));

  const badJson = await readYayaRunStream(new Response('{"protocol":"yaya-run-events-v1"}\nnot-json\n'), abort);
  check("bad json line rejected", !badJson.ok && badJson.kind === "malformed");

  const wrongProtocol = await readYayaRunStream(
    ndjson([{ protocol: "yaya-run-events-v2", run_id: "r", seq: 1, type: "run_started" }]),
    abort
  );
  check("unsupported protocol rejected", !wrongProtocol.ok && wrongProtocol.kind === "malformed");

  const gapEvents = [
    { protocol: "yaya-run-events-v1", run_id: "r", seq: 1, type: "run_started" },
    { protocol: "yaya-run-events-v1", run_id: "r", seq: 5, type: "answer", content: "x", sources: [] },
    { protocol: "yaya-run-events-v1", run_id: "r", seq: 6, type: "run_end", outcome: { kind: "answered", content: "x", sources: [] } },
  ];
  const gap = await readYayaRunStream(ndjson(gapEvents), abort);
  check("sequence gap rejected", !gap.ok && gap.kind === "malformed" && gap.detail.includes("seq"), malformedDetail(gap));

  const duplicateTerminal = [
    { protocol: "yaya-run-events-v1", run_id: "r", seq: 1, type: "run_started" },
    { protocol: "yaya-run-events-v1", run_id: "r", seq: 2, type: "run_end", outcome: { kind: "stopped", reason: "cancelled", detail: "已取消" } },
    { protocol: "yaya-run-events-v1", run_id: "r", seq: 3, type: "run_end", outcome: { kind: "stopped", reason: "cancelled", detail: "已取消" } },
  ];
  const dup = await readYayaRunStream(ndjson(duplicateTerminal), abort);
  check("duplicate terminal rejected", !dup.ok && dup.kind === "malformed");

  const afterTerminal = [
    { protocol: "yaya-run-events-v1", run_id: "r", seq: 1, type: "run_started" },
    { protocol: "yaya-run-events-v1", run_id: "r", seq: 2, type: "run_end", outcome: { kind: "stopped", reason: "cancelled", detail: null } },
    { protocol: "yaya-run-events-v1", run_id: "r", seq: 3, type: "stopped", reason: "cancelled", detail: null },
  ];
  const after = await readYayaRunStream(ndjson(afterTerminal), abort);
  check("event after terminal rejected", !after.ok && after.kind === "malformed");

  const contradictory = [
    { protocol: "yaya-run-events-v1", run_id: "r", seq: 1, type: "run_started" },
    { protocol: "yaya-run-events-v1", run_id: "r", seq: 2, type: "answer", content: "A", sources: [] },
    { protocol: "yaya-run-events-v1", run_id: "r", seq: 3, type: "run_end", outcome: { kind: "answered", content: "B", sources: [] } },
  ];
  const contra = await readYayaRunStream(ndjson(contradictory), abort);
  check("contradictory terminal rejected", !contra.ok && contra.kind === "malformed");

  const proposal = await readYayaRunStream(ndjson(fixtures["proposal_stream"] as unknown as unknown[]), abort);
  check(
    "proposal stream ok with proposal identity",
    proposal.ok &&
      proposal.outcome.kind === "proposed" &&
      proposal.outcome.proposals[0]?.proposal_id === "prop-fixture-1",
    malformedDetail(proposal)
  );

  const receipt = await readYayaRunStream(ndjson(fixtures["receipt_unknown_stream"] as unknown as unknown[]), abort);
  check(
    "receipt unknown stream: outcome unknown, not success",
    receipt.ok &&
      receipt.events.some(
        (event) => event.type === "receipt" && event.outcome.kind === "unknown"
      ),
    malformedDetail(receipt)
  );

  const http = await readYayaRunStream(new Response("{}", { status: 503 }), abort);
  check("http failure returns http kind", !http.ok && http.kind === "http" && http.status === 503);
}

function markdownChecks(): void {
  const scriptText = "前文 <script>window.__yayaXss = true</script> 后文";
  const blocks = parseYayaMarkdown(scriptText);
  check(
    "raw html stays text",
    blocks.length === 1 && blocks[0]?.type === "paragraph" && blocks[0].text === scriptText
  );
  const scriptTokens = parseYayaInline(scriptText);
  check(
    "no executable inline tokens for html",
    scriptTokens.every((token) => token.type === "text" || token.type === "strong" || token.type === "em")
  );

  const dangerous = parseYayaInline("[危险链接](javascript:alert(1)) 之后");
  check(
    "javascript link not rendered as link",
    dangerous.every((token) => token.type !== "link") &&
      dangerous.map((token) => ("text" in token ? token.text : "")).join("").includes("危险链接")
  );

  const safe = parseYayaInline("看 [可靠来源](https://example.com/guides) 页");
  check(
    "https link rendered with href",
    safe.some((token) => token.type === "link" && token.href === "https://example.com/guides")
  );

  const longLine = "长".repeat(1500);
  const longBlocks = parseYayaMarkdown(longLine);
  check(
    "long answer content preserved",
    longBlocks.length === 1 && longBlocks[0]?.type === "paragraph" && longBlocks[0].text.length === 1500
  );

  const list = parseYayaMarkdown("标题\n\n- 一\n- 二\n\n1. 甲\n2. 乙");
  check(
    "lists parsed",
    list.some((block) => block.type === "list" && block.ordered === false && block.items.length === 2) &&
      list.some((block) => block.type === "list" && block.ordered === true && block.items.length === 2)
  );
}

function messageChecks(): void {
  const userMessage = {
    id: "u1",
    role: "user",
    createdAt: new Date("2026-10-06T00:00:00.000Z"),
    status: { type: "complete", reason: "stop" },
    metadata: { custom: {} },
    attachments: [],
    content: [
      { type: "text", text: "帮我记一条小满的观察。" },
      {
        type: "image",
        image: "/api/yaya/uploads/att-1/content?variant=thumbnail",
        filename: "a.png",
      },
    ],
  } as unknown as ThreadMessage;
  const userShape = persistShape(userMessage);
  check(
    "user persist keeps raw_input provenance and attachment id",
    userShape !== null &&
      userShape.fragments.length === 1 &&
      userShape.fragments[0]?.provenance.kind === "raw_input" &&
      userShape.attachmentIds[0] === "att-1" &&
      userShape.messageKind === "mixed",
    JSON.stringify(userShape)
  );
  const facts = collectUserFacts(userMessage);
  check("collectUserFacts extracts text and attachment", facts.text.includes("小满") && facts.attachmentIds.length === 1);

  check("run text unchanged without context", composeRunUserText("原文", undefined) === "原文");
  const withContext = composeRunUserText("原文", { object: "小满", source: "观察草稿" });
  check(
    "run text carries context before raw text",
    withContext.startsWith("（本条消息上下文：对象=小满；来源=观察草稿）") && withContext.endsWith("原文")
  );
  check("run text keeps empty text with attachments", composeRunUserText("", { object: "小满" }) === "");

  const proposalMessage = {
    id: "a1",
    role: "assistant",
    createdAt: new Date("2026-10-06T00:00:00.000Z"),
    status: { type: "complete", reason: "stop" },
    metadata: { custom: {} },
    attachments: [],
    content: [
      { type: "text", text: "已准备好一张观察卡。", status: { type: "complete" } },
      {
        type: "data",
        name: YAYA_PART_NAMES.proposal,
        data: { proposal_id: "prop-1", proposal_origin: "model_suggestion" },
      },
    ],
  } as unknown as ThreadMessage;
  const proposalShape = persistShape(proposalMessage);
  check(
    "assistant proposal persists pending_approval without authorization fields",
    proposalShape !== null &&
      proposalShape.executionState === "pending_approval" &&
      proposalShape.messageKind === "tool_result" &&
      !JSON.stringify(proposalShape).includes("approved"),
    JSON.stringify(proposalShape)
  );

  const successReceiptMessage = {
    id: "a2",
    role: "assistant",
    createdAt: new Date("2026-10-06T00:00:00.000Z"),
    status: { type: "complete", reason: "stop" },
    metadata: { custom: {} },
    attachments: [],
    content: [
      {
        type: "data",
        name: YAYA_PART_NAMES.receipt,
        data: {
          operation_id: "op-1",
          outcome: {
            kind: "saved",
            receipt: {
              batch_id: "b",
              proposal_id: "p",
              item_key: "i",
              operation_id: "op-1",
              target_id: "t",
              actor_account_id: "teacher-1",
              status: "saved",
              effect: "committed",
              business_object_id: "obs-1",
              business_revision: "1",
              recorded_at: "2026-10-06T00:00:00.000Z",
            },
          },
        },
      },
    ],
  } as unknown as ThreadMessage;
  const receiptShape = persistShape(successReceiptMessage);
  check(
    "assistant saved receipt persists executed and tool_result summary",
    receiptShape !== null &&
      receiptShape.executionState === "executed" &&
      receiptShape.fragments[0]?.provenance.kind === "tool_result" &&
      (receiptShape.fragments[0]?.text ?? "").includes("op-1"),
    JSON.stringify(receiptShape)
  );

  const restricted = projectedToThreadMessageLike({
    message_id: "h1",
    conversation_id: "c1",
    owner_account_id: "teacher-1",
    role: "assistant",
    message_kind: "text",
    execution_state: "unknown",
    revision: 1,
    created_at: "2026-10-06T00:00:00.000Z",
    projection: {
      visibility: "partial",
      fragments: [],
      attachments: [],
      metadata: null,
      execution_allowed: false,
    },
    fragments: [],
    attachment_ids: [],
    metadata: null,
  } as never);
  check(
    "restricted history renders note, not content",
    restricted !== null &&
      Array.isArray(restricted.content) &&
      restricted.content.some((part) => part.type === "data" && part.name === YAYA_PART_NAMES.historyNote) &&
      restricted.content.some((part) => part.type === "data" && part.name === YAYA_PART_NAMES.historyState)
  );

  const metadataOnlyUser = projectedToThreadMessageLike({
    message_id: "h2",
    conversation_id: "c1",
    owner_account_id: "teacher-1",
    role: "user",
    message_kind: "image",
    execution_state: "none",
    revision: 1,
    created_at: "2026-10-06T00:00:00.000Z",
    projection: {
      visibility: "metadata_only",
      fragments: [],
      attachments: [
        { attachment_id: "att-9", readable: false, metadata_only: true, reason: "metadata_only_historical" },
      ],
      metadata: null,
      execution_allowed: false,
    },
    fragments: [],
    attachment_ids: ["att-9"],
    metadata: null,
  } as never);
  check(
    "history metadata_only attachment not rendered as image",
    metadataOnlyUser !== null &&
      Array.isArray(metadataOnlyUser.content) &&
      metadataOnlyUser.content.some(
        (part) => part.type === "text" && part.text.includes("仅保留元数据")
      ) &&
      metadataOnlyUser.content.every((part) => part.type !== "image")
  );
}

function identityChecks(): void {
  check(
    "attachment url roundtrip",
    yayaAttachmentIdFromUrl("/api/yaya/uploads/att-123/content?variant=thumbnail") === "att-123"
  );
  check("remote url rejected", yayaAttachmentIdFromUrl("https://evil.example.com/a.png") === null);
  check("javascript url rejected", yayaAttachmentIdFromUrl("javascript:alert(1)") === null);

  const error404 = yayaApiErrorToPart(new YayaApiError(404, "not_found", "x"));
  const error503 = yayaApiErrorToPart(new YayaApiError(503, "identity_unavailable", "x"));
  const errorNetwork = yayaApiErrorToPart(new YayaApiError(0, "network_error", "x"));
  check("404 maps to not_wired", error404.stage === "not_wired" && error404.message.includes("尚未接通"));
  check("503 keeps service unavailable", error503.stage === "http" && error503.message.includes("暂时不可用"));
  check("status 0 maps to network", errorNetwork.stage === "network" && errorNetwork.status === null);
}

function proposalChecks(): void {
  const proposal = fixtures["proposal_projection"] as unknown as { proposal: ProjectedProposal };
  const projection = proposal.proposal;
  const plan = planFromProjection(projection, { accountId: "teacher-1", role: "teacher", displayName: "测试教师" }, [
    "op-fixture-c1",
  ]);
  check(
    "plan only includes selected items",
    plan.length === 1 && plan[0]?.operation_id === "op-fixture-c1" && plan[0]?.actor_account_id === "teacher-1"
  );

  const success = assessYayaOperationsExecutionResponse(plan, fixtures["operations_success"]);
  check(
    "success receipts assessed as saved",
    success.ok &&
      success.value.outcomes[0]?.outcome.kind === "saved" &&
      receiptProvesSuccess(
        (fixtures["operations_success"] as unknown as { receipts: never[] }).receipts[0]
      ),
    !success.ok ? JSON.stringify(success.violations) : ""
  );

  const unverified = assessYayaOperationsExecutionResponse(plan, fixtures["operations_unverified"]);
  check(
    "unverified success rejected (effect=unknown)",
    !unverified.ok && unverified.violations.some((violation) => violation.code === "unverified_success"),
    JSON.stringify(!unverified.ok ? unverified.violations : unverified.value.comparison)
  );

  const missing = assessYayaOperationsExecutionResponse(
    [...plan, { ...plan[0]!, operation_id: "op-other", item_key: "other" }],
    fixtures["operations_success"]
  );
  check(
    "missing receipt rejected (response_incomplete)",
    !missing.ok && missing.violations.some((violation) => violation.code === "response_incomplete")
  );

  const savedOutcome = (fixtures["operations_query_saved"] as unknown as {
    operation: { outcome: YayaOperationQueryOutcome };
  }).operation.outcome;
  const wrongOperation = reconcileOriginalOperationQuery("op-fixture-1", {
    operation_id: "wrong-operation",
    outcome: savedOutcome,
  }, null);
  check(
    "wrong operation identity stays unknown",
    wrongOperation.outcome.kind === "unknown" && wrongOperation.outcome.reason === "identity_mismatch",
    JSON.stringify(wrongOperation)
  );

  const withoutPlan = reconcileOriginalOperationQuery(
    "op-fixture-1",
    { operation_id: "op-fixture-1", outcome: savedOutcome },
    null
  );
  check(
    "receipt without original plan stays verification_required",
    withoutPlan.outcome.kind === "unknown" && withoutPlan.outcome.reason === "verification_required",
    JSON.stringify(withoutPlan)
  );

  const wrongReceipt = reconcileOriginalOperationQuery(
    "op-fixture-c1",
    {
      operation_id: "op-fixture-c1",
      outcome: {
        kind: "saved",
        receipt: {
          ...(fixtures["operations_success"] as unknown as { receipts: Record<string, unknown>[] }).receipts[0],
          target_id: "child-other",
        },
      } as YayaOperationQueryOutcome,
    },
    plan[0]
  );
  check(
    "wrong receipt plan identity stays unknown",
    wrongReceipt.outcome.kind === "unknown" && wrongReceipt.outcome.reason === "identity_mismatch",
    JSON.stringify(wrongReceipt)
  );

  check(
    "unknown proposal payload is not reviewable",
    !proposalPayloadIsReviewable({ kind: "future_action", target_id: "child-1" })
  );
  check(
    "damaged confirmation payload is not reviewable",
    !proposalPayloadIsReviewable({ kind: "confirm_observation", observation_id: "obs-1", input: {} })
  );
}

async function main(): Promise<void> {
  await streamChecks();
  markdownChecks();
  messageChecks();
  identityChecks();
  proposalChecks();
  console.log(`\ncheck-ui1-client: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main().catch((error) => {
  console.error("check-ui1-client crashed:", error);
  process.exit(1);
});


