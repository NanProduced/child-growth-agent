import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createYayaReadPorts } from '../src/lib/yaya/tools/read/ports';
import { createYayaReadRegistry } from '../src/lib/yaya/tools/read/registry';
import type { YayaReadPayload, YayaObservationFilters } from '../src/lib/yaya/tools/read/types';
import { projectObservation } from '../src/lib/accounts/scoped-queries';
import type { Observation } from '../src/lib/types';
import type { Principal } from '../src/lib/accounts/types';
import { runYayaAgent } from '../src/lib/yaya/agent/engine';
import type { YayaAgentDependencies } from '../src/lib/yaya/agent/types';
import { validateCommunicationModel, CommunicationError } from '../src/lib/family-communication';
import type { CommunicationSource } from '../src/lib/family-communication-contract';

const childId = randomUUID();
const principal: Principal = { account_id: randomUUID(), username: 'teacher', display_name: '老师', role: 'teacher', account_status: 'active', scope: { kind: 'classes', class_ids: [randomUUID()] } };
function observation(day: number): Observation {
  return { id: randomUUID(), child_id: childId, class_id: principal.scope.kind === 'classes' ? principal.scope.class_ids[0] : null,
    observed_at: `2026-09-${String(day).padStart(2, '0')}`, observed_class: null, context: '积木区', raw_text: `她把第${day}块积木放在桥面上。`, status: 'confirmed',
    confirmed_at: '2026-09-30T00:00:00Z', confirmed_content: { domain: '科学', sub_domain: '科学探究', objective_description: `她把第${day}块积木放在桥面上。`, highlights: [], support_suggestions: [], highlight_quote: '积木放在桥面上' },
    ai_draft: null, ai_model: null, ai_organized_at: null, agent_context: null, class_context_snapshot: null,
    is_demo: false, created_at: '2026-09-30T00:00:00Z', updated_at: null };
}
const originals = Array.from({ length: 5 }, (_, index) => observation(index + 1));
let rows = originals.map(row => projectObservation(row, 'full', principal));
let filters: YayaObservationFilters | undefined;
const registry = createYayaReadRegistry({ ports: { ...createYayaReadPorts(), listObservations: async input => { filters = input; return rows; } } });
const params = { child_id: childId, from: '2026-09-01', to: '2026-09-30', status: 'confirmed', include_content: true };
let passed = 0;
async function check(name: string, work: () => void | Promise<void>) { await work(); passed++; process.stdout.write(`PASS ${name}\n`); }
async function read(input: unknown = params) {
  const outcome = await registry.dispatch({ tool: 'list_observations', params: input }); assert.ok(outcome.ok);
  return outcome.data as YayaReadPayload<{ observations: Array<Record<string, unknown>>; truncated: boolean }>;
}
const sept: CommunicationSource = { id: randomUUID(), observed_at: '2026-09-02', context: '积木区', raw_text: '桥倒了，她把桥墩挪近，说：“这次小车能过去了。”', description: '她调整桥墩的位置。', fingerprint: 'a'.repeat(64) };
const oct: CommunicationSource = { id: randomUUID(), observed_at: '2026-10-08', context: '美工区', raw_text: '她给屋顶涂了红色，说：“我还想画门前的花。”', description: '她画了房子。', fingerprint: 'b'.repeat(64) };
const model = { stories: [
  { observation_id: sept.id, text: '搭桥时，她把桥墩挪近，说：“这次小车能过去了。”', quote: '这次小车能过去了' },
  { observation_id: oct.id, text: '画画时，她给屋顶涂了红色，说：“我还想画门前的花。”', quote: '我还想画门前的花' },
], suggestion: '在家可以一起试试搭一座小桥，听听孩子的想法。' };

