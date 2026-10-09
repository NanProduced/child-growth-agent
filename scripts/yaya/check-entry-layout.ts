/** Offline source checks only; viewport geometry and focus return need the joint browser runner. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const entry = read("src/components/yaya/yaya-entry.tsx");
const shell = read("src/components/yaya/yaya-app-shell.tsx");
const nav = read("src/components/top-nav.tsx");
const panel = read("src/components/yaya/yaya-panel.tsx");
const familyCss = read("src/components/family-communication/workspace.module.css");
const navCss = read("src/components/home-v2/homepage.module.css");
let passed = 0;
function check(name: string, condition: boolean): void {
  assert.ok(condition, name);
  passed += 1;
}
function openingElements(source: string): ts.JsxOpeningLikeElement[] {
  const nodes: ts.JsxOpeningLikeElement[] = [];
  const parsed = ts.createSourceFile("surface.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return nodes;
}
const entryNodes = openingElements(entry);
const shellNodes = openingElements(shell);
const navNodes = openingElements(nav);
const wrapper = entryNodes.find((node) => node.tagName.getText() === "div");
const wrapperClass = wrapper?.attributes.properties.find((node) => ts.isJsxAttribute(node) && node.name.getText() === "className");
const classText = wrapperClass && ts.isJsxAttribute(wrapperClass) && wrapperClass.initializer && ts.isStringLiteral(wrapperClass.initializer)
  ? wrapperClass.initializer.text : "";

check("single launcher ID", (entry.match(/id="yaya-entry-button"/g) ?? []).length === 1);
check("single launcher mount", shellNodes.filter((node) => node.tagName.getText() === "YayaEntry").length === 1);
check("launcher is passed into shared navigation", /<TopNav assistantEntry=\{<YayaEntry auth=\{auth\}/.test(shell));
check("single panel mount", shellNodes.filter((node) => node.tagName.getText() === "YayaPanel").length === 1);
check("single navigation actions slot", (nav.match(/\{assistantEntry\}/g) ?? []).length === 1 && nav.includes("data-yaya-nav-actions"));
check("compact navigation can shrink before wrapping", nav.includes("max-[1090px]:flex-1 max-[1090px]:justify-end"));
check("desktop entry is icon-sized without losing status", entry.includes("min-[1091px]:p-1.5") && entry.includes("min-[1091px]:sr-only"));
check("no nested assistant Provider", ![entry, shell, nav].some((source) => /<(?:YayaSurface|AssistantRuntimeProvider)\b/.test(source)));
check("compact launcher stays in flow", classText !== "" && !classText.split(/\s+/).some((name) => ["fixed", "absolute", "sticky"].includes(name)));
check("floating placement starts above existing navigation breakpoint", classText.includes("min-[1091px]:fixed") && navCss.includes("@media (width <= 1090px)"));
check("wide screen retains right-bottom placement", classText.includes("min-[1091px]:right-6") && classText.includes("min-[1091px]:bottom-[max(1.5rem,env(safe-area-inset-bottom))]"));
check("compact target at least 44px in both directions", entry.includes("min-h-11 min-w-11"));
check("no JS positioning system", !/(ResizeObserver|matchMedia|addEventListener|useEffect|createPortal)/.test(entry + nav + shell));
check("open panel removes launcher", entry.includes('if (open || pathname === "/assistant"'));
check("assistant descendants also omit launcher", entry.includes('pathname?.startsWith("/assistant/") === true'));
check("live identity still comes from TeacherProvider", entry.includes("auth = useTeacher().auth;"));
check("all unready identity statuses retained", ["身份服务暂时不可用", "登录状态已失效", "正在准备会话", "登录后使用"].every((label) => entry.includes(label)));
check("compact error status has non-color feedback", entry.includes('auth.state.kind === "unavailable" || auth.state.kind === "invalid_session" ? "unknown" : "idle"'));
check("status stays announced and in accessible name", entry.includes('role="status" aria-live="polite"') && entry.includes('aria-label={`打开芽芽助手。${statusText}`}'));
check("existing close focus target preserved", panel.includes('document.getElementById("yaya-entry-button")?.focus({ preventScroll: true })'));
check("existing role-scoped navigation preserved", nav.includes('NAV.filter(({ href }) => hasClassScope || href === "/")') && nav.includes('principal.role === "admin"'));
check("family communication link preserved", navNodes.some((node) => node.tagName.getText() === "Link" && node.attributes.getText().includes('href="/family-communication"')));
check("account name can shrink without losing full title", nav.includes('styles["account-name"]} min-w-0') && nav.includes("title={principal.display_name}") && nav.includes('styles.brand} shrink-0'));
check("family page no longer repositions shared launcher", !familyCss.includes("data-yaya-entry"));
console.log(JSON.stringify({ passed, total: passed, static_only: true, browser: "NOT_RUN", real_model_requests: 0 }));
