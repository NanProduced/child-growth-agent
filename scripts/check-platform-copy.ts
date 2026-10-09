/** COPY2: static editorial/boundary checks; not teacher usability or real-model evidence. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file: string): string => fs.readFileSync(path.join(root, file), "utf8");
const paths = [
  "src/app/observations/new/new-observation-client.tsx", "src/app/observations/[id]/review/review-client.tsx",
  "src/app/observations/page.tsx", "src/app/children/new/page.tsx", "src/app/children/page.tsx",
  "src/app/children/[id]/page.tsx", "src/app/classes/page.tsx", "src/app/classes/[id]/page.tsx",
  "src/app/reports/page.tsx", "src/app/activities/page.tsx", "src/app/error.tsx",
  "src/components/read-failure-notice.tsx", "src/components/growth-profile-retry.tsx",
  "src/components/activity-support-section.tsx", "src/components/yaya/yaya-parts.tsx",
  "src/components/yaya/yaya-recovery.tsx", "src/components/yaya/yaya-proposal.tsx",
];
let passed = 0;
function check(name: string, condition: boolean): void { assert.ok(condition, name); passed += 1; }
function literals(source: string): string[] {
  const values: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node) || ts.isStringLiteral(node)) values.push(node.text.replace(/\s+/g, " ").trim());
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile("view.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
  return values;
}
const banned = /不可改写的追溯依据|结构化分析卡片|当前未配置教师口令|AUTH_TRUSTED_ORIGINS|访客模式可浏览档案|少量建议|真实证据里长出来|Agent 修改审核|回执缺少完整成功证明|原运行尚未得到可核验的终态|当前内容先根据已确认观察呈现/;
for (const file of paths) {
  check(`${file}: targeted static noise removed (not generated or teacher content)`, !literals(read(file)).some((text) => banned.test(text)));
}
const intake = read(paths[0]);
check("observation original remains bound unchanged", intake.includes("value={rawText}") && intake.includes("raw_text: rawText.trim()"));
check("immutable original warning remains near input", intake.includes("原文保存后不能修改"));
check("same-class same-name choice retains birth date and UUID", intake.includes("other.class_id === c.class_id") && intake.includes("formatDateCn(c.birth_date)") && intake.includes("value={c.id}"));
const review = read(paths[1]);
check("AI draft remains labelled before teacher confirmation", review.includes("AI 整理草稿（教师可修改）") && review.includes("确认后才归档"));
check("original and two content versions retained", ["{observation.raw_text}", "draft={aiDraft}", "draft={confirmedContent}"].every((text) => review.includes(text)));
check("uncertain archive lock and original reconciliation retained", review.includes("confirmLockReason") && review.includes("reconcileConfirmResult()") && review.includes("archiveCommitted"));
const states = read("src/components/status-badges.tsx");
check("draft label is consistent", states.includes("已保存 · 待整理") && read(paths[2]).includes("label: '待整理'"));
const failure = read("src/components/read-failure-notice.tsx");
check("four read states remain distinct", ["login", "denied", "unavailable", "error"].every((kind) => failure.includes(`"${kind}"`)));
check("outage does not ask for passwords", failure.includes("暂时无法核对账号") && !failure.includes("输入账号密码"));
const parts = read("src/components/yaya/yaya-parts.tsx");
check("success is still decided by proven receipt", parts.includes("receiptShowsSuccess(outcome)") && parts.includes("reconcileOriginalOperationQuery("));
check("unknown results only query the original identity", parts.includes("queryOriginalOperation(data.operation_id, expectedPlan)") && parts.includes("不会自动重复提交"));
check("stop does not imply rollback", parts.includes("停止回答不会撤销已经保存的内容"));
const recovery = read("src/components/yaya/yaya-recovery.tsx");
check("history does not execute old approvals", recovery.includes("receiptProvesSuccess(outcome.receipt)") && recovery.includes("mark.operations.map") && !recovery.includes("executeApprovedOperations("));
const sharing = read("src/components/family-communication/workspace.tsx");
check("copy explicitly means teacher has checked text, not automatic sending", sharing.includes("我已核对，复制文字") && sharing.includes("可自行发给家长") && sharing.includes('save("review")'));
check("editing keeps full text and signature", sharing.includes("value={text}") && !sharing.includes('text.replace("'));
check("editor has bounded reading measure", read("src/components/family-communication/workspace.module.css").includes("max-inline-size: 70ch"));
check("guide quote mapping changes label, not field or quoted content", read("src/components/guide/guide-association-section.tsx").includes('choice.quote_field === "highlight_quote" ? "确认稿 · 原文摘录" : choice.label'));
console.log(JSON.stringify({ passed, total: passed, static_only: true, real_model_requests: 0, teacher_usability: "NOT_RUN" }));