async function main() {
  await check('monthly batch returns all five bodies in one read', async () => { const result = await read(); assert.equal(result.data.observations.length, 5); assert.equal(result.data.observations[4].raw_text, originals[4].raw_text); assert.equal(result.data.truncated, false); });
  await check('date range reaches the scoped port before row limit', async () => { await read(); assert.equal(filters?.from, '2026-09-01'); assert.equal(filters?.to, '2026-09-30'); });
  await check('all loaded observation dependencies survive', async () => { const result = await read(); for (const row of originals) assert.ok(result.recheck_dependencies.some(ref => ref.ref_id === `observation:${row.id}`)); });
  for (const invalid of [{ ...params, child_id: undefined }, { ...params, from: '2026-02-30' }, { ...params, from: '2026-10-01' }, { ...params, limit: 61 }]) {
    await check('invalid content batch is rejected', async () => assert.equal((await registry.dispatch({ tool: 'list_observations', params: invalid })).ok, false));
  }
  await check('legacy index remains metadata only', async () => { const result = await read({}); assert.equal(result.data.observations[0].raw_text, undefined); });
  await check('empty batch is a complete empty result', async () => { rows = []; const result = await read(); assert.equal(result.data.observations.length, 0); assert.equal(result.data.truncated, false); });
  await check('record cap never pretends a complete month', async () => { rows = Array.from({ length: 61 }, () => projectObservation(observation(1), 'full', principal)); const result = await read(); assert.equal(result.data.observations.length, 60); assert.equal(result.data.truncated, true); });
  await check('content cap is explicit not false empty data', async () => { rows = [projectObservation({ ...observation(1), raw_text: '长'.repeat(60001) }, 'full', principal)]; const result = await read(); assert.equal(result.data.observations.length, 0); assert.equal(result.data.truncated, true); });
  rows = originals.map(row => projectObservation(row, 'full', principal));
  await check('five-record review finishes below four tool steps', async () => {
    let calls = 0; const identity = { run_id: 'repair-check', identity_state: 'authenticated' as const, principal, session_valid: true };
    const deps: YayaAgentDependencies = { model: { generate: async () => { calls++; return { content: calls === 1 ? JSON.stringify({ action: 'read', content: '', tool: 'list_observations', params_json: JSON.stringify(params), source_refs: [] }) : JSON.stringify({ action: 'answer', content: '这五条观察记录了孩子搭桥时的具体尝试。', tool: '', params_json: '', source_refs: ['observations:current_scope'] }), provider: 'stepfun', model: 'in-process-double', usage: null }; } },
      tools: { read_tools: registry.definitions, write_tools: [] }, resolveCurrentIdentity: async () => identity,
      loadProjectedContext: async () => ({ history: [], sources: [], images: [], guide_catalog: null }), revalidateProjectedContext: async () => ({ ok: true }),
      readTool: registry.readTool, proposeWrite: async () => { throw Error('No writes'); }, queryOperation: async () => ({ kind: 'unknown', reason: 'no_receipt' }),
      publicSearchPolicy: { provider_enabled: false, scanChildIdentifiers: async () => 'unknown' } };
    const result = await runYayaAgent(deps, { run_id: 'repair-check', user_text: '回顾这个月的观察', attachment_ids: [] }); assert.equal(result.outcome.kind, 'answered'); assert.equal(calls, 2);
  });
  await check('September and October dates are taken from their own records', () => { const output = validateCommunicationModel(model, [sept, oct], []); assert.ok(output.text.includes('2026年9月2日')); assert.ok(output.text.includes('2026年10月8日')); });
  await check('single-month umbrella for a different-month story is rejected', () => assert.throws(() => validateCommunicationModel({ ...model, stories: [{ ...model.stories[1], text: '九月里，' + model.stories[1].text }] }, [sept, oct], []), (error: unknown) => error instanceof CommunicationError && error.code === 'invalid_time_binding'));
  await check('wrong source quote cannot be attached to another date', () => assert.throws(() => validateCommunicationModel({ ...model, stories: [{ ...model.stories[1], observation_id: sept.id }] }, [sept, oct], [])));
  await check('duplicate observation cannot pretend two different dated stories', () => assert.throws(() => validateCommunicationModel({ ...model, stories: [model.stories[0], model.stories[0]] }, [sept, oct], [])));
  await check('cross-year stories retain their own years and chronological order', () => { const december = { ...sept, observed_at: '2025-12-31' }, january = { ...oct, observed_at: '2026-01-02' }; const result = validateCommunicationModel({ ...model, stories: [...model.stories].reverse() }, [december, january], []); assert.ok(result.text.indexOf('2025年12月31日') < result.text.indexOf('2026年1月2日')); });
  await check('unverified time in family advice is rejected', () => assert.throws(() => validateCommunicationModel({ ...model, suggestion: '九月里她已经很会画画，在家可以继续画。' }, [sept, oct], [])));
  await check('known child speech mentioning a month is kept literally', () => { const speech = { ...oct, raw_text: '她画了花，说：“九月里妈妈带我看过花。”' }; const output = validateCommunicationModel({ stories: [{ observation_id: speech.id, text: '她画了花，说：“九月里妈妈带我看过花。”', quote: '九月里妈妈带我看过花' }], suggestion: '' }, [speech], []); assert.ok(output.text.includes('九月里妈妈带我看过花')); });
  await check('a numbered toy is not mistaken for a calendar date', () => { const toy = { ...oct, raw_text: '她把3号玩具小车推上桥，然后调整了积木。' }; const output = validateCommunicationModel({ stories: [{ observation_id: toy.id, text: toy.raw_text, quote: '玩具小车推上桥' }], suggestion: '' }, [toy], []); assert.ok(output.text.includes('3号玩具小车')); });
  console.log(JSON.stringify({ passed, real_model_requests: 0, evidence: 'pure+registry+engine_model_double' }));
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
