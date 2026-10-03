import {
  CLASS_FIXTURE_HISTORY_SCOPE,
  CLASS_FIXTURE_SEMESTER_SCOPE,
  ITEM_UI_HEALTH_POSTURE_45,
  ITEM_UI_LANGUAGE_SPEAK_34,
  ITEM_UI_SCIENCE_EXPLORE_56,
  ITEM_UI_SOCIAL_PEER_45,
  buildClassEvidenceOverview,
  buildEmptyRosterOverview,
} from "../src/components/guide/__fixtures__/class-evidence-overview-fixture";
import { parseIsoDateStrict } from "../src/lib/format";
import type { ClassGuideItemView, EvidenceScope } from "../src/lib/guide/view-types";

/**
 * G4 班级证据概览 fixture 自检（离线，只读 fixture）。
 * 校验人数分母、比例口径、可靠性分类与证据日期和期间的自治性；
 * 明确不能替代 G5 读模型与真实数据库/API 的运行时验证。
 */

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
}

const CUSTOM_SCOPE: EvidenceScope = {
  kind: "custom_range",
  semester_id: null,
  label: "自定义期间（2026-05-01 至 2026-06-01）",
  start_date: "2026-05-01",
  end_date: "2026-06-01",
  filter_field: "observed_at",
};

const ALL_HISTORY_SCOPE: EvidenceScope = {
  kind: "all_history",
  semester_id: null,
  label: "全部历史",
  start_date: null,
  end_date: null,
  filter_field: "observed_at",
};

function findItem(
  overview: ReturnType<typeof buildClassEvidenceOverview>,
  itemId: string,
): ClassGuideItemView | undefined {
  return overview.goals.flatMap((group) => group.items).find((item) => item.item.id === itemId);
}

const SCOPES: Array<[string, EvidenceScope]> = [
  ["semester", CLASS_FIXTURE_SEMESTER_SCOPE],
  ["history", CLASS_FIXTURE_HISTORY_SCOPE],
  ["custom_range", CUSTOM_SCOPE],
  ["all_history", ALL_HISTORY_SCOPE],
];

for (const [label, scope] of SCOPES) {
  const overview = buildClassEvidenceOverview({ scope });
  const items = overview.goals.flatMap((group) => group.items);
  check(`${label}: 名单分母一致`, items.every((item) => item.total === overview.roster.child_count));
  check(
    `${label}: 三类人数之和=分母`,
    items.every(
      (item) =>
        item.counts.confirmed_observed + item.counts.has_clues + item.counts.no_records === item.total,
    ),
  );
  check(
    `${label}: 儿童逐人覆盖且不重复`,
    items.every(
      (item) =>
        item.children.length === item.total &&
        new Set(item.children.map((child) => child.child_id)).size === item.total,
    ),
  );
  check(
    `${label}: confirmed_ratio 口径`,
    items.every((item) => {
      const eligible =
        item.reliability === "reliable" &&
        item.item.product_rules.counts_in_behavior_stats &&
        item.total > 0;
      return eligible
        ? item.confirmed_ratio === item.counts.confirmed_observed / item.total
        : item.confirmed_ratio === null;
    }),
  );
  const datedChildren = items.flatMap((item) => item.children).filter((child) => child.first_observed_at || child.latest_observed_at);
  check(
    `${label}: 证据日期在所选期间内且顺序正确`,
    datedChildren.every((child) => {
      for (const value of [child.first_observed_at, child.latest_observed_at]) {
        if (!value) continue;
        if (!parseIsoDateStrict(value)) return false;
        if (scope.start_date && value < scope.start_date) return false;
        if (scope.end_date && value > scope.end_date) return false;
      }
      if (child.first_observed_at && child.latest_observed_at && child.latest_observed_at < child.first_observed_at) {
        return false;
      }
      return true;
    }),
  );
}

const main = buildClassEvidenceOverview();
const mainItem = findItem(main, ITEM_UI_LANGUAGE_SPEAK_34);
check("主条目存在且 6/4/10", Boolean(mainItem) && mainItem!.counts.confirmed_observed === 6 && mainItem!.counts.has_clues === 4 && mainItem!.counts.no_records === 10, JSON.stringify(mainItem?.counts));
check("主条目 confirmed_ratio=0.3", mainItem?.confirmed_ratio === 0.3, String(mainItem?.confirmed_ratio));
check(
  "多记录按幼儿去重：2 条证据仍只计 1 人",
  mainItem?.children.some(
    (child) => child.confirmed_link_count === 2 && child.status === "confirmed_observed",
  ) === true && mainItem?.counts.confirmed_observed === 6,
);
check(
  "待核对不计入正式状态",
  mainItem?.children.some(
    (child) => child.pending_suggestion_count === 1 && child.status === "no_records",
  ) === true,
);

const health = findItem(main, ITEM_UI_HEALTH_POSTURE_45);
check(
  "保健参考：不参与行为统计且占比 null",
  health?.item.product_rules.evidence_type === "health_reference" &&
    health?.item.product_rules.counts_in_behavior_stats === false &&
    health?.confirmed_ratio === null,
);
check("保健参考：体态/身高体重示意", /身高.*体重/.test(health?.item.text ?? ""), health?.item.text ?? "");

const mixed = findItem(main, ITEM_UI_SOCIAL_PEER_45);
check("混合条目：整体 partial", mixed?.reliability === "partial", String(mixed?.reliability));
check(
  "混合条目：含不可读取幼儿与核验受限幼儿",
  mixed?.children.some((child) => child.reliability === "unavailable") === true &&
    mixed?.children.some((child) => child.reliability === "partial") === true,
);
check("混合条目：占比 null（下限）", mixed?.confirmed_ratio === null, String(mixed?.confirmed_ratio));

const science = findItem(main, ITEM_UI_SCIENCE_EXPLORE_56);
check(
  "完全不可用：条目与幼儿均为 unavailable 且占比 null",
  science?.reliability === "unavailable" &&
    science?.confirmed_ratio === null &&
    science?.children.every((child) => child.reliability === "unavailable") === true,
);

const filtered = buildClassEvidenceOverview({
  domain_code: "health",
  age_band: "4-5",
  goal_id: "goal.ui.health.2",
});
check(
  "goal_id/领域/年龄段筛选一致",
  filtered.filters.domain_code === "health" &&
    filtered.filters.age_band === "4-5" &&
    filtered.filters.goal_id === "goal.ui.health.2" &&
    filtered.goals.length === 1 &&
    filtered.goals[0].items.length === 1 &&
    filtered.goals[0].items[0].item.id === ITEM_UI_HEALTH_POSTURE_45,
);

const empty = buildEmptyRosterOverview();
check(
  "空名单：0 人且无比例",
  empty.roster.child_count === 0 &&
    empty.goals.every((group) => group.items.every((item) => item.total === 0 && item.confirmed_ratio === null && item.children.length === 0)),
);
check("空名单：empty_roster 通知", empty.notices.some((notice) => notice.code === "empty_roster"));
check(
  "空名单：日期/名单不携带伪造值",
  empty.roster.children.length === 0 && empty.goals.every((group) => group.items.every((item) => item.children.length === 0)),
);

const failed = checks.filter((entry) => !entry.ok);
for (const entry of checks) {
  console.log(`${entry.ok ? "PASS" : "FAIL"} ${entry.name}${entry.ok ? "" : ` :: ${entry.detail}`}`);
}
console.log(JSON.stringify({ passed: checks.length - failed.length, total: checks.length, fixture_only: true }));
process.exit(failed.length === 0 ? 0 : 1);
