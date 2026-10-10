import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { createAcceptanceSeed, type AcceptanceSeedHandle } from "./yaya/acceptance/seed";
import { snapshotGeneratedArtifacts, restoreGeneratedArtifacts, trackChildProcess, stopTrackedChildTree, waitForVerifiedService, type TrackedChild } from "./harness-safety";
import { previousCommunicationMonth } from "../src/lib/family-communication-contract";
import { isoDateInShanghai } from "../src/lib/format";
import type { ObservationDraft } from "../src/lib/types";

const root = fileURLToPath(new URL("../", import.meta.url));
async function freePort() {
  const probe = net.createServer(); await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const address = probe.address(); if (!address || typeof address === "string") throw Error("No local port");
  const port = address.port; await new Promise<void>((resolve) => probe.close(() => resolve())); return port;
}
async function main() {
  const snapshot = snapshotGeneratedArtifacts(root);
  const out = path.join(root, "output/playwright", `family-communication-copy2-${randomUUID()}`); fs.mkdirSync(out, { recursive: true });
  let seed: AcceptanceSeedHandle | undefined, server: TrackedChild | undefined, modelServer: http.Server | undefined;
  let modelCalls = 0, failuresRemaining = 0;
  const cleanup: string[] = [];
  try {
    seed = await createAcceptanceSeed();
    const child = randomUUID(), empty = randomUUID(), classId = seed.manifest.classes.class_a.id;
    const month = previousCommunicationMonth(isoDateInShanghai());
    const db = new Client({ connectionString: seed.database_url }); await db.connect();
    try {
      await db.query(fs.readFileSync(path.join(root, "scripts/upgrade-family-communication-v1.sql"), "utf8"));
      for (const [id, name] of [[child, "林小禾"], [empty, "叶星星"]]) {
        await db.query("INSERT INTO children(id,name,gender,birth_date,class_name,is_demo) VALUES($1,$2,'女','2023-03-10','阳光班',true)", [id, name]);
        await db.query("INSERT INTO child_class_enrollments(child_id,class_id,start_date) VALUES($1,$2,'2020-01-01')", [id, classId]);
      }
      const stories = [
        ["02", "积木区", "积木桥倒下后，小禾把桥墩挪近，说：“这次小车能过去了。”", '科学', '科学探究'],
        ["11", "美工区", "小禾给画里的窗户添上圆点，说：“妈妈从这里看我。”", '艺术', '表现与创造'],
        ["17", "同伴游戏", "小禾主动问同伴：“我可以和你们一起开车吗？”同伴点头后，她把小车停进了积木车库。", '社会', '人际交往'],
        ["22", "阅读角", "小禾主动拿来《小熊回家》，请老师讲给她听，看到小熊找妈妈时指着画面停留了一会儿。", '语言', '阅读与书写准备'],
        ["24", "生活整理", "收拾材料时，小禾把画纸放进自己的文件夹，再把蜡笔放回盒子。", '健康', '生活习惯与生活能力'],
      ];
      for (const [day, context, raw, domain, subDomain] of stories) {
        const content: ObservationDraft = { domain, sub_domain: subDomain, objective_description: raw, highlights: [raw], support_suggestions: ["保留材料让她继续尝试。"], highlight_quote: raw };
        await db.query(`INSERT INTO observations(id,child_id,class_id,observed_at,context,raw_text,status,confirmed_content,confirmed_at,is_demo)
          VALUES($1,$2,$3,$4,$5,$6,'confirmed',$7::jsonb,clock_timestamp(),true)`, [randomUUID(), child, classId, `${month}-${day}`, context, raw, JSON.stringify(content)]);
      }
    } finally { await db.end(); }
    modelServer = http.createServer(async (request, response) => {
      if (request.url === "/test-control") { failuresRemaining = 1; response.end("ok"); return; }
      if (request.url !== "/chat/completions") { response.writeHead(404).end(); return; }
      modelCalls++;
      if (failuresRemaining) { failuresRemaining--; response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "fixture-provider-unavailable" } })); return; }
      let body = ""; for await (const chunk of request) body += String(chunk);
      try {
        const input = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
        const facts = JSON.parse(input.messages.find((item) => item.role === "user")!.content) as { child_name: string; observations: Array<{ observation_id: string; raw_text: string; confirmed_domain?: string }> };
        const first = facts.observations[0];
        const quote = first.raw_text.includes("这次小车能过去了") ? "这次小车能过去了" : first.raw_text.slice(0, 12);
        const stories = facts.observations.map(observation => ({ observation_id: observation.observation_id, focus: observation.confirmed_domain ?? '生活片段',
          text: observation.raw_text, quote: observation.observation_id === first.observation_id ? quote : observation.raw_text.slice(0, 12) }));
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "fixture-stepfun-protocol", choices: [{ message: { content: JSON.stringify({ stories, suggestion: "在家也可以听她讲讲画里的故事，或一起试试怎样把积木桥搭稳。" }) } }] }));
      } catch { response.writeHead(400).end(); }
    });
    await new Promise<void>((resolve) => modelServer!.listen(0, "127.0.0.1", resolve));
    const address = modelServer.address(); if (!address || typeof address === "string") throw Error("No model fixture port");
    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    const modelBase = `http://127.0.0.1:${address.port}`;
    const logFile = path.join(out, "next.log");
    const childProcess = spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["exec", "next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: root, shell: process.platform === "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DATABASE_URL: seed.database_url, PGDATABASE_URL: "", AUTH_TRUSTED_ORIGINS: base,
        AUTH_SCHOOL_ID: seed.manifest.school_id, AUTH_COOKIE_SECURE: "false", LLM_PROVIDER: "stepfun", STEPFUN_API_KEY: "fixture-only",
        STEPFUN_BASE_URL: modelBase, STEPFUN_MODEL: "fixture-stepfun-protocol", STEPFUN_TIMEOUT_MS: "10000",
        YAYA_CHAT_TEXT_PROVIDER: "stepfun", YAYA_CHAT_IMAGE_PROVIDER: "stepfun", MEDIA_STORAGE_MODE: "local", MEDIA_LOCAL_ROOT: seed.object_root },
    });
    server = trackChildProcess(childProcess, { logFile });
    childProcess.stdout?.on("data", (chunk: Buffer) => fs.appendFileSync(logFile, chunk)); childProcess.stderr?.on("data", (chunk: Buffer) => fs.appendFileSync(logFile, chunk));
    await waitForVerifiedService({ base, port, child: server, timeoutMs: 180000 });
    const runner = spawn(process.execPath, [path.join(root, "scripts/check-family-communication-browser.cjs")], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    runner.stdin.end(JSON.stringify({ base, modelBase, child, empty, month, out, credentials_path: seed.credentials_path,
      playwright: process.env.PLAYWRIGHT_CORE_DIR }));
    let output = ""; runner.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); }); runner.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => { runner.once("error", reject); runner.once("exit", resolve); });
    process.stdout.write(output); if (code !== 0) throw Error("Chrome acceptance failed");
    console.log(JSON.stringify({ model_double_http_calls: modelCalls, real_model_requests: 0, browser: "Chrome", evidence: "Next_HTTP+isolated_PG+real_AUTH+provider_protocol_double" }));
  } finally {
    if (server) { const result = await stopTrackedChildTree(server); if (!result.ok) cleanup.push(result.detail); }
    await new Promise<void>((resolve) => modelServer ? modelServer.close(() => resolve()) : resolve());
    await seed?.teardown().catch((error: unknown) => cleanup.push(String(error)));
    const restored = restoreGeneratedArtifacts(snapshot, root); cleanup.push(...restored.issues);
    const log = path.join(out, "next.log");
    if (fs.existsSync(log)) fs.writeFileSync(log, fs.readFileSync(log, "utf8").replace(/([?&]password=)[^&\s]*/gi, "$1[redacted]"));
    fs.writeFileSync(path.join(out, "cleanup.json"), JSON.stringify({ cleanup_ok: cleanup.length === 0, issues: cleanup }, null, 2));
    if (cleanup.length) throw Error(`cleanup failed: ${cleanup.join("; ")}`);
    console.log(JSON.stringify({ cleanup: "verified" }));
  }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
