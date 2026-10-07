import assert from "node:assert/strict";

import type { AuthState, Principal } from "../src/lib/accounts/types";
import { FIXTURE_PRIMARY_ACTION_CASES } from "../src/lib/home-v2/__fixtures__/contract-fixtures";
import {
  buildHomeV2Data, type HomeClassSource, type HomeObservationSource, type HomeRosterSource, type HomeV2Sources,
} from "../src/lib/home-v2/data";
import type { HomeV2Data } from "../src/lib/home-v2/types";
import type { ObservationStatus } from "../src/lib/types";

let passed = 0;
function check(name: string, run: () => void): void {
  try { run(); passed += 1; }
  catch (error: unknown) { throw new Error(name, { cause: error }); }
}

const classes: HomeClassSource[] = [
  { id: "small-a", name: "A班", stage: "small", school_year: "2026-2027", is_active: true },
  { id: "small-b", name: "B班", stage: "small", school_year: "2026-2027", is_active: false },
  { id: "middle", name: "中班", stage: "middle", school_year: "2026-2027", is_active: true },
  { id: "large", name: "大班", stage: "large", school_year: "2026-2027", is_active: true },
];
const teacher: Principal = { account_id: "teacher", username: "teacher", display_name: "李老师", role: "teacher",
  account_status: "active", scope: { kind: "classes", class_ids: classes.map((row) => row.id) } };
const admin: Principal = { ...teacher, account_id: "admin", username: "admin", display_name: "管理员", role: "admin",
  scope: { kind: "school", school_id: "school" } };
const auth = (principal = teacher): AuthState => ({ kind: "authenticated", principal });
const snapshot = { class_id: "small-a", class_name: "发生时的班名", stage: "small", school_year: "2025-2026",
  captured_at: "2026-01-01T00:00:00.000Z", source: "enrollment_lookup" };

function observation(id: string, status: ObservationStatus = "ai_organized", overrides: Partial<HomeObservationSource> = {}): HomeObservationSource {
  return { observation_id: id, child_id: `child-${id}`, child_name: "幼儿", current_class_id: "small-a",
    occurrence_snapshot: snapshot, observed_at: "2026-09-29", created_at: "2026-09-29T08:00:00.000Z",
    context: "区域活动", excerpt: "幼儿搭好了积木桥。", status, is_demo: true, ...overrides };
}
function sources(overrides: Partial<HomeV2Sources> = {}): HomeV2Sources {
  return { classes, roster: [{ child_id: "current-child", current_class_id: "small-a" }],
    confirmations: [], supplements: [], organizes: [], recent: [], ...overrides };
}
function noPrivateData(home: HomeV2Data): void {
  assert.equal(home.scope, null);
  assert.deepEqual(home.class_groups, []);
  assert.deepEqual(home.pending, []);
  assert.deepEqual(home.recent, []);
}
function noSensitiveFields(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(noSensitiveFields); return; }
  if (typeof value !== "object" || value === null) return;
  for (const [key, nested] of Object.entries(value)) {
    assert.ok(!["raw_text", "password", "password_hash", "token", "token_hash", "csrf", "current_class_id",
      "occurrence_snapshot", "guide_evidence", "percentage", "association_total"].includes(key), `forbidden DTO field ${key}`);
    noSensitiveFields(nested);
  }
}

