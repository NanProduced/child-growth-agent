/**
 * YAYA-CORE-INTEGRATE1 真实 HTTP 验收（媒体路由 + 运行绑定）：
 * 一次性隔离 PostgreSQL + 真实 sharp + 自有本地对象存储 + 真实登录/会话/CSRF，
 * 启动**真实 Next 服务**（dev，127.0.0.1 随机端口），走 HTTP 完成上传与读取。
 *
 * 与 handler 直调检查的分层：本文件不 import route handler，而是让 Next 进程
 * 自行装配 mediaRuntimeOrThrow（DATA 适配器 + 环境对象存储）。
 * 真实 provider/搜索/S3/托管库 NOT_RUN；模型守门只用于证明无真实出口。
 *
 * 运行：pnpm exec tsx scripts/yaya/check-integration-http.ts
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import sharp from "sharp";

import { hashPassword } from "../../src/lib/accounts/password";
import { computeCsrfToken, createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/accounts/session";
import { sha256Hex } from "../../src/lib/media/object-store";
import {
  assertCleanupComplete,
  findListeningPids,
  modelGuardEnv,
  readLogTail,
  restoreGeneratedArtifacts,
  runCleanupSteps,
  snapshotGeneratedArtifacts,
  startIsolatedPostgres,
  startModelRequestGuard,
  stopTrackedChildTree,
  trackChildProcess,
  waitForVerifiedService,
  type IsolatedPostgres,
} from "../harness-safety";

const RUN = `int-http-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const LABEL_KEY = "yaya.integrate1.http";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

let passed = 0;
const failures: string[] = [];
function check(label: string, condition: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`ok - ${label}`);
  } else {
    failures.push(label);
    console.error(`FAIL - ${label}`);
  }
}
function stage(label: string): void {
  console.error(`[stage] ${label}`);
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full);
    }
  }
  await walk(dir);
  return out.sort();
}

function pngBuffer(width = 128, height = 96): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } },
  })
    .png()
    .toBuffer();
}

async function pickFreePort(): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const port = 21000 + Math.floor(Math.random() * 8000);
    const listeners = findListeningPids(port);
    if (listeners.ok && listeners.pids.length === 0) return port;
    if (!listeners.ok) throw new Error(`端口探测失败：${listeners.detail}`);
  }
  throw new Error("无法找到空闲端口");
}

function cookiePair(rawCookie: string): string {
  const [name, ...rest] = rawCookie.split(";")[0]!.split("=");
  return `${name}=${rest.join("=")}`;
}

async function main(): Promise<void> {
  const guard = await startModelRequestGuard();
  const cleanupIssues: string[] = [];
  let isolated: IsolatedPostgres | null = null;
  let database: Client | null = null;
  let mediaRoot: string | null = null;
  let logFile: string | null = null;
  let trackedChild: ReturnType<typeof trackChildProcess> | null = null;
  const artifactSnapshot = snapshotGeneratedArtifacts(ROOT);

  try {
    isolated = await startIsolatedPostgres({
      runId: RUN,
      containerName: `yaya-int-http-${RUN}`,
      dbName: "yaya_integrate1_http",
      labelKey: LABEL_KEY,
    });
    const url = isolated.url;
    database = new Client({ connectionString: url });
    await database.connect();
    await database.query("SET TIME ZONE 'UTC'");
    await database.query(fs.readFileSync(path.join(ROOT, "scripts/initialize-demo-db.sql"), "utf8"));
    await database.query(fs.readFileSync(path.join(ROOT, "scripts/upgrade-auth-v1.sql"), "utf8"));
    await database.query(fs.readFileSync(path.join(ROOT, "scripts/upgrade-yaya-v1.sql"), "utf8"));
    stage("migrated");

    // 真实账号：登录走 /api/auth/login（scrypt 校验 + 会话 + CSRF）
    const teacherUsername = "integrate1-teacher";
    const teacherPassword = "integrate1-passphrase";
    const teacherId = randomUUID();
    const classId = randomUUID();
    await database.query(
      "INSERT INTO app_accounts (id, username, display_name, password_hash, role, status) VALUES ($1,$2,$2,$3,'teacher','active')",
      [teacherId, teacherUsername, await hashPassword(teacherPassword)],
    );
    await database.query(
      `INSERT INTO classes (id, name, stage, school_year, is_active) VALUES ($1,'HTTP 验收班','middle','2026','true')`,
      [classId],
    );
    await database.query("INSERT INTO teacher_class_assignments (account_id, class_id) VALUES ($1,$2)", [
      teacherId,
      classId,
    ]);
    const otherId = randomUUID();
    const otherToken = createSessionToken();
    await database.query(
      "INSERT INTO app_accounts (id, username, display_name, password_hash, role, status) VALUES ($1,$2,$2,'test-never-logged-in','teacher','active')",
      [otherId, `${RUN}-other`],
    );
    await database.query(
      "INSERT INTO app_sessions (account_id, token_hash, expires_at) VALUES ($1,$2,now()+interval '1 day')",
      [otherId, otherToken.tokenHash],
    );
    stage("seeded");

    mediaRoot = await mkdtemp(path.join(os.tmpdir(), "yaya-int-http-media-"));
    const port = await pickFreePort();
    const base = `http://127.0.0.1:${port}`;
    logFile = path.join(os.tmpdir(), "opencode", `yaya-int-http-${RUN}.log`);
    fs.writeFileSync(logFile, "");
    const childEnv = modelGuardEnv(guard, {
      ...process.env,
      DATABASE_URL: url,
      AUTH_TRUSTED_ORIGINS: base,
      AUTH_SCHOOL_ID: "single-school",
      MEDIA_ENVIRONMENT: "development",
      MEDIA_STORAGE_MODE: "local",
      MEDIA_LOCAL_ROOT: mediaRoot,
      NEXT_TELEMETRY_DISABLED: "1",
    });
    const child = spawn(
      process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      ["exec", "next", "dev", "--hostname", "127.0.0.1", "--port", String(port)],
      {
        cwd: ROOT,
        env: childEnv,
        shell: process.platform === "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    trackedChild = trackChildProcess(child, { logFile });
    child.stdout?.on("data", (chunk: Buffer) => fs.appendFileSync(logFile!, chunk));
    child.stderr?.on("data", (chunk: Buffer) => fs.appendFileSync(logFile!, chunk));
    stage(`next-spawned pid=${child.pid} port=${port}`);
    await waitForVerifiedService({
      base,
      port,
      child: trackedChild,
      timeoutMs: 300_000,
      statusPath: "/api/auth/status",
    });
    stage("next-ready");

    // 登录（真实 AUTH 入口：Origin + JSON + 登录请求头）
    const loginResponse = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: {
        origin: base,
        "content-type": "application/json",
        "x-cga-auth-request": "1",
      },
      body: JSON.stringify({ username: teacherUsername, password: teacherPassword }),
    });
    const loginBody = (await loginResponse.json()) as {
      state?: { kind?: string };
      csrf?: { token?: string };
    };
    check("HTTP 真实登录成功", loginResponse.status === 200 && loginBody.state?.kind === "authenticated");
    const rawCookie = loginResponse.headers.getSetCookie().find((entry) => entry.startsWith(`${SESSION_COOKIE_NAME}=`));
    assert.ok(rawCookie, "登录未下发会话 Cookie");
    const cookie = cookiePair(rawCookie);
    const csrf = loginBody.csrf?.token ?? "";
    check("登录下发会话绑定 CSRF", csrf.length > 0 && csrf === computeCsrfToken(cookie.split("=")[1] ?? ""));

    // 未认证与错误 CSRF 拒绝
    const anonymousUpload = await fetch(`${base}/api/yaya/uploads`, { method: "POST" });
    check("HTTP 未认证上传被拒", anonymousUpload.status === 401 || anonymousUpload.status === 403);
    const badCsrf = await fetch(`${base}/api/yaya/uploads`, {
      method: "POST",
      headers: {
        origin: base,
        cookie,
        "x-csrf-token": "wrong-token",
        "content-type": "multipart/form-data; boundary=x",
      },
      body: "--x--",
    });
    check("HTTP 错误 CSRF 上传被拒", badCsrf.status === 403);

    // 真实上传：multipart → sharp → 三对象落地 → DATA 登记
    const rawPng = await pngBuffer(128, 96);
    const form = new FormData();
    form.append("files", new File([new Uint8Array(rawPng)], "http.png", { type: "image/png" }));
    const uploadResponse = await fetch(`${base}/api/yaya/uploads`, {
      method: "POST",
      headers: { origin: base, cookie, "x-csrf-token": csrf },
      body: form,
    });
    const uploadBody = (await uploadResponse.json()) as {
      uploads?: {
        ok?: boolean;
        code?: string;
        attachment?: { attachment_id?: string; width?: number; height?: number; byte_size?: number };
      }[];
    };
    const uploaded = uploadBody.uploads?.[0];
    check(
      "HTTP 上传成功（真实 Next + 环境运行绑定）",
      uploadResponse.status === 200 && uploaded?.ok === true && typeof uploaded.attachment?.attachment_id === "string",
    );
    const attachmentId = uploaded?.attachment?.attachment_id ?? "";
    const uploadJson = JSON.stringify(uploadBody);
    check(
      "HTTP 上传响应不含对象 key/签名 URL",
      !uploadJson.includes("object_key") && !uploadJson.includes("http") && !uploadJson.includes("media/dev"),
    );

    // DB 元数据核对：source_checksum 为原始字节 SHA-256，对象 checksum 为处理后内容
    const dbRow = await database.query<{
      source_checksum: string | null;
      checksum_sha256: string;
      object_key: string;
      thumbnail_key: string;
      model_key: string;
      status: string;
      width: number;
      height: number;
    }>(
      "SELECT source_checksum, checksum_sha256, object_key, thumbnail_key, model_key, status, width, height FROM yaya_attachments WHERE id = $1",
      [attachmentId],
    );
    const row = dbRow.rows[0];
    check(
      "HTTP 上传经真实 DATA repository 落库（source_checksum=原始字节）",
      row !== undefined &&
        row.source_checksum === sha256Hex(rawPng) &&
        row.status === "ready" &&
        row.width === 128 &&
        row.height === 96,
    );
    const mediaFiles = await listFiles(mediaRoot);
    check("HTTP 上传三对象落到自有本地存储", row !== undefined && mediaFiles.length === 3);

    // 元数据与三种字节读取（认证代理）
    const metadataResponse = await fetch(`${base}/api/yaya/uploads/${attachmentId}`, {
      headers: { origin: base, cookie },
    });
    const metadataBody = (await metadataResponse.json()) as Record<string, unknown>;
    check(
      "HTTP 授权元数据读取（无 key/URL）",
      metadataResponse.status === 200 &&
        metadataBody.attachment_id === attachmentId &&
        !JSON.stringify(metadataBody).includes("object_key") &&
        !JSON.stringify(metadataBody).includes("http"),
    );
    for (const [variant, expectedType] of [
      ["original", "image/png"],
      ["thumbnail", "image/webp"],
      ["model", "image/jpeg"],
    ] as const) {
      const contentResponse = await fetch(
        `${base}/api/yaya/uploads/${attachmentId}/content?variant=${variant}`,
        { headers: { origin: base, cookie } },
      );
      const body = Buffer.from(await contentResponse.arrayBuffer());
      check(
        `HTTP ${variant} 字节读取（授权代理 + 真实对象）`,
        contentResponse.status === 200 &&
          contentResponse.headers.get("content-type") === expectedType &&
          body.length > 0 &&
          (variant !== "original" || sha256Hex(body) === row?.checksum_sha256),
      );
    }

    // 越权读取：他人账号仅元数据/字节均拒绝
    const otherResponse = await fetch(`${base}/api/yaya/uploads/${attachmentId}/content?variant=original`, {
      headers: { origin: base, cookie: `${SESSION_COOKIE_NAME}=${otherToken.token}` },
    });
    check("HTTP 非上传者读取字节被拒", otherResponse.status === 403);
    const otherMeta = await fetch(`${base}/api/yaya/uploads/${attachmentId}`, {
      headers: { origin: base, cookie: `${SESSION_COOKIE_NAME}=${otherToken.token}` },
    });
    check("HTTP 非上传者读取元数据被拒", otherMeta.status === 403);
    const noAuth = await fetch(`${base}/api/yaya/uploads/${attachmentId}/content?variant=original`, {
      headers: { origin: base },
    });
    check("HTTP 未认证读取被拒", noAuth.status === 401);

    // 无键重传恢复同一附件（真实 HTTP 幂等）
    const retryForm = new FormData();
    retryForm.append("files", new File([new Uint8Array(rawPng)], "http.png", { type: "image/png" }));
    const retryResponse = await fetch(`${base}/api/yaya/uploads`, {
      method: "POST",
      headers: { origin: base, cookie, "x-csrf-token": csrf },
      body: retryForm,
    });
    const retryBody = (await retryResponse.json()) as {
      uploads?: { ok?: boolean; attachment?: { attachment_id?: string } }[];
    };
    check(
      "HTTP 无键重传恢复同一附件且不新增对象",
      retryBody.uploads?.[0]?.ok === true &&
        retryBody.uploads?.[0]?.attachment?.attachment_id === attachmentId &&
        (await listFiles(mediaRoot)).length === 3,
    );

    check("模型守门未被触发（真实 provider 出口 0 次）", guard.hits === 0);
    stage("http-done");
  } finally {
    await runCleanupSteps(
      [
        {
          label: "next-server",
          run: async () => {
            if (!trackedChild) return;
            const report = await stopTrackedChildTree(trackedChild);
            if (!report.ok) throw new Error(`${report.detail}\n${readLogTail(trackedChild, 30)}`);
          },
        },
        {
          label: "generated-artifacts",
          run: () => {
            const report = restoreGeneratedArtifacts(artifactSnapshot, ROOT);
            if (report.issues.length > 0) throw new Error(report.issues.join("；"));
          },
        },
        { label: "database", run: () => database?.end().then(() => undefined) },
        {
          label: "media-root",
          run: async () => {
            if (mediaRoot) await rm(mediaRoot, { recursive: true, force: true });
          },
        },
        {
          label: "container",
          run: () => {
            if (!isolated) return;
            const report = isolated.teardown();
            if (!report.ok) throw new Error(report.detail);
          },
        },
        { label: "model-guard", run: () => guard.close() },
      ],
      (label, detail) => cleanupIssues.push(`${label}: ${detail}`),
    );
    if (mediaRoot) {
      const remaining = await listFiles(mediaRoot);
      if (remaining.length > 0) cleanupIssues.push(`media-root 残留 ${remaining.length} 个对象`);
    }
    if (logFile) await rm(logFile, { force: true }).catch(() => undefined);
    if (cleanupIssues.length > 0) {
      console.error(cleanupIssues.join("\n"));
    }
    assertCleanupComplete(cleanupIssues);
  }

  console.log(
    JSON.stringify({
      passed,
      total: passed + failures.length,
      failures,
      run_id: RUN,
      layers: {
        server: "real next dev (HTTP)",
        database: "one-off isolated postgres",
        processing: "real sharp",
        storage: "local object store (own temp root)",
        auth: "real login/session/CSRF",
        real_provider: "not_run",
      },
    }),
  );
  if (failures.length > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
