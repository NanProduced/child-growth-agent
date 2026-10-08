import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Client } from 'pg';
import { hashPassword } from '../src/lib/accounts/password';
import { isoDateInShanghai } from '../src/lib/format';
import { createAcceptanceSeed } from './yaya/acceptance/seed';
import { syntheticSharedPhoto } from './yaya/acceptance/media';
import { assertCleanupComplete, findListeningPids, restoreGeneratedArtifacts, runCleanupSteps, snapshotGeneratedArtifacts, stopTrackedChildTree, trackChildProcess, waitForVerifiedService, type TrackedChild } from './harness-safety';

const RAW = '[合成]户外游戏时，幼儿双脚连续向前跳过了三条地面标线，途中没有停下，还回头告诉同伴自己跳过去了。';
const QUOTE = '双脚连续向前跳过了三条地面标线';
const DRAFT = { domain: '健康', sub_domain: '身体控制与协调', objective_description: '观察记录了连续向前跳的动作过程。', highlights: [QUOTE], support_suggestions: ['提供不同间距的地面标线供幼儿选择。'], highlight_quote: QUOTE };
const PROFILE = { summary: '已确认观察记录了连续跳跃过程。', recent_change: '当前只有一条确认记录，暂不判断变化。', development_clues: [QUOTE], next_support: '提供不同间距的地面标线。', next_focus: '继续记录幼儿如何选择跳跃路线。' };
const suggestion = { title: '地面标线游戏', purpose: '支持幼儿选择不同路线。', steps: ['摆放地面标线。', '邀请幼儿自由选择路线。'], materials: ['标线'], observe: '记录跳跃动作。', adaptation: '按幼儿选择调整间距。', evidence: ['健康：' + QUOTE] };
type Session = { cookie: string; csrf: string };
const record = (value: unknown): Record<string, unknown> => { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>; };
const str = (value: unknown): string => { assert.equal(typeof value, 'string'); return value as string; };
const guideItem = (data: Record<string, unknown>, itemId: string): Record<string, unknown> => {
  assert.ok(Array.isArray(data.goals));
  const items = data.goals.flatMap((goal: unknown) => { const rows = record(goal).items; assert.ok(Array.isArray(rows)); return rows.map(record); });
  const found = items.find((item) => record(item.item).id === itemId);
  assert.ok(found);
  return found;
};

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const listeners = findListeningPids(port);
  assert.ok(listeners.ok && listeners.pids.length === 0);
  return port;
}