check("guest ignores supplied private sources", () => {
  const home = buildHomeV2Data({ kind: "anonymous" }, sources({ confirmations: [observation("private")] }));
  assert.equal(home.viewer.kind, "logged_out");
  assert.equal(home.primary_action.label, "园所账号登录");
  assert.equal(home.primary_action.href, "/login");
  noPrivateData(home);
});
for (const reason of ["expired", "revoked", "unknown_token", "legacy_cookie_not_accepted"] as const) {
  check(`invalid session ${reason} is logged out`, () => {
    const home = buildHomeV2Data({ kind: "invalid_session", reason }, sources());
    assert.equal(home.viewer.kind, "logged_out");
    assert.equal(home.primary_action.code, "login");
    noPrivateData(home);
  });
}
check("unavailable identity does not become anonymous or empty statistics", () => {
  const home = buildHomeV2Data({ kind: "unavailable", reason: "identity_service_unavailable" }, sources());
  assert.equal(home.viewer.kind, "identity_unavailable");
  assert.equal(home.primary_action.code, "retry");
  assert.equal(home.pending_counts.confirmations, null);
  assert.equal(home.notices[0].code, "identity_unavailable");
  noPrivateData(home);
});
check("disabled account has no private projection", () => {
  for (const principal of [teacher, admin]) {
    const home = buildHomeV2Data(auth({ ...principal, account_status: "disabled" }), sources());
    assert.equal(home.viewer.kind, "logged_out");
    noPrivateData(home);
  }
});
check("incompatible role/scope fails closed", () => {
  for (const principal of [{ ...teacher, scope: admin.scope }, { ...admin, scope: teacher.scope }]) {
    const home = buildHomeV2Data(auth(principal), sources());
    assert.equal(home.viewer.kind, "identity_unavailable");
    noPrivateData(home);
  }
});
check("teacher none/empty scope contacts admin and ignores all private sources", () => {
  for (const scope of [{ kind: "none", reason: "no_assignment" }, { kind: "none", reason: "no_business_scope" },
    { kind: "classes", class_ids: [] }] as const) {
    const home = buildHomeV2Data(auth({ ...teacher, scope: scope.kind === "classes" ? { ...scope, class_ids: [] } : scope }), sources());
    assert.equal(home.viewer.kind, "teacher");
    assert.equal(home.scope?.class_count, 0);
    assert.equal(home.scope?.child_count, 0);
    assert.equal(home.primary_action.code, "await_class_assignment");
    assert.ok(home.primary_action.helper.includes("管理员"));
    assert.notEqual(home.primary_action.href, "/classes/new");
    assert.deepEqual(home.class_groups, []);
    assert.deepEqual(home.pending, []);
    assert.deepEqual(home.recent, []);
    assert.equal(home.notices[0].code, "scope_empty");
  }
});
check("admin gets all school classes and management, with no teaching feed", () => {
  const home = buildHomeV2Data(auth(admin), sources({ confirmations: [observation("admin-pending")],
    recent: [observation("admin-recent", "confirmed")] }));
  assert.equal(home.viewer.kind, "admin");
  assert.equal(home.scope?.kind, "school");
  assert.equal(home.scope?.class_count, 4);
  assert.equal(home.primary_action.code, "manage_school");
  assert.equal(home.primary_action.href, "/classes");
  assert.deepEqual(home.pending, []);
  assert.deepEqual(home.recent, []);
  assert.deepEqual(home.pending_counts, { availability: "available", confirmations: 0, supplements: 0, organizes: 0 });
  assert.ok(home.class_groups.flatMap((group) => group.classes).every((row) => row.confirmation_count === 0));
});
check("stage groups retain multiple classes and inactive flag", () => {
  const home = buildHomeV2Data(auth(), sources({ classes: [...classes].reverse() }));
  assert.deepEqual(home.class_groups.map((group) => group.stage), ["small", "middle", "large"]);
  assert.equal(home.class_groups[0].classes.length, 2);
  assert.equal(home.class_groups[0].classes[1].is_active, false);
});
check("current enrollment roster is deduplicated globally and per class", () => {
  const roster: HomeRosterSource[] = [
    { child_id: "a", current_class_id: "small-a" }, { child_id: "a", current_class_id: "small-a" },
    { child_id: "b", current_class_id: "small-a" }, { child_id: "c", current_class_id: "middle" },
    { child_id: "a", current_class_id: "small-b" },
  ];
  const home = buildHomeV2Data(auth(), sources({ roster }));
  assert.equal(home.scope?.child_count, 3);
  assert.deepEqual(home.class_groups.flatMap((group) => group.classes).map((row) => row.child_count), [2, 1, 1, 0]);
});
check("pending categories and uncapped actual counts", () => {
  const confirmations = Array.from({ length: 94 }, (_, index) => observation(`confirm-${index}`));
  const supplements = Array.from({ length: 3 }, (_, index) => observation(`supplement-${index}`, "needs_input"));
  const organizes = Array.from({ length: 4 }, (_, index) => observation(`draft-${index}`, "draft"));
  const roster = Array.from({ length: 54 }, (_, index) => ({ child_id: `child-${index}`, current_class_id: "small-a" }));
  const home = buildHomeV2Data(auth(), sources({ roster, confirmations: [...confirmations, confirmations[0]], supplements, organizes }));
  assert.equal(home.scope?.child_count, 54);
  assert.equal(home.pending_counts.confirmations, 94);
  assert.equal(home.pending_counts.supplements, 3);
  assert.equal(home.pending_counts.organizes, 4);
  assert.equal(home.pending.length, 101);
  assert.equal(home.class_groups[0].classes[0].confirmation_count, 94);
  assert.equal(home.primary_action.code, "process_confirmations");
});
check("historical-only rows excluded; current responsible prior-class history remains", () => {
  const oneClass: Principal = { ...teacher, scope: { kind: "classes", class_ids: ["middle"] } };
  const history = observation("prior-class", "ai_organized", { current_class_id: "middle" });
  const departed = observation("departed", "ai_organized", { current_class_id: "large" });
  const unassigned = observation("unassigned", "ai_organized", { current_class_id: null });
  const home = buildHomeV2Data(auth(oneClass), sources({ classes: [classes[2]], roster: null,
    confirmations: [history, departed, unassigned], recent: [history, departed, unassigned] }));
  assert.equal(home.pending_counts.confirmations, 1);
  assert.deepEqual(home.pending.map((row) => row.observation_id), ["prior-class"]);
  assert.deepEqual(home.recent.map((row) => row.observation_id), ["prior-class"]);
  assert.equal(home.pending[0].class_id, "small-a");
  assert.equal(home.pending[0].class_label, "小班 · 发生时的班名");
  assert.equal(home.class_groups[0].classes[0].confirmation_count, 1);
});
check("sameScopeHistory uses current roster for counts and occurrence snapshot for labels", () => {
  const sameScopeHistory = observation("sameScopeHistory", "ai_organized", { current_class_id: "middle" });
  const home = buildHomeV2Data(auth(), sources({ confirmations: [sameScopeHistory], recent: [sameScopeHistory] }));
  assert.equal(home.pending[0].class_id, "small-a");
  assert.equal(home.pending[0].stage, "small");
  assert.equal(home.class_groups[0].classes[0].confirmation_count, 0);
  assert.equal(home.class_groups[1].classes[0].confirmation_count, 1);
});
check("missing children list cannot erase independently eligible pending", () => {
  const home = buildHomeV2Data(auth(), sources({ classes: null, roster: null,
    confirmations: [observation("known", "ai_organized", { child_name: null })], supplements: null, organizes: null, recent: null }));
  assert.equal(home.scope?.class_count, null);
  assert.equal(home.scope?.child_count, null);
  assert.equal(home.pending_counts.confirmations, 1);
  assert.equal(home.pending_counts.supplements, null);
  assert.equal(home.pending_counts.availability, "unavailable");
  assert.equal(home.primary_action.code, "process_confirmations");
  assert.equal(home.pending[0].child_name, null);
  assert.equal(home.notices[0].code, "data_unavailable");
  assert.ok(!home.notices.some((notice) => notice.code.startsWith("empty_")));
});
check("zero and unknown per-class counts stay separate", () => {
  const home = buildHomeV2Data(auth(), sources({ roster: null, confirmations: null }));
  const row = home.class_groups[0].classes[0];
  assert.equal(row.child_count, null);
  assert.equal(row.confirmation_count, null);
  assert.equal(row.supplement_count, 0);
  assert.equal(row.organize_count, 0);
  assert.equal(home.primary_action.code, "retry");
});
check("all failed datasets retain identity with unknown data, not fake emptiness", () => {
  const home = buildHomeV2Data(auth());
  assert.equal(home.viewer.kind, "teacher");
  assert.equal(home.scope?.class_count, null);
  assert.equal(home.scope?.child_count, null);
  assert.equal(home.pending_counts.confirmations, null);
  assert.equal(home.primary_action.code, "retry");
  assert.deepEqual(home.notices.map((notice) => notice.code), ["data_unavailable"]);
});
check("admin data failure preserves known management action without teaching data", () => {
  const home = buildHomeV2Data(auth(admin));
  assert.equal(home.primary_action.code, "manage_school");
  assert.equal(home.scope?.class_count, null);
  assert.equal(home.pending_counts.confirmations, 0);
  assert.deepEqual(home.pending, []);
  assert.deepEqual(home.recent, []);
  assert.equal(home.notices[0].code, "data_unavailable");
});
check("verified empty children and observations produce distinct actions/notices", () => {
  const noChildren = buildHomeV2Data(auth(), sources({ roster: [] }));
  assert.equal(noChildren.primary_action.code, "create_profile");
  assert.ok(noChildren.notices.some((notice) => notice.code === "empty_children"));
  const noObservations = buildHomeV2Data(auth(), sources());
  assert.equal(noObservations.primary_action.code, "start_observation");
  assert.ok(noObservations.notices.some((notice) => notice.code === "empty_observations"));
});
check("recent limited to two after occurrence-date/creation-date ordering", () => {
  const records = [
    observation("created-late-but-occurred-old", "confirmed", { observed_at: "2026-08-01", created_at: "2026-10-04T00:00:00.000Z" }),
    observation("same-date-earlier", "confirmed", { observed_at: "2026-09-30", created_at: "2026-09-30T01:00:00.000Z" }),
    observation("newest", "draft", { observed_at: "2026-10-01", created_at: "2026-10-01T00:00:00.000Z" }),
    observation("same-date-later", "confirmed", { observed_at: "2026-09-30", created_at: "2026-09-30T02:00:00.000Z" }),
  ];
  const home = buildHomeV2Data(auth(), sources({ recent: records }));
  assert.deepEqual(home.recent.map((row) => row.observation_id), ["newest", "same-date-later"]);
  assert.equal(home.recent.length, 2);
});
check("unknown occurrence snapshot never gets current class name/stage filled in", () => {
  for (const occurrence_snapshot of [null, undefined, [], "bad snapshot", {}]) {
    const home = buildHomeV2Data(auth(), sources({ recent: [observation("unknown", "confirmed", { occurrence_snapshot })] }));
    assert.equal(home.recent[0].class_id, null);
    assert.equal(home.recent[0].class_label, null);
    assert.equal(home.recent[0].stage, null);
  }
});
check("DTO is an explicit excerpt-only whitelist and source input stays immutable", () => {
  const row = { ...observation("whitelist"), excerpt: ` ${"𠮷".repeat(220)} \n `,
    raw_text: "private raw observation", password: "private", token: "private", csrf: "private", guide_evidence: {} };
  const input = sources({ confirmations: [row], recent: [row], classes: [...classes].reverse() });
  const before = structuredClone(input);
  const home = buildHomeV2Data(auth(), input);
  noSensitiveFields(home);
  assert.equal(Array.from(home.pending[0].excerpt).length, 160);
  assert.ok(!JSON.stringify(home).includes("private"));
  assert.deepEqual(input, before);
});
check("unscoped class/roster sources rejected rather than filtered on the page", () => {
  const narrowTeacher = { ...teacher, scope: { kind: "classes" as const, class_ids: ["small-a"] } };
  for (const data of [sources(), sources({ classes: [classes[0]], roster: [{ child_id: "outside", current_class_id: "large" }] })]) {
    const home = buildHomeV2Data(auth(narrowTeacher), data);
    assert.equal(home.viewer.kind, "identity_unavailable");
    noPrivateData(home);
  }
});
check("higher-priority unknown retains lower known rows but chooses retry", () => {
  const home = buildHomeV2Data(auth(), sources({ confirmations: null, supplements: [observation("known-supplement", "needs_input")] }));
  assert.equal(home.primary_action.code, "retry");
  assert.equal(home.pending_counts.confirmations, null);
  assert.equal(home.pending_counts.supplements, 1);
  assert.equal(home.pending[0].observation_id, "known-supplement");
});

