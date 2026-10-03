import assert from "node:assert/strict";

import {
  CHILD_EVIDENCE_BOOK_FIXTURE,
  CHILD_EVIDENCE_BOOK_LARGE_FIXTURE,
  CHILD_EVIDENCE_BOOK_UNAVAILABLE_FIXTURE,
} from "../src/components/guide/__fixtures__/child-evidence-book-fixture";
import { parseIsoDateStrict } from "../src/lib/format";
import type { ChildEvidenceBook } from "../src/lib/guide/view-types";

/**
 * G3-R1 个人证据册 fixture 自洽检查（离线、纯数据；不写数据库、不调用模型）。
 * 运行：pnpm tsx scripts/check-child-evidence-book-fixtures.ts
 *
 * 覆盖：正式来源落在所选期间内、跨期记录不进入正式计数、unavailable/partial 样本、
 * 同源多片段 key 唯一性、主角与引文主体一致、保健参考产品规则、status_counts 一致、
 * parseIsoDateStrict 拒绝非法日历日期。
 * 本检查不能替代浏览器交互验收（见 surface brief 的 Finish evidence）。
 */

let passed = 0;

function ok(condition: boolean, message: string) {
  assert.ok(condition, message);
  passed += 1;
}

function allItems(book: ChildEvidenceBook) {
  return book.goals.flatMap((goal) => goal.items);
}

function allLinks(book: ChildEvidenceBook) {
  return allItems(book).flatMap((item) => item.links);
}

function inScope(book: ChildEvidenceBook, date: string): boolean {
  if (book.scope.kind === "all_history") return true;
  const { start_date, end_date } = book.scope;
  if (!start_date || !end_date) return false;
  return date >= start_date && date <= end_date;
}

/* 1) 正式来源必须通过核对且落在所选期间内；first/latest 同样受期间约束 */
for (const book of [CHILD_EVIDENCE_BOOK_FIXTURE, CHILD_EVIDENCE_BOOK_LARGE_FIXTURE]) {
  for (const item of allItems(book)) {
    for (const link of item.links.filter((entry) => entry.counts_toward_status)) {
      ok(link.basis.every((basis) => basis.valid), `${item.item.id} 的正式来源必须全部通过核对`);
      for (const basis of link.basis) {
        ok(inScope(book, basis.observed_at), `${item.item.id} 的正式来源 ${basis.observed_at} 必须落在所选期间内`);
      }
    }
    if (item.first_observed_at) ok(inScope(book, item.first_observed_at), `${item.item.id} first_observed_at 必须在期间内`);
    if (item.latest_observed_at) ok(inScope(book, item.latest_observed_at), `${item.item.id} latest_observed_at 必须在期间内`);
  }
}

/* 2) 跨期记录作为审计展示，不进入正式计数，也不降低可靠性 */
const crossPeriod = allItems(CHILD_EVIDENCE_BOOK_FIXTURE).find((item) => item.item.id === "item.ui.social.1.4-5");
assert.ok(crossPeriod, "跨期 fixture 条目必须存在");
ok(crossPeriod.status === "no_records", "跨期条目不得进入正式状态");
ok(crossPeriod.reliability === "reliable", "正常期间排除不等于数据不可靠");
ok(crossPeriod.first_observed_at === null && crossPeriod.latest_observed_at === null, "跨期条目不产生正式证据日期");
ok(
  crossPeriod.links.every((link) => !link.counts_toward_status && link.excluded_reason === "basis_out_of_period"),
  "跨期关联必须标记 basis_out_of_period 且不计入",
);