async function main(): Promise<void> {
  const root = process.cwd();
  for (const name of ['.env', '.env.local', '.env.development', '.env.development.local']) {
    assert.ok(!fs.existsSync(path.join(root, name)), 'refuse Next automatic credential-file loading');
  }
  const snapshot = snapshotGeneratedArtifacts(root);
  const seed = await createAcceptanceSeed();
  const db = new Client({ connectionString: seed.database_url });
  let next: TrackedChild | null = null;
  const issues: string[] = [];
  const checks: string[] = [];
  const calls: string[] = [];
  let followUp = 0, editReview = 0;
  const stub = http.createServer(async (request, response) => {
    try {
      assert.ok(request.url?.endsWith('/chat/completions'));
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = record(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      const name = str(record(record(payload.response_format).json_schema).name);
      calls.push(name);
      let content: unknown;
      switch (name) {
        case 'follow_up_decision': content = ++followUp === 1 ? { decision: 'ask', question: '跳跃途中是否停下？', reason: '补充动作过程。' } : { decision: 'proceed', question: '', reason: '已有具体动作依据。' }; break;
        case 'observation_draft': content = DRAFT; break;
        case 'teacher_edit_review': content = ++editReview === 1 ? { decision: 'clarify', summary: '请核对动作描述。', change_summary: ['教师补充动作过程。'], fact_check: 'partially_supported', question: '是否观察到连续跳跃？' } : { decision: 'accept', summary: '修改内容有原始观察与教师澄清支持。', change_summary: ['核对动作过程。'], fact_check: 'supported', question: '' }; break;
        case 'growth_profile': content = PROFILE; break;
        case 'activity_support': content = { suggestions: [suggestion, { ...suggestion, title: '不同路线尝试' }] }; break;
        default: throw new Error('unexpected model protocol request: ' + name);
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ model: 'platform-flow-protocol-double', choices: [{ message: { content: JSON.stringify(content) } }] }));
    } catch { response.statusCode = 502; response.end('{}'); }
  });
  const check = (condition: unknown, label: string): void => { assert.ok(condition, label); checks.push(label); };
  try {
    await db.connect();
    // Only this disposable fixture's accounts; no credential files are read.
    const password = randomBytes(24).toString('base64url');
    const hashed = await hashPassword(password);
    await db.query('UPDATE app_accounts SET password_hash=$1 WHERE id=ANY($2::varchar[])', [hashed, Object.values(seed.manifest.accounts).map((account) => account.account_id)]);
    await new Promise<void>((resolve, reject) => { stub.once('error', reject); stub.listen(0, '127.0.0.1', resolve); });
    const stubAddress = stub.address();
    assert.ok(stubAddress && typeof stubAddress !== 'string');
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const logFile = path.join(path.dirname(seed.credentials_path), 'next.log');
    const env = { ...process.env, DATABASE_URL: seed.database_url, PGDATABASE_URL: '', AUTH_TRUSTED_ORIGINS: base, AUTH_SCHOOL_ID: seed.manifest.school_id, AUTH_COOKIE_SECURE: 'false', YAYA_PLATFORM_AUTH: '', LLM_PROVIDER: 'stepfun', STEPFUN_API_KEY: 'local-protocol-double', STEPFUN_BASE_URL: `http://127.0.0.1:${stubAddress.port}`, STEPFUN_MODEL: 'platform-flow-protocol-double', STEPFUN_TIMEOUT_MS: '10000', MEDIA_ENVIRONMENT: 'development', MEDIA_STORAGE_MODE: 'local', MEDIA_LOCAL_ROOT: seed.object_root, NEXT_TELEMETRY_DISABLED: '1' };
    const require = createRequire(import.meta.url);
    const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    next = trackChildProcess(child, { logFile });
    child.stdout?.on('data', (chunk: Buffer) => fs.appendFileSync(logFile, chunk));
    child.stderr?.on('data', (chunk: Buffer) => fs.appendFileSync(logFile, chunk));
    console.log(JSON.stringify({ stage: 'resources', seed_id: seed.seed_id, container_id: seed.container_id, port, pid: child.pid, created_at: next.startedAt, object_root: seed.object_root }));
    await waitForVerifiedService({ base, port, child: next, timeoutMs: 180_000, statusPath: '/api/auth/status' });
    const api = async (pathname: string, expected: number, session?: Session, body?: unknown): Promise<Record<string, unknown>> => {
      const response = await fetch(base + pathname, { method: body === undefined ? 'GET' : 'POST', headers: { ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}), origin: base, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120_000) });
      const parsed = record(await response.json());
      assert.equal(response.status, expected, `${pathname}: ${JSON.stringify(parsed)}`);
      checks.push(`${pathname} HTTP ${expected}`);
      return parsed;
    };
    const login = async (key: keyof typeof seed.manifest.accounts): Promise<Session> => {
      const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-cga-auth-request': '1' }, body: JSON.stringify({ username: seed.manifest.accounts[key].username, password }), signal: AbortSignal.timeout(120_000) });
      assert.equal(response.status, 200);
      const body = record(await response.json());
      check(record(body.state).kind === 'authenticated', `${key} authentic login`);
      const cookie = response.headers.getSetCookie().find((entry) => entry.startsWith('cga_session='))?.split(';')[0];
      assert.ok(cookie);
      return { cookie, csrf: str(record(body.csrf).token) };
    };
    const teacher = await login('teacher_a'), admin = await login('admin'), empty = await login('teacher_c');
    await api('/api/children', 401);
    await api('/api/children', 403, empty);
    const klass = seed.manifest.classes.class_a.id;
    await api('/api/children', 400, teacher, { name: '[合成]坏日期', gender: '男', birth_date: '2022-02-30', class_id: klass });
    const created = await api('/api/children', 201, teacher, { name: '[合成]链路检查', gender: '男', birth_date: '2022-06-01', class_id: klass });
    const childId = str(record(created.child).id);
    const today = isoDateInShanghai();
    const observationInput = { child_id: childId, observed_at: today, raw_text: RAW, context: '户外游戏' };
    await api('/api/observations', 403, admin, observationInput);
    await api('/api/observations', 403, { ...teacher, csrf: admin.csrf }, observationInput);
    const saved = await api('/api/observations', 201, teacher, observationInput);
    const observationId = str(record(saved.observation).id);
    const observationPath = `/api/observations/${observationId}`;
    const row = async () => (await db.query<{ raw_text: string; status: string; guide_evidence: { revision: number; links: Array<{ item_id: string; status: string; basis: Array<{ observation_id: string }> }> } | null }>('SELECT raw_text,status,guide_evidence FROM observations WHERE id=$1', [observationId])).rows[0];
    check((await row()).raw_text === RAW && (await row()).status === 'draft', 'original observation saved as draft');
    const asked = await api(observationPath + '/organize', 200, teacher, {});
    check(record(asked.observation).status === 'needs_input', 'necessary follow-up is persisted, not archived');
    const drafted = await api(observationPath + '/follow-up', 200, teacher, { action: 'answer', content: '连续跳跃途中没有停下。' });
    check(record(drafted.observation).status === 'ai_organized' && (await row()).raw_text === RAW, 'answer creates only AI draft, raw_text unchanged');
    const content = { ...DRAFT, objective_description: '幼儿连续跳过三条地面标线后回头告诉同伴。' };
    const decision = { item_id: seed.manifest.guide_items.behavior_item_id, support: 'single_event', basis: [{ observation_id: observationId, quote: QUOTE, quote_source: 'raw_text', quote_field: null }], adult_help_used: false };
    const confirm = { content, guide_decisions: { expected_guide_revision: 0, decisions: [decision] } };
    const clarify = await api(observationPath + '/confirm', 200, teacher, confirm);
    check(record(clarify.agentReview).decision === 'clarify' && record(clarify.guideEvidence).status === 'deferred' && (await row()).status === 'ai_organized', 'teacher edit review defers formal guide state');
    const accepted = await api(observationPath + '/confirm', 200, teacher, { ...confirm, clarification: '原始观察确实写明连续跳跃。' });
    check(record(accepted.agentReview).decision === 'accept' && (await row()).status === 'ai_organized', 'accepted edit still awaits teacher final confirmation');
    await api(observationPath + '/confirm', 400, teacher, { ...confirm, guide_decisions: { expected_guide_revision: 0, decisions: [{ ...decision, basis: [{ ...decision.basis[0], observation_id: 'missing-source' }] }] } });
    check((await row()).status === 'ai_organized' && (await row()).guide_evidence === null, 'invalid guide source rolls back archive and all decisions');
    const final = await api(observationPath + '/confirm', 200, teacher, confirm);
    check(record(final.observation).status === 'confirmed' && record(final.guideEvidence).status === 'applied', 'archive and guide decision commit together');
    const committed = await row();
    check(committed.raw_text === RAW && committed.guide_evidence?.links[0].basis[0].observation_id === observationId, 'archived original and exact guide source retained');
    await api(observationPath + '/organize', 409, teacher, {});
    await api(observationPath + '/confirm', 409, teacher, confirm);
    const book = await api(`/api/children/${childId}/evidence-book?scope=all_history`, 200, teacher);
    check(JSON.stringify(book).includes(observationId) && JSON.stringify(book).includes(QUOTE), 'personal evidence book preserves traceable source');
    check(guideItem(book, decision.item_id).status === 'confirmed_observed', 'selected personal guide item is formally confirmed');
    const overview = await api(`/api/classes/${klass}/evidence-overview?scope=custom_range&from=${today}&to=${today}`, 200, teacher);
    check(JSON.stringify(overview).includes(childId), 'same-period class overview includes the current child for drilldown');
    const item = guideItem(overview, decision.item_id);
    assert.ok(Array.isArray(item.children));
    const childState = item.children.map(record).find((entry) => entry.child_id === childId);
    check(childState?.status === 'confirmed_observed' && item.total === record(overview.roster).child_count, 'same-period drilldown agrees with the formal child status and original roster denominator');
    const profile = await api(`/api/children/${childId}/growth-profile`, 200, teacher, {});
    check(JSON.stringify(profile).includes(observationId), 'growth summary retains only confirmed source IDs');
    const activity = await api(`/api/children/${childId}/activity-support`, 200, teacher, {});
    check(JSON.stringify(activity).includes(observationId) && JSON.stringify(activity).includes(QUOTE), 'activity support is checked against confirmed evidence');
    await api(`/api/children/${childId}/growth-profile`, 403, admin, {});

    const photo = await syntheticSharedPhoto();
    const upload = async (): Promise<string> => {
      const form = new FormData();
      form.append('client_batch_id', 'platform-flow-http');
      form.append('files', new Blob([new Uint8Array(photo)], { type: 'image/png' }), 'synthetic.png');
      const response = await fetch(base + '/api/yaya/uploads', { method: 'POST', headers: { origin: base, cookie: teacher.cookie, 'x-csrf-token': teacher.csrf }, body: form });
      assert.equal(response.status, 200);
      const result = record(await response.json());
      assert.ok(Array.isArray(result.uploads));
      const item = record(result.uploads[0]);
      check(item.ok === true, 'HTTP upload reaches authenticated real metadata registration');
      return str(record(item.attachment).attachment_id);
    };
    const imageId = await upload();
    check(await upload() === imageId, 'HTTP upload idempotency retains original attachment identity');
    const confirmedTime = (await db.query<{ confirmed_at: Date }>('SELECT confirmed_at FROM observations WHERE id=$1', [observationId])).rows[0].confirmed_at.toISOString();
    await api(observationPath + '/attachments', 200, teacher, { image_ids: [imageId], source_confirmed_at: confirmedTime, expected_attachment_revision: 0 });
    check((await row()).raw_text === RAW, 'appended material does not rewrite raw observation');
    const bytes = await fetch(base + `/api/yaya/uploads/${imageId}/content`, { headers: { cookie: teacher.cookie } });
    check(bytes.status === 200 && (await bytes.arrayBuffer()).byteLength > 0, 'authorized material bytes via real HTTP');
    await api(`/api/yaya/uploads/${imageId}/content`, 403, empty);
    await api(`/api/classes/${seed.manifest.classes.class_b.id}/children`, 400, admin, { child_id: childId, start_date: '2026-02-30' });
    check(calls.every((name) => ['follow_up_decision', 'observation_draft', 'teacher_edit_review', 'growth_profile', 'activity_support'].includes(name)), 'only registered local protocol requests');
    console.log(JSON.stringify({ ok: true, passed: checks.length, checks, seed_id: seed.seed_id, model_protocol_calls: calls, real_model_requests: 0, layers: 'real Next HTTP + real AUTH/session/CSRF + disposable PG + protocol model double + local objects', NOT_RUN: ['browser/UI', 'real model quality', 'search/S3/hosted DB/deployment'] }));
  } finally {
    await runCleanupSteps([
      { label: 'next', run: () => next ? stopTrackedChildTree(next) : { ok: true, detail: 'not started' } },
      { label: 'model-double', run: () => new Promise<void>((resolve) => { stub.closeAllConnections(); stub.close(() => resolve()); }) },
      { label: 'db', run: () => db.end() },
      { label: 'seed', run: () => seed.teardown() },
      { label: 'generated', run: () => { const restored = restoreGeneratedArtifacts(snapshot, root); return { ok: restored.issues.length === 0, detail: restored.issues.join(';') }; } },
    ], (label, detail) => issues.push(`${label}: ${detail}`));
    assertCleanupComplete(issues);
    console.log(JSON.stringify({ stage: 'cleanup', seed_id: seed.seed_id, status: 'verified' }));
  }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'HTTP flow failed'); process.exitCode = 1; });
