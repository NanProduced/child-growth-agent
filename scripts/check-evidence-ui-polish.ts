import assert from "node:assert/strict";
import { CHILD_EVIDENCE_BOOK_FIXTURE } from "../src/components/guide/__fixtures__/child-evidence-book-fixture";
import {
  parseClassEvidenceQuotes,
  peopleTicks,
  readClassEvidenceQuotes,
  type ClassQuoteTarget,
} from "../src/lib/guide/evidence-read";
import type { ChildEvidenceBook } from "../src/lib/guide/view-types";

let passed = 0;
function check(name: string, body: () => void) {
  body(); passed += 1; process.stdout.write(`PASS ${name}\n`);
}

const book = structuredClone(CHILD_EVIDENCE_BOOK_FIXTURE);
const item = book.goals.flatMap((goal) => goal.items).find((entry) =>
  entry.item.product_rules.evidence_type === "behavior" && entry.links.some((link) =>
    link.counts_toward_status && link.basis.every((basis) => basis.valid && basis.class_context),
  ),
);
assert(item);
const link = item.links.find((entry) => entry.counts_toward_status);
assert(link?.basis[0].class_context && book.child.class_id);
const target: ClassQuoteTarget = {
  childId: book.child.id, itemId: item.item.id, catalogVersion: book.catalog_version,
  classStage: link.basis[0].class_context.stage, scope: book.scope, filters: book.filters,
  classId: book.child.class_id,
};
function changed(mutator: (value: ChildEvidenceBook) => void) {
  const value = structuredClone(book); mutator(value); return value;
}
function changeFocused(value: ChildEvidenceBook) {
  const focused = value.goals.flatMap((goal) => goal.items).find((entry) => entry.item.id === target.itemId);
  assert(focused); return focused;
}