for (const entry of FIXTURE_PRIMARY_ACTION_CASES) {
  check(`frozen priority: ${entry.name}`, () => {
    const fixtureClasses = entry.class_count === null ? null
      : Array.from({ length: entry.class_count }, (_, index) => ({ ...classes[0], id: `class-${index}`, name: `班级-${index}` }));
    const fixturePrincipal: Principal = entry.viewer === "admin" ? admin
      : { ...teacher, scope: { kind: "classes", class_ids: fixtureClasses?.map((row) => row.id) ?? ["class-0"] } };
    const rows = (count: number | null | undefined, status: ObservationStatus) => count == null ? null
      : Array.from({ length: count }, (_, index) => observation(`${status}-${index}`, status, { current_class_id: "class-0" }));
    const home = buildHomeV2Data(auth(fixturePrincipal), {
      classes: fixtureClasses,
      roster: entry.child_count === null ? null : Array.from({ length: entry.child_count }, (_, index) => ({ child_id: `child-${index}`, current_class_id: "class-0" })),
      confirmations: rows(entry.counts?.confirmations, "ai_organized"),
      supplements: rows(entry.counts?.supplements, "needs_input"), organizes: rows(entry.counts?.organizes, "draft"), recent: [],
    });
    assert.equal(home.primary_action.code, entry.expected);
  });
}

console.log(JSON.stringify({ passed, total: passed, pure: true, real_db: false, server_auth: false,
  real_http: false, model_requests: 0 }));
