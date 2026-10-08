/** Actual presentational components, without a browser/model/DB. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { YayaClarifyPart, YayaReceiptPart, YayaSourcesPart, YayaStoppedPart, YayaToolResultPart } from "../../src/components/yaya/yaya-parts";
import { YAYA_PART_NAMES } from "../../src/components/yaya/client/parts";

let passed = 0;
const delivered = { status: { type: "complete" as const } }; // Part delivery, not a business-success assertion.
function check(name: string, value: unknown) { assert.ok(value, name); passed++; }
const read = renderToStaticMarkup(<YayaToolResultPart {...delivered} type="data" name={YAYA_PART_NAMES.toolResult} data={{ tool: "list_children", outcome: "ok", source_kind: "tool_result" }} />);
check("tool label is readable Chinese", read.includes("幼儿名册") && read.includes("已查询"));
check("technical tool name not used as prose", !read.replace(/data-tool-name="[^"]*"/, "").includes("list_children"));
const failed = renderToStaticMarkup(<YayaToolResultPart {...delivered} type="data" name={YAYA_PART_NAMES.toolResult} data={{ tool: "get_observation", outcome: "failed", source_kind: null }} />);
check("failed query not presented as completed", failed.includes("查询未完成") && !failed.includes("已查询"));
for (const tool of ["unknown", "constructor", "__proto__"]) {
  const body = renderToStaticMarkup(<YayaToolResultPart {...delivered} type="data" name={YAYA_PART_NAMES.toolResult} data={{ tool, outcome: "ok", source_kind: null }} />);
  check("safe unknown tool label " + tool, body.includes("平台资料"));
}
const sources = renderToStaticMarkup(<YayaSourcesPart {...delivered} type="data" name={YAYA_PART_NAMES.sources} data={{ sources: [{ kind: "tool_result", ref_id: "children:current_scope", label: "当前幼儿列表", derived_from: null }] }} />);
check("sources progressively disclosed", sources.startsWith("<details") && !sources.includes(" open="));
check("readable source and audit identity retained", sources.includes("当前幼儿列表") && sources.includes("children:current_scope"));
check("source control has touch target and focus", sources.includes("min-h-11") && sources.includes("focus-visible"));
check("empty sources not fabricated", renderToStaticMarkup(<YayaSourcesPart {...delivered} type="data" name={YAYA_PART_NAMES.sources} data={{ sources: [] }} />) === "");
const clarification = renderToStaticMarkup(<YayaClarifyPart {...delivered} type="data" name={YAYA_PART_NAMES.clarify} data={{ question: "请确认是哪位幼儿？" }} />);
check("clarification complete and safely rendered", clarification.includes("请确认是哪位幼儿？") && clarification.includes("直接在下面回复"));
const unverified = renderToStaticMarkup(<YayaReceiptPart {...delivered} type="data" name={YAYA_PART_NAMES.receipt} data={{ operation_id: "original-operation", outcome: { kind: "unknown", reason: "no_receipt" } }} />);
check("receipt without plan remains unknown", unverified.includes("保存结果未知") && unverified.includes("没有完整原计划") && !unverified.includes("操作已保存"));
check("original operation remains available for readback", unverified.includes("original-operation") && unverified.includes("重新读取核对"));
const stopped = renderToStaticMarkup(<YayaStoppedPart {...delivered} type="data" name={YAYA_PART_NAMES.stopped} data={{ reason: "cancelled", detail: "<script>alert(1)</script>" }} />);
check("cancelled state is not success", stopped.includes("已停止回答") && !stopped.includes("操作已保存"));
check("untrusted detail stays text", stopped.includes("&lt;script&gt;") && !stopped.includes("<script>"));
console.log(JSON.stringify({ passed, total: passed, layer: "actual component static render", browser: false, real_model_requests: 0 }));
