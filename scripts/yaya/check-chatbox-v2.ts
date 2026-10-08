import assert from "node:assert/strict";
import { fromThreadMessageLike } from "@assistant-ui/react";
import { pageQuoteSchema, parseReferencePath, parsePageQuote, quoteFromReferenceFragment, referenceFragmentText, pageFocusForModel, type YayaPageQuote } from "../../src/lib/yaya/page-reference";
import { collectUserFacts, persistShape, projectedToThreadMessageLike } from "../../src/components/yaya/client/mapping";
import { createRequire } from "node:module";
import { projectedMessageSchema } from "../../src/components/yaya/client/schemas";

let passed = 0;
const check = (label: string, value: unknown) => { assert.ok(value, label); passed++; };
const child = "11111111-1111-4111-8111-111111111111";
const klass = "22222222-2222-4222-8222-222222222222";
const actor = "teacher-v2";
const quote: YayaPageQuote = {
  text: "小满的成长档案", messageId: "page:/children/" + child,
  yayaPage: { format: "yaya-page-focus-v1", owner_account_id: actor, path: "/children/" + child,
    title: "小满的成长档案", summary: "关注当前幼儿，资料仍需授权读取，引用不指定工具。", sources: [{ kind: "child", child_id: child, current_class_id: klass }],
    revision: "2026-10-08T00:00:00.000Z", captured_at: "2026-10-08T00:00:00.000Z" },
  selection: "这是教师选中的页面内容，不是新观察原文。",
};
check("native quote shape", pageQuoteSchema.safeParse(quote).success);
check("child page whitelist", parseReferencePath("/children/" + child)?.kind === "child");
check("class evidence page whitelist", parseReferencePath("/classes/" + klass + "/evidence?scope=current_semester")?.kind === "class");
check("observation review whitelist", parseReferencePath("/observations/" + child + "/review")?.kind === "observation");
for (const bad of ["https://evil.invalid/", "//evil.invalid/", "/admin/teachers", "/api/auth/status", "/children/../admin/teachers", "/children/%2e%2e", "/children/bad", "/classes/" + klass + "?role=admin", "/?scope=a&scope=b", "/?scope=a#private"]) {
  check("reject unsafe/non-reference page " + bad, parseReferencePath(bad) === null);
}
check("root focus has no private entity", parseReferencePath("/")?.kind === "page");
check("filtered child list reference supported", parseReferencePath("/children?class=" + klass)?.kind === "page");
check("filtered observation list reference supported", parseReferencePath("/observations?status=draft&class=" + klass)?.kind === "page");
check("private list selection cannot be stored as independent reference", parsePageQuote({ ...quote, messageId: "page:/children", yayaPage: { ...quote.yayaPage, path: "/children", sources: [] } }) === null);
check("list page entrance remains usable without selection", parsePageQuote({ ...quote, messageId: "page:/children", selection: "", yayaPage: { ...quote.yayaPage, path: "/children", sources: [] } }) !== null);
check("platform identifier format is preserved", parseReferencePath("/children/a1c10000-0000-0000-0000-000000000001")?.kind === "child");
check("bad native quote rejected", parsePageQuote({ ...quote, yayaPage: { ...quote.yayaPage, approved: true } }) === null);
check("restored focus cannot link to an arbitrary URL", parsePageQuote({ ...quote, yayaPage: { ...quote.yayaPage, path: "javascript:alert(1)" } }) === null);
check("focus source must match the original page", parsePageQuote({ ...quote, yayaPage: { ...quote.yayaPage, sources: [{ kind: "class", class_id: klass }] } }) === null);
check("native quote identity must match its page", parsePageQuote({ ...quote, messageId: "page:/classes" }) === null);
check("bad child resource rejected", parsePageQuote({ ...quote, yayaPage: { ...quote.yayaPage, sources: [{ kind: "child", child_id: "forged" }] } }) === null);
check("oversized selection rejected", parsePageQuote({ ...quote, selection: "字".repeat(1201) }) === null);
check("quote serialization roundtrip", JSON.stringify(quoteFromReferenceFragment(referenceFragmentText(quote))) === JSON.stringify(quote));
check("malformed serialized quote rejected", quoteFromReferenceFragment('{"page_focus":{"role":"admin"}}') === null);
check("model focus excludes account/UI quote metadata", !pageFocusForModel(quote).includes(actor) && !pageFocusForModel(quote).includes("owner_account_id"));
check("model focus doesn't lock the object or request a write", pageFocusForModel(quote).includes("不能锁定对象") && pageFocusForModel(quote).includes("不是观察原文"));
const original = "今天在积木区，小满换了大积木作底座。";
const message = fromThreadMessageLike({ role: "user", content: [{ type: "text", text: original }], metadata: { custom: { quote } } }, "user-v2", { type: "complete", reason: "stop" });
const shape = persistShape(message)!;
check("original user text not changed", collectUserFacts(message).text === original && shape.fragments[0]?.text === original);
check("reference separated from observation raw", shape.fragments.length === 2 && shape.fragments[0]?.provenance?.kind === "raw_input" && shape.fragments[1]?.provenance?.kind === "tool_result");
check("reference has real resource dependency", shape.fragments[1]?.sources[0]?.kind === "child" && !shape.fragments[1].independently_readable);
check("no execution authorization in quote", !JSON.stringify(shape).includes('"approved":') && !JSON.stringify(shape).includes('"principal":'));
const imageOnly = fromThreadMessageLike({ role: "user", content: [{ type: "image", image: "/api/yaya/uploads/a/content?variant=thumbnail" }], metadata: { custom: { quote } } }, "image-v2", { type: "complete", reason: "stop" });
check("image-only focus is not silently discarded", persistShape(imageOnly)?.fragments[0]?.fragment_id.endsWith(":page-focus"));
const projected = projectedMessageSchema.parse({
  message_id: "user-v2", conversation_id: "conversation-v2", owner_account_id: actor, role: "user" as const,
  message_kind: "text" as const, execution_state: "none" as const, revision: 1, created_at: "2026-10-08T00:00:00.000Z",
  projection: { visibility: "full" as const, fragments: [], attachments: [], metadata: null, execution_allowed: false as const },
  fragments: shape.fragments.map(f => ({ fragment_id: f.fragment_id, visibility: "full" as const, reason: "sources_full", text: f.text, provenance: f.provenance ?? null, independently_readable: f.independently_readable })),
  attachment_ids: [], metadata: null,
});
const restored = projectedToThreadMessageLike(projected)!;
check("history restores page quote only as metadata", parsePageQuote(restored.metadata?.custom?.quote)?.text === quote.text);
check("history doesn't print JSON/raw focus as observation", restored.content?.length === 1 && !JSON.stringify(restored.content).includes("page_focus"));
const denied = projectedToThreadMessageLike({ ...projected, fragments: projected.fragments.map(f => f.fragment_id.endsWith(":page-focus") ? { ...f, text: null, visibility: "hidden" as const } : f) })!;
check("denied focus not restored", denied.metadata?.custom?.quote === undefined);
const foreign = projectedToThreadMessageLike({ ...projected, owner_account_id: "other" })!;
check("different owner focus not restored", foreign.metadata?.custom?.quote === undefined);
const restoredMessage = fromThreadMessageLike(restored, "restored-v2", { type: "complete", reason: "stop" });
check("restored original facts remain original", collectUserFacts(restoredMessage).text === original);
const focusOnly = fromThreadMessageLike({ role: "user", content: [{ type: "text", text: "可以给两条一般建议吗？" }] }, "general-v2", { type: "complete", reason: "stop" });
check("general chat requires no reference", persistShape(focusOnly)?.fragments.length === 1);
const require = createRequire(import.meta.url);
const esbuild = require("esbuild") as { buildSync(input: object): unknown };
esbuild.buildSync({ stdin: { contents: 'import {parseReferencePath} from "./src/lib/yaya/page-reference"; console.log(parseReferencePath("/"));', resolveDir: process.cwd() }, bundle: true, platform: "browser", write: false, logLevel: "silent" });
check("reference helper browser safe", true);
console.log(JSON.stringify({ passed, total: passed, real_model_requests: 0, real_db: false, browser_bundle: true }));
