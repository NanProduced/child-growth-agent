import assert from "node:assert/strict";
import { evidenceEntryQuery, evidencePageHref, evidencePageQuery, evidenceQueryString } from "../src/lib/guide/navigation";
import type { EvidenceScope, EvidenceViewFilters } from "../src/lib/guide/view-types";

const filters: EvidenceViewFilters = { domain_code: "health", age_band: "3-4", goal_id: "goal-safe" };
const scope: EvidenceScope = { kind: "semester", semester_id: "2026-term1", label: "本学期", start_date: "2026-09-01", end_date: "2027-01-31", filter_field: "observed_at" };
const semester = new URLSearchParams(evidenceQueryString(scope, filters));
assert.equal(semester.get("semester_id"), "2026-term1");
assert.equal(semester.has("from"), false);
const all = new URLSearchParams(evidenceQueryString({ kind: "all_history" }, filters));
assert.equal(all.get("scope"), "all_history");
assert.equal(all.has("semester_id"), false);
const custom = new URLSearchParams(evidenceQueryString({ kind: "custom_range", from: "2026-09-28", to: "2026-10-04" }, filters));
assert.equal(custom.get("from"), "2026-09-28");
assert.equal(custom.get("to"), "2026-10-04");
const clear = new URLSearchParams(evidenceQueryString(scope, { domain_code: null, age_band: null, goal_id: null }));
assert.equal(clear.has("domain"), false);
assert.equal(clear.has("age_band"), false);
assert.equal(clear.has("goal_id"), false);
assert.equal(new URLSearchParams(evidenceEntryQuery("middle")).get("age_band"), "4-5");
assert.equal(new URLSearchParams(evidenceEntryQuery(null)).has("age_band"), false);
assert.equal(evidencePageQuery({ from: ["2026-09-01", "2026-10-01"], scope: "custom_range" }).from, "2026-09-01");
const retry = new URL(evidencePageHref("/children/test/evidence", {
  scope: "custom_range", from: "2026-09-01", to: "2026-09-30", domain: "health",
  age_band: "3-4", goal_id: "goal-safe", item_id: "item-safe", extra: ["one", "two"],
}), "http://127.0.0.1");
assert.equal(retry.searchParams.get("from"), "2026-09-01");
assert.equal(retry.searchParams.get("to"), "2026-09-30");
assert.equal(retry.searchParams.get("domain"), "health");
assert.equal(retry.searchParams.get("item_id"), "item-safe");
assert.deepEqual(retry.searchParams.getAll("extra"), ["one", "two"]);
assert.equal(evidencePageHref("/classes/test/evidence", {}), "/classes/test/evidence");
console.log(JSON.stringify({ passed: 18, total: 18, offline: true }));
