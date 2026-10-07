/** 正式路由组合检查：真实 Next/AUTH/PG/TOOLS/DATA，模型只用自有回环替身。 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { Client } from 'pg';
import { createAcceptanceSeed, type AcceptanceSeedHandle } from './acceptance/seed';
import { findListeningPids, trackChildProcess, stopTrackedChildTree, waitForVerifiedService, snapshotGeneratedArtifacts, restoreGeneratedArtifacts, runCleanupSteps, assertCleanupComplete, type TrackedChild } from '../harness-safety';
import { parseYayaRunWireLine, validateYayaRunEventStream } from '../../src/lib/yaya/api-contract';
import { isoDateInShanghai } from '../../src/lib/format';
import { saveMessageResponseSchema, conversationMessagesResponseSchema } from '../../src/components/yaya/client/schemas';
const ROOT = process.cwd(), RUN = 'final-wire-' + randomUUID().slice(0, 8);
const PRODUCTION = process.env.YAYA_TEST_PRODUCTION === '1';
const REAL_TEXT = process.env.YAYA_REAL_TEXT_SMOKE === '1';
let passed = 0;
function check(label: string, condition: unknown): void { assert.ok(condition, label); passed++; console.log('ok - ' + label); }
type Proposal = { proposal_id: string; batch_id: string; items: Array<{ operation_id: string; target_label?: string; payload: unknown }> };
async function main(): Promise<void> {
  let seed: AcceptanceSeedHandle | null = null, db: Client | null = null, stub: Server | null = null, tracked: TrackedChild | null = null;
  const snapshot = snapshotGeneratedArtifacts(ROOT), issues: string[] = [];
  const log = path.join(tmpdir(), RUN + '.log');
  let mode: 'query' | 'create' | 'organize' | 'confirm' = 'query', turn = 0, modelCalls = 0, unexpected = 0, observationId = '';
  let providerLock: string | null = null;
  const ledgerDir = path.join(ROOT, 'logs/yaya-provider-smoke-20');
  const ledger = path.join(ledgerDir, 'requests.jsonl');
  const stepfun: Record<string, string> = {};
  const raw = '[合成]王一诺把积木搭成一条路，倒塌后换了一个更宽的底座，并说我换一个更宽的底座。';
  const draft = { domain: '科学', sub_domain: '科学探究', objective_description: '尝试通过调整积木结构解决搭建问题', highlights: ['尝试调整底座后继续搭建'], support_suggestions: ['提供不同大小的积木，支持幼儿继续探索'], highlight_quote: '我换一个更宽的底座' };
  try {
    if (REAL_TEXT) {
      const envFile = process.env.YAYA_STEPFUN_ENV_FILE;
      if (!envFile) throw Error('Specify a credential source file; no database configuration is imported.');
      const allowed = new Set(['STEPFUN_API_KEY', 'STEPFUN_BASE_URL', 'STEPFUN_MODEL']);
      for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
        const pair = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
        if (!pair || !allowed.has(pair[1]!)) continue;
        let value = pair[2]!.trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        stepfun[pair[1]!] = value;
      }
      if (!stepfun.STEPFUN_API_KEY) throw Error('StepFun credential unavailable.');
      const endpoint = new URL(stepfun.STEPFUN_BASE_URL ?? 'https://api.stepfun.com/step_plan/v1');
      if (endpoint.protocol !== 'https:' || endpoint.host !== 'api.stepfun.com') throw Error('Only the verified StepFun HTTPS endpoint is allowed.');
      fs.mkdirSync(ledgerDir, { recursive: true });
      const lockPath = path.join(ledgerDir, 'active.lock');
      fs.closeSync(fs.openSync(lockPath, 'wx')); providerLock = lockPath;
      const meta = path.join(ledgerDir, 'approval.json');
      if (!fs.existsSync(meta)) fs.writeFileSync(meta, JSON.stringify({ approval: 'user-new-20', limit: 20, text_ceiling: 12, old_40_ledger_untouched: true }, null, 2), { flag: 'wx' });
      const approval: unknown = JSON.parse(fs.readFileSync(meta, 'utf8'));
      assert.deepEqual(approval, { approval: 'user-new-20', limit: 20, text_ceiling: 12, old_40_ledger_untouched: true });
    }
    seed = await createAcceptanceSeed(); const fixture = seed;
    db = new Client({ connectionString: fixture.database_url }); await db.connect();
    const childId = fixture.manifest.children.class_a_same_name.id;
    stub = createServer((request, response) => {
      let body = ''; request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      request.on('end', () => { void (async () => {
        if (REAL_TEXT) {
          const entries = fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean) : [];
          if (entries.length >= 12) { response.writeHead(429, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Text smoke quota reached; no upstream request sent.' } })); return; }
          fs.appendFileSync(ledger, JSON.stringify({ number: entries.length + 1, provider: 'stepfun', run: RUN, reserved_at: new Date().toISOString() }) + '\n');
          modelCalls++;
          try {
            const input = JSON.parse(body) as Record<string, unknown>;
            input.model = stepfun.STEPFUN_MODEL ?? 'step-5-preview';
            const target = (stepfun.STEPFUN_BASE_URL ?? 'https://api.stepfun.com/step_plan/v1').replace(/\/+$/, '') + '/chat/completions';
            const upstream = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + stepfun.STEPFUN_API_KEY }, body: JSON.stringify(input), signal: AbortSignal.timeout(60000) });
            const content = await upstream.text();
            let publicResult: unknown = null;
            try {
              const result = JSON.parse(content) as { model?: unknown; choices?: Array<{ message?: { content?: unknown } }>; usage?: unknown };
              publicResult = { model: result.model ?? input.model, content: result.choices?.[0]?.message?.content ?? null, usage: result.usage ?? null };
            } catch { /* Never persist arbitrary upstream error text. */ }
            fs.appendFileSync(path.join(ledgerDir, RUN + '-model-outputs.jsonl'), JSON.stringify({ number: entries.length + 1, status: upstream.status, response_format: (input.response_format as { json_schema?: { name?: string } } | undefined)?.json_schema?.name ?? null, result: publicResult }) + '\n');
            response.writeHead(upstream.status, { 'content-type': 'application/json' }); response.end(content);
          } catch { response.writeHead(502, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Real provider call failed; counted, not automatically retried by proxy.' } })); }
          return;
        }
        modelCalls++;
        try {
          const input = JSON.parse(body) as { response_format?: { json_schema?: { name?: string } } };
          const schema = input.response_format?.json_schema?.name;
          let output: unknown;
          if (schema === 'follow_up_decision') output = { decision: 'proceed', question: '', reason: '原文包含足够的具体行为与语言。' };
          else if (schema === 'observation_draft') output = draft;
          else if (schema === 'teacher_edit_review') output = { decision: 'accept', summary: '教师确认稿与原始事实一致。', change_summary: [], fact_check: 'supported', question: '' };
          else if (mode === 'query') output = turn++ === 0 ? { action: 'read', tool: 'list_children', params_json: '{}', content: '', source_refs: [] } : { action: 'answer', tool: '', params_json: '', content: '已读取当前负责班级的合成名册。', source_refs: ['children:current_scope'] };
          else {
            const tool = mode === 'create' ? 'create_observation' : mode === 'organize' ? 'organize_observation' : 'confirm_observation';
            const params = mode === 'create' ? { child_id: childId, observed_at: isoDateInShanghai(), raw_text: raw, context: '积木区' } : mode === 'organize' ? { observation_id: observationId } : { observation_id: observationId, input: { content: draft } };
            output = { action: 'propose_write', tool, params_json: JSON.stringify(params), content: '', source_refs: [] };
          }
          response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        } catch { unexpected++; response.writeHead(500); response.end('invalid synthetic model request'); }
      })(); });
    });
    await new Promise<void>(resolve => stub!.listen(0, '127.0.0.1', resolve)); const address = stub.address(); assert.ok(address && typeof address === 'object');
    let port = 0;
    for (let i = 0; i < 50; i++) { const candidate = 23000 + Math.floor(Math.random() * 5000); const found = findListeningPids(candidate); if (!found.ok) throw Error(found.detail); if (!found.pids.length) { port = candidate; break; } }
    assert.ok(port); const base = 'http://127.0.0.1:' + port;
    const child = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['exec', 'next', PRODUCTION ? 'start' : 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: ROOT, windowsHide: true, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: {
        ...process.env, DATABASE_URL: fixture.database_url, PGDATABASE_URL: '', AUTH_TRUSTED_ORIGINS: base, AUTH_SCHOOL_ID: fixture.manifest.school_id,
        AUTH_COOKIE_SECURE: 'false', LLM_PROVIDER: 'stepfun', STEPFUN_BASE_URL: 'http://127.0.0.1:' + address.port, STEPFUN_API_KEY: 'synthetic-local-only', STEPFUN_MODEL: REAL_TEXT ? stepfun.STEPFUN_MODEL ?? 'step-5-preview' : 'final-wire-double',
        MEDIA_ENVIRONMENT: 'development', MEDIA_STORAGE_MODE: 'local', MEDIA_LOCAL_ROOT: fixture.object_root, NEXT_TELEMETRY_DISABLED: '1',
      },
    });
    tracked = trackChildProcess(child, { logFile: log });
    child.stdout?.on('data', (chunk: Buffer) => fs.appendFileSync(log, chunk)); child.stderr?.on('data', (chunk: Buffer) => fs.appendFileSync(log, chunk));
    await waitForVerifiedService({ base, port, child: tracked, timeoutMs: 180000, statusPath: '/api/auth/status' });
    const credentials = JSON.parse(fs.readFileSync(fixture.credentials_path, 'utf8')) as { accounts: Record<string, { username: string; password: string }> };
    const login = async (key: string) => {
      const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-cga-auth-request': '1' }, body: JSON.stringify(credentials.accounts[key]) });
      check('真实账号登录 ' + key, response.status === 200);
      const cookie = response.headers.getSetCookie().find(value => value.startsWith('cga_session='))?.split(';')[0]; assert.ok(cookie);
      const status = await fetch(base + '/api/auth/status', { headers: { cookie } }); const view = await status.json() as { csrf: { token: string } | null };
      assert.ok(view.csrf?.token); return { cookie, csrf: view.csrf.token };
    };
    const teacher = await login('teacher_a');
    if (process.env.YAYA_TEST_BROWSER === '1') {
      const initialBrowserCount = Number((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM observations WHERE raw_text=$1', [raw])).rows[0]!.n);
      const runBrowser = createRequire(import.meta.url)('./check-final-browser.cjs') as (input: { base: string; cookie: string; setMode: (value: typeof mode) => void; verifyObservation: (saved: boolean) => Promise<void>; out: string }) => Promise<unknown>;
      await runBrowser({ base, cookie: teacher.cookie, setMode: value => { mode = value; turn = 0; }, verifyObservation: async saved => {
        const rows = await db!.query<{ raw_text: string; status: string }>('SELECT raw_text,status FROM observations WHERE raw_text=$1', [raw]);
        assert.equal(rows.rowCount, initialBrowserCount + (saved ? 1 : 0));
        if (saved) assert.ok(rows.rows.some(row => row.raw_text === raw && row.status === 'draft'));
      }, out: path.join(ROOT, 'output/playwright/final-wiring') });
      mode = 'query'; turn = 0;
    }
    const bootstrap = await fetch(base + '/assistant', { headers: { cookie: teacher.cookie } });
    const bootstrapHtml = await bootstrap.text();
    console.log(JSON.stringify({ bootstrap_status: bootstrap.status, session_token_present: bootstrapHtml.includes(teacher.cookie.slice('cga_session='.length)) }));
    if (bootstrap.status !== 200 && fs.existsSync(log)) console.error(fs.readFileSync(log, 'utf8').split('\n').filter(line => /Error:|ReferenceError:|SyntaxError:/.test(line)).slice(-5).join('\n'));
    check('真实助手页面可渲染', bootstrap.status === 200);
    if (PRODUCTION) check('生产页面不序列化 HttpOnly 会话令牌', !bootstrapHtml.includes(teacher.cookie.slice('cga_session='.length)));
    else check('客户端认证 props 使用既有公开状态白名单（静态；非生产响应证明）', !/auth=\{resolved\}/.test(fs.readFileSync(path.join(ROOT, 'src/app/layout.tsx'), 'utf8')));
    const json = async (endpoint: string, method: 'GET' | 'POST', body?: unknown, auth = teacher) => {
      const response = await fetch(base + endpoint, { method, headers: { cookie: auth.cookie, origin: base, 'content-type': 'application/json', ...(method === 'POST' ? { 'x-csrf-token': auth.csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value: unknown = await response.json(); return { response, value };
    };
    if (REAL_TEXT) {
      const created = await json('/api/yaya/conversations', 'POST', {});
      assert.equal(created.response.status, 201);
      const cid = (created.value as { conversation: { conversation_id: string } }).conversation.conversation_id;
      const observations = async () => Number((await db!.query<{ n: string }>('SELECT count(*)::text AS n FROM observations WHERE child_id=$1', [childId])).rows[0]!.n);
      const startCount = await observations();
      const report: unknown[] = [];
      const recordOnly = process.env.YAYA_SMOKE_RECORD_ONLY === '1';
      const cases = recordOnly ? ['请为松果班的王一诺准备一条观察，观察日期 ' + isoDateInShanghai() + '，情境是积木区。原文必须逐字保留：' + raw] : ['幼儿在积木倒塌后有些挫败，教师可以怎样回应？请给两条不贴标签的建议。', '查一下我负责班级的幼儿名册，只使用平台实际读取的数据。', '请为松果班的王一诺记录今天在积木区的观察。原文：' + raw];
      let approvedWrite = false;
      for (const text of cases) {
        const view = await json('/api/yaya/conversations/' + cid, 'GET');
        const revision = (view.value as { conversation: { revision: number } }).conversation.revision;
        const user = await json('/api/yaya/conversations/' + cid + '/messages', 'POST', { conversation_id: cid, client_message_id: randomUUID(), role: 'user', message_kind: 'text', execution_state: 'none', fragments: [{ fragment_id: randomUUID(), text, sources: [], independently_readable: true, provenance: { kind: 'raw_input', ref_id: null, label: null, derived_from: null } }], attachment_ids: [], expected_conversation_revision: revision });
        assert.equal(user.response.status, 201);
        const saved = user.value as { message: { message_id: string }; conversation: { revision: number } };
        const result = await fetch(base + '/api/yaya/conversations/' + cid + '/runs', { method: 'POST', headers: { cookie: teacher.cookie, origin: base, 'content-type': 'application/json', 'x-csrf-token': teacher.csrf }, body: JSON.stringify({ conversation_id: cid, client_request_id: saved.message.message_id, user_text: text, attachment_ids: [], expected_conversation_revision: saved.conversation.revision }) });
        const wire = await result.text(); assert.equal(result.status, 200);
        const events = wire.trim().split('\n').map(line => { const event = parseYayaRunWireLine(line); assert.ok(event.ok); return event.value; });
        const outcome = validateYayaRunEventStream(events); assert.ok(outcome.ok);
        report.push({ user: text, outcome: outcome.outcome, events });
        check('真实模型未批准不产生观察写入', await observations() === startCount);
        console.log(JSON.stringify({ smoke_turn: report.length, outcome: outcome.outcome.kind, provider_calls_this_run: modelCalls }));
        if (recordOnly && outcome.outcome.kind === 'proposed') {
          const pid = outcome.outcome.proposals[0]!.proposal_id;
          const projected = await json('/api/yaya/proposals?proposal_id=' + encodeURIComponent(pid), 'GET');
          const proposal = (projected.value as { proposal: Proposal }).proposal;
          const payload = proposal.items[0]?.payload as { kind?: string; child_id?: string; raw_text?: string; observed_at?: string } | undefined;
          assert.equal(proposal.items.length, 1); assert.equal(payload?.kind, 'create_observation');
          assert.equal(payload?.child_id, childId); assert.equal(payload?.raw_text, raw); assert.equal(payload?.observed_at, isoDateInShanghai());
          const operationIds = proposal.items.map(item => item.operation_id);
          const approval = await json('/api/yaya/proposals/' + pid + '/approval', 'POST', { action: 'approve', operation_ids: operationIds });
          assert.equal(approval.response.status, 201);
          // Explicit test-harness approval of a verified synthetic payload, not model approval.
          const performed = await json('/api/yaya/operations', 'POST', { approval_id: (approval.value as { approval: { approval_id: string } }).approval.approval_id, operation_ids: operationIds });
          assert.equal(performed.response.status, 200);
          const receipts = (performed.value as { receipts: Array<{ status: string; effect: string }> }).receipts;
          check('真实模型准备+显式测试批准后原文准确落库', await observations() === startCount + 1 && receipts[0]?.status === 'saved' && receipts[0].effect === 'committed');
          approvedWrite = true; report.push({ approval_layer: 'explicit harness approval, not browser/HITL usability evidence', receipts: performed.value });
        }
        // Distinct user requests, never an automatic replay of a failed run.
      }
      fs.writeFileSync(path.join(ledgerDir, RUN + '-report.json'), JSON.stringify({ report, real_model_requests: modelCalls, synthetic_only: true, writes_approved: approvedWrite }, null, 2));
      console.log(JSON.stringify({ real_model_requests: modelCalls, ledger, remaining: 20 - (fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).length : 0) }));
      return;
    }
    const created = await json('/api/yaya/conversations', 'POST', {}); check('创建正式会话', created.response.status === 201);
    const conversation = (created.value as { conversation: { conversation_id: string } }).conversation.conversation_id;
    const send = async (text: string, beforeRun?: (requestId: string) => Promise<void>) => {
      turn = 0;
      const detail = await json('/api/yaya/conversations/' + conversation, 'GET'); const revision = (detail.value as { conversation: { revision: number } }).conversation.revision;
      const saved = await json('/api/yaya/conversations/' + conversation + '/messages', 'POST', { conversation_id: conversation, client_message_id: randomUUID(), role: 'user', message_kind: 'text', execution_state: 'none', fragments: [{ fragment_id: randomUUID(), text, sources: [], independently_readable: true, provenance: { kind: 'raw_input', ref_id: null, label: null, derived_from: null } }], attachment_ids: [], expected_conversation_revision: revision });
      check('用户消息经 HTTP 唯一通道保存', saved.response.status === 201);
      check('实际保存 DTO 通过浏览器共享解析器', saveMessageResponseSchema.safeParse(saved.value).success);
      const data = saved.value as { conversation: { revision: number }; message: { message_id: string } };
      const body = { conversation_id: conversation, client_request_id: data.message.message_id, user_text: text, attachment_ids: [], expected_conversation_revision: data.conversation.revision };
      if (beforeRun) await beforeRun(body.client_request_id);
      const response = await fetch(base + '/api/yaya/conversations/' + conversation + '/runs', { method: 'POST', headers: { cookie: teacher.cookie, origin: base, 'x-csrf-token': teacher.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const rawResponse = await response.text(); check('正式运行 HTTP 200', response.status === 200);
      const events = rawResponse.trim().split('\n').map(line => { const parsed = parseYayaRunWireLine(line); assert.ok(parsed.ok); return parsed.value; });
      const verdict = validateYayaRunEventStream(events); assert.ok(verdict.ok); check('运行事件唯一一致终态', verdict.ok);
      return { outcome: verdict.outcome, request: body };
    };
    const query = await send('[合成]查看我负责的班级名册。'); check('真实读取后回答', query.outcome.kind === 'answered');
    const history = await json('/api/yaya/conversations/' + conversation + '/messages', 'GET');
    check('实际历史 DTO 通过浏览器共享解析器', conversationMessagesResponseSchema.safeParse(history.value).success);
    const messages = (history.value as { messages: Array<{ role: string; recovery: unknown; fragments: Array<{ text: string | null }> }> }).messages;
    check('服务器权威助手消息与恢复标记已保存', messages.some(message => message.role === 'assistant' && message.recovery && message.fragments.some(fragment => fragment.text === '已读取当前负责班级的合成名册。')));
    mode = 'create'; const before = Number((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM observations WHERE child_id=$1', [childId])).rows[0]!.n);
    const proposed = await send('[合成]请为松果班王一诺记录今天在积木区的观察。'); check('写工具正式装配返回提案', proposed.outcome.kind === 'proposed');
    check('未批准无业务观察写入', Number((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM observations WHERE child_id=$1', [childId])).rows[0]!.n) === before);
    const execute = async (proposalId: string) => {
      const loaded = await json('/api/yaya/proposals?proposal_id=' + encodeURIComponent(proposalId), 'GET'); check('提案经当前授权完整投影', loaded.response.status === 200);
      const proposal = (loaded.value as { proposal: Proposal }).proposal;
      check('可读目标来自服务端真实对象', typeof proposal.items[0]?.target_label === 'string');
      const approved = await json('/api/yaya/proposals/' + proposalId + '/approval', 'POST', { action: 'approve', operation_ids: proposal.items.map(item => item.operation_id) }); check('可信人工批准', approved.response.status === 201);
      const approval = (approved.value as { approval: { approval_id: string } }).approval.approval_id;
      const request = { approval_id: approval, operation_ids: proposal.items.map(item => item.operation_id) };
      const performed = await json('/api/yaya/operations', 'POST', request); check('真实业务执行 HTTP', performed.response.status === 200);
      const receipts = (performed.value as { receipts: Array<{ status: string; effect: string; business_object_id: string }> }).receipts;
      check('真实业务成功回执', receipts?.[0]?.status === 'saved' && receipts[0].effect === 'committed');
      return { request, id: receipts[0].business_object_id };
    };
    assert.equal(proposed.outcome.kind, 'proposed'); if (proposed.outcome.kind !== 'proposed') throw Error('missing proposal');
    const creation = await execute(proposed.outcome.proposals[0]!.proposal_id); observationId = creation.id;
    const replay = await json('/api/yaya/operations', 'POST', creation.request); check('操作原身份幂等回放', replay.response.status === 200);
    check('实际只创建一条观察且原文未改写', Number((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM observations WHERE child_id=$1', [childId])).rows[0]!.n) === before + 1 && (await db.query<{ raw_text: string }>('SELECT raw_text FROM observations WHERE id=$1', [observationId])).rows[0]?.raw_text === raw);
    mode = 'organize'; const organize = await send('[合成]整理刚才的观察。'); assert.equal(organize.outcome.kind, 'proposed');
    if (organize.outcome.kind === 'proposed') await execute(organize.outcome.proposals[0]!.proposal_id);
    check('整理只是草稿，未正式归档', (await db.query<{ status: string }>('SELECT status FROM observations WHERE id=$1', [observationId])).rows[0]?.status === 'ai_organized');
    mode = 'confirm'; const confirm = await send('[合成]我已核对草稿，请准备归档。'); assert.equal(confirm.outcome.kind, 'proposed');
    if (confirm.outcome.kind === 'proposed') await execute(confirm.outcome.proposals[0]!.proposal_id);
    check('教师确认后正式归档且原文不变', (await db.query<{ status: string; raw_text: string }>('SELECT status,raw_text FROM observations WHERE id=$1', [observationId])).rows[0]?.status === 'confirmed' && (await db.query<{ raw_text: string }>('SELECT raw_text FROM observations WHERE id=$1', [observationId])).rows[0]?.raw_text === raw);
    const callsBeforeReplay = modelCalls;
    const repeat = await fetch(base + '/api/yaya/conversations/' + conversation + '/runs', { method: 'POST', headers: { cookie: teacher.cookie, origin: base, 'x-csrf-token': teacher.csrf, 'content-type': 'application/json' }, body: JSON.stringify(query.request) });
    check('权威助手消息推进版本后原运行仍可幂等回放', repeat.status === 200 && (await repeat.text()).includes('已读取当前负责班级的合成名册。') && modelCalls === callsBeforeReplay);
    mode = 'query';
    const fault = await send('[合成]验证终态与助手消息原子回滚。', async (id) => {
      assert.ok(/^[0-9a-f-]+$/.test(id));
      await db!.query(`CREATE FUNCTION final_wire_message_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.role='assistant' AND NEW.recovery_mark->'run'->>'client_request_id'='${id}' THEN RAISE EXCEPTION 'owned message fault'; END IF; RETURN NEW; END $$; CREATE TRIGGER final_wire_message_fault BEFORE INSERT ON yaya_messages FOR EACH ROW EXECUTE FUNCTION final_wire_message_fault()`);
    });
    check('助手消息落账故障不显示成功终局', fault.outcome.kind === 'stopped');
    const faultRow = (await db.query<{ id: string; state: string; outcome: unknown }>('SELECT id,state,outcome FROM yaya_runs WHERE client_request_id=$1', [fault.request.client_request_id])).rows[0]!;
    check('故障时终态与权威消息没有半提交', faultRow.state === 'interrupted' && faultRow.outcome === null && Number((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM yaya_messages WHERE run_id=$1', [faultRow.id])).rows[0]!.n) === 0);
    await db.query('DROP TRIGGER final_wire_message_fault ON yaya_messages; DROP FUNCTION final_wire_message_fault()');
    const stranger = await login('teacher_b'); const denied = await json('/api/yaya/conversations/' + conversation + '/messages', 'GET', undefined, stranger); check('其他教师不能读取会话', denied.response.status === 404);
    const bad = await json('/api/yaya/conversations/' + conversation + '/messages', 'POST', { role: 'assistant' }); check('浏览器不得写助手消息', bad.response.status === 400);
    const lateMessage = await send('[合成]消息保存等待跨过会话期限。', async id => {
      assert.ok(/^[0-9a-f-]+$/.test(id));
      await db!.query(`CREATE FUNCTION final_wire_expiry_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.role='assistant' AND NEW.recovery_mark->'run'->>'client_request_id'='${id}' THEN UPDATE app_sessions SET expires_at=clock_timestamp()+interval '50 milliseconds' WHERE id=(SELECT session_id FROM yaya_runs WHERE client_request_id='${id}'); PERFORM pg_sleep(0.1); END IF; RETURN NEW; END $$; CREATE TRIGGER final_wire_expiry_fault BEFORE INSERT ON yaya_messages FOR EACH ROW EXECUTE FUNCTION final_wire_expiry_fault()`);
    });
    check('消息落账阶段跨期不发布成功', lateMessage.outcome.kind === 'stopped' && lateMessage.outcome.reason === 'session_invalid');
    const expiredRow = (await db.query<{ id: string; state: string }>('SELECT id,state FROM yaya_runs WHERE client_request_id=$1', [lateMessage.request.client_request_id])).rows[0]!;
    check('消息跨期运行与正文一起回滚', expiredRow.state === 'interrupted' && Number((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM yaya_messages WHERE run_id=$1', [expiredRow.id])).rows[0]!.n) === 0);
    await db.query('DROP TRIGGER final_wire_expiry_fault ON yaya_messages; DROP FUNCTION final_wire_expiry_fault()');
    check('无未登记模型请求', unexpected === 0);
    console.log(JSON.stringify({ passed, model_double_calls: modelCalls, real_model_requests: 0, layers: 'real Next HTTP/auth/PG/toolkit/message binding; local protocol model double', run: RUN }));
  } finally {
    await runCleanupSteps([
      { label: 'server', run: async () => { if (tracked) { const result = await stopTrackedChildTree(tracked); if (!result.ok) throw Error(result.detail); } } },
      { label: 'generated', run: () => { const result = restoreGeneratedArtifacts(snapshot, ROOT); if (result.issues.length) throw Error(result.issues.join(';')); } },
      { label: 'database', run: async () => { await db?.end(); } },
      { label: 'stub', run: async () => { if (stub) await new Promise<void>((resolve, reject) => stub!.close(error => error ? reject(error) : resolve())); } },
      { label: 'seed', run: async () => { await seed?.teardown(); } },
      { label: 'own-log', run: () => { if (fs.existsSync(log)) fs.unlinkSync(log); } },
      { label: 'provider-lock', run: () => { if (providerLock) fs.unlinkSync(providerLock); } },
    ], (label, detail) => issues.push(label + ':' + detail));
    assertCleanupComplete(issues); console.log(JSON.stringify({ cleanup: 'verified', real_model_requests: REAL_TEXT ? modelCalls : 0 }));
  }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