/* 3) 可靠性样本：unavailable 无可读依据；partial 含未通过核对的资料 */
const unavailableItem = allItems(CHILD_EVIDENCE_BOOK_UNAVAILABLE_FIXTURE).find(
  (item) => item.reliability === "unavailable",
);
assert.ok(unavailableItem, "unavailable 样本必须存在");
ok(unavailableItem.links.length === 0, "unavailable 样本不应伪造可读依据");
const partialItem = allItems(CHILD_EVIDENCE_BOOK_FIXTURE).find((item) => item.reliability === "partial");
assert.ok(partialItem, "partial 样本必须存在");
ok(
  partialItem.links.some((link) => link.basis.some((basis) => !basis.valid)),
  "partial 样本必须包含未通过核对的资料",
);

/* 4) 同源多片段：片段内容不同，key 必须带序号才能唯一 */
const sameSourceLink = allLinks(CHILD_EVIDENCE_BOOK_FIXTURE).find((link) => {
  const ids = link.basis.map((basis) => basis.observation_id);
  return new Set(ids).size < ids.length;
});
assert.ok(sameSourceLink, "同源多片段样本必须存在");
const sameSourceQuotes = sameSourceLink.basis.map((basis) => basis.quote);
ok(new Set(sameSourceQuotes).size === sameSourceQuotes.length, "同源片段内容必须不同");
const keysWithIndex = sameSourceLink.basis.map(
  (basis, index) => `${sameSourceLink.link_id}-${basis.observation_id}-${index}`,
);
ok(new Set(keysWithIndex).size === keysWithIndex.length, "同源片段 key（带序号）不得重复");
const keysWithoutIndex = sameSourceLink.basis.map((basis) => `${sameSourceLink.link_id}-${basis.observation_id}`);
ok(new Set(keysWithoutIndex).size < keysWithoutIndex.length, "同源片段在不带序号时 key 会冲突");

/* 5) 主角与引文主体一致 */
const richQuotes = allLinks(CHILD_EVIDENCE_BOOK_FIXTURE).flatMap((link) => link.basis.map((basis) => basis.quote));
ok(
  richQuotes.every((quote) => !quote.includes("杉杉") && !quote.includes("禾禾")),
  "完整示例引文不得混入其他主角",
);
ok(richQuotes.some((quote) => quote.includes(CHILD_EVIDENCE_BOOK_FIXTURE.child.name)), "完整示例引文应使用主角姓名");
const largeQuotes = allLinks(CHILD_EVIDENCE_BOOK_LARGE_FIXTURE).flatMap((link) => link.basis.map((basis) => basis.quote));
ok(largeQuotes.every((quote) => !quote.includes("小雨")), "大目录引文不得混入其他主角");

/* 6) 保健参考产品规则 */
const healthItem = allItems(CHILD_EVIDENCE_BOOK_FIXTURE).find(
  (item) => item.item.product_rules.evidence_type === "health_reference",
);
assert.ok(healthItem, "保健参考样本必须存在");
ok(healthItem.item.product_rules.counts_in_behavior_stats === false, "保健参考不参与行为统计");

/* 7) status_counts 与条目状态一致 */
for (const book of [
  CHILD_EVIDENCE_BOOK_FIXTURE,
  CHILD_EVIDENCE_BOOK_LARGE_FIXTURE,
  CHILD_EVIDENCE_BOOK_UNAVAILABLE_FIXTURE,
]) {
  const counts = { no_records: 0, has_clues: 0, confirmed_observed: 0 };
  for (const item of allItems(book)) counts[item.status] += 1;
  assert.deepEqual(book.status_counts, counts, "status_counts 必须与条目状态一致");
  passed += 1;
}

/* 8) 日期严格解析：非法日历日期不得通过 */
ok(parseIsoDateStrict("2026-02-30") === null, "2026-02-30 不存在");
ok(parseIsoDateStrict("2026-13-01") === null, "2026-13-01 不存在");
ok(parseIsoDateStrict("2025-02-29") === null, "2025-02-29 不存在");
ok(parseIsoDateStrict("2026-05-01") !== null, "2026-05-01 合法");
ok(parseIsoDateStrict("") === null, "空字符串不合法");

console.log(JSON.stringify({ passed, total: passed, fixture_only: true }));