check("frozen links[].basis yields real quotes", () => {
  const result = parseClassEvidenceQuotes(book, target);
  assert.equal(result.kind, "ready");
  assert(result.kind === "ready" && result.sources.some((source) => source.quote === link.basis[0].quote));
});
check("wrong child rejected", () => assert.equal(parseClassEvidenceQuotes(changed((b) => { b.child.id = "other"; }), target).kind, "invalid"));
check("child moved out of current class invalidates projection", () => assert.equal(parseClassEvidenceQuotes(changed((b) => { b.child.class_id = "other"; }), target).kind, "invalid"));
check("current stage changed invalidates projection", () => assert.equal(parseClassEvidenceQuotes(changed((b) => { b.child.stage = b.child.stage === "small" ? "large" : "small"; }), target).kind, "invalid"));
check("wrong catalog rejected", () => assert.equal(parseClassEvidenceQuotes(changed((b) => { b.catalog_version = "old"; }), target).kind, "invalid"));
check("wrong scope rejected", () => assert.equal(parseClassEvidenceQuotes(changed((b) => { b.scope.start_date = "2000-01-01"; }), target).kind, "invalid"));
check("wrong filters rejected", () => assert.equal(parseClassEvidenceQuotes(changed((b) => { b.filters.goal_id = "other"; }), target).kind, "invalid"));
check("missing requested item is not an empty success", () => assert.equal(parseClassEvidenceQuotes(changed((b) => { changeFocused(b).item.id = "other"; }), target).kind, "invalid"));
check("duplicate requested item rejected", () => assert.equal(parseClassEvidenceQuotes(changed((b) => { b.goals[0].items.push(structuredClone(changeFocused(b))); }), target).kind, "invalid"));
check("legacy bases shape rejected", () => assert.equal(parseClassEvidenceQuotes({ ...book, goals: [{ items: [{ item: { id: target.itemId }, bases: link.basis }] }] }, target).kind, "invalid"));
check("empty body rejected", () => assert.equal(parseClassEvidenceQuotes({}, target).kind, "invalid"));
check("malformed basis rejected", () => assert.equal(parseClassEvidenceQuotes(changed((b) => { changeFocused(b).links[0].basis[0].quote = 7 as unknown as string; }), target).kind, "invalid"));
check("real empty is separate", () => assert.equal(parseClassEvidenceQuotes(changed((b) => { changeFocused(b).links = []; }), target).kind, "empty"));
check("unavailable is not empty", () => assert.equal(parseClassEvidenceQuotes(changed((b) => { changeFocused(b).reliability = "unavailable"; }), target).kind, "unavailable"));
check("partial retains warning", () => {
  const result = parseClassEvidenceQuotes(changed((b) => { changeFocused(b).reliability = "partial"; }), target);
  assert(result.kind === "ready" && result.partial);
});
check("valid legacy source does not invent a non-null version requirement", () => {
  const value = changed((b) => { changeFocused(b).links.forEach((entry) => { entry.basis.forEach((basis) => { basis.source_confirmed_at = null; }); }); });
  assert.equal(parseClassEvidenceQuotes(value, target).kind, "ready");
});
check("different historical stage is not class evidence", () => {
  const otherStage = target.classStage === "small" ? "large" : "small";
  const value = changed((b) => { changeFocused(b).links.forEach((entry) => { entry.basis.forEach((source) => { if (source.class_context) source.class_context.stage = otherStage; }); }); });
  assert.equal(parseClassEvidenceQuotes(value, target).kind, "empty");
});
check("same-stage earlier class is permitted and its snapshot preserved", () => {
  const value = changed((b) => { changeFocused(b).links.forEach((entry) => { entry.basis.forEach((source) => { if (source.class_context) source.class_context.class_id = "old-class"; }); }); });
  const result = parseClassEvidenceQuotes(value, target);
  assert(result.kind === "ready" && result.sources[0].class_context?.class_id === "old-class");
});
check("invalid required basis never falls back to first quote", () => {
  const value = changed((b) => { changeFocused(b).links.forEach((entry) => { entry.basis[0].valid = false; }); });
  assert.equal(parseClassEvidenceQuotes(value, target).kind, "empty");
});
check("unconfirmed source is not formal evidence", () => {
  const value = changed((b) => { changeFocused(b).links.forEach((entry) => { entry.basis[0].observation_status = "draft"; }); });
  assert.equal(parseClassEvidenceQuotes(value, target).kind, "empty");
});
check("non-counting links stay out", () => {
  assert.equal(parseClassEvidenceQuotes(changed((b) => { changeFocused(b).links.forEach((entry) => { entry.counts_toward_status = false; }); }), target).kind, "empty");
});
check("pending links stay out", () => {
  assert.equal(parseClassEvidenceQuotes(changed((b) => { changeFocused(b).links.forEach((entry) => { entry.status = "ai_suggested"; }); }), target).kind, "empty");
});
for (const total of [0, 2, 5, 20, 40]) {
  check(`people scale ${total}`, () => {
    const ticks = peopleTicks(total);
    if (total === 0) assert.deepEqual(ticks, []);
    else { assert.equal(ticks[0], 0); assert.equal(ticks.at(-1), total); assert(ticks.every(Number.isInteger)); }
  });
}
check("invalid denominators rejected", () => {
  for (const total of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.deepEqual(peopleTicks(total), []);
});

async function main() {
  for (const [status, expected] of [[401, "unauthenticated"], [403, "forbidden"], [503, "unavailable"], [500, "unavailable"]] as const) {
    assert.equal((await readClassEvidenceQuotes(Response.json(book, { status }), target)).kind, expected);
    passed += 1;
  }
  assert.equal((await readClassEvidenceQuotes(new Response("invalid json", { status: 200 }), target)).kind, "invalid"); passed += 1;
  assert.equal((await readClassEvidenceQuotes(Response.json(book), target)).kind, "ready"); passed += 1;
  process.stdout.write(JSON.stringify({ passed, total: passed, pure: true, model_requests: 0 }) + "\n");
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
