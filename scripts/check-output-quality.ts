import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { COMMUNICATION_SYSTEM_PROMPT, validateCommunicationModel } from '../src/lib/family-communication';
import { GROWTH_PROFILE_SYSTEM_PROMPT, generateGrowthProfile } from '../src/lib/ai';
import type { CommunicationSource } from '../src/lib/family-communication-contract';
import type { Observation } from '../src/lib/types';
import type { invokeLlm } from '../src/lib/llm';

let passed = 0;
const failures: string[] = [];
async function check(name: string, test: () => void | Promise<void>) {
  try { await test(); passed++; } catch { failures.push(name); }
}
const sources: CommunicationSource[] = [
  { id: randomUUID(), observed_at: '2026-09-07', context: '自然角', raw_text: '她指着圆叶和长叶说：“这两盆的叶子不一样。”又摸了摸落叶。', description: '她比较了叶子的形状。', fingerprint: 'a'.repeat(64) },
  { id: randomUUID(), observed_at: '2026-10-10', context: '骑行区', raw_text: '她双脚交替蹬地，让平衡车向前移动，在转弯处停下。', description: '她骑平衡车向前移动并停车。', fingerprint: 'b'.repeat(64) },
];
const stories = [
  { observation_id: sources[0].id, focus: '科学', text: '在自然角，她比较叶子，说：“这两盆的叶子不一样。”这次比较是探索植物外形的一次尝试。', quote: '这两盆的叶子不一样' },
  { observation_id: sources[1].id, focus: '健康', text: '骑行时，她“双脚交替蹬地”，让车向前移动，并在转弯处停下；这段游戏提供了练习动作配合的机会。', quote: '双脚交替蹬地' },
];
const output = { stories, suggestion: '在家可以一起试试看看不同形状的叶子。' };
const profile = { summary: '她尝试比较叶子的形状。', recent_change: '目前只有一次记录，继续观察。', development_clues: ['科学探索：她说“这两盆的叶子不一样”，这次比较涉及对外形差异的观察；下次看看她还会怎样描述叶子。'], next_support: '提供不同形状的叶子。', next_focus: '看看她怎样比较叶子。' };
const observation: Observation = { id: sources[0].id, child_id: randomUUID(), class_id: null, observed_at: '2026-09-07', context: '自然角', raw_text: sources[0].raw_text, status: 'confirmed', confirmed_content: { domain: '科学', sub_domain: '科学探究', objective_description: sources[0].description, highlights: ['比较叶子'], highlight_quote: '这两盆的叶子不一样', support_suggestions: ['继续观察叶子'] }, confirmed_at: '2026-09-07T09:00:00Z', agent_context: null, ai_draft: null, ai_model: null, ai_organized_at: null, observed_class: null, created_at: '2026-09-07T09:00:00Z', updated_at: null, is_demo: true };
const params = { childName: '小禾', childGender: '女', childBirthDate: '2022-03-10', observations: [observation], currentDate: '2026-10-10' };
function double(value: unknown): typeof invokeLlm { return async () => ({ content: JSON.stringify(value), model: 'offline-double', provider: 'stepfun' }); }

async function main() {
  await check('family groups by actual development focus instead of leading dates', () => {
    const text = validateCommunicationModel(output, sources, []).text;
    assert.ok(text.includes('科学探索') && text.includes('身体发展与健康'));
    assert.ok(!text.startsWith('2026年')); assert.ok(text.includes('2026年9月7日') && text.includes('2026年10月10日'));
  });
  await check('selected riding story cannot silently disappear even in legacy output', () => assert.throws(() => validateCommunicationModel({ stories: [{ observation_id: stories[0].observation_id, text: stories[0].text, quote: stories[0].quote }], suggestion: '' }, sources, [])));
  await check('each story still requires its own verified quote', () => assert.throws(() => validateCommunicationModel({ ...output, stories: [{ ...stories[0], quote: stories[1].quote }, stories[1]] }, sources, [])));
  await check('unknown development label fails closed', () => assert.throws(() => validateCommunicationModel({ ...output, stories: [{ ...stories[0], focus: '智商等级' }, stories[1]] }, sources, [])));
  await check('same focus has one heading', () => {
    const text = validateCommunicationModel({ ...output, stories: stories.map(story => ({ ...story, focus: '科学' })) }, sources, []).text;
    assert.equal(text.split('科学探索').length - 1, 1);
  });
  await check('family prompt contains diverse grounded examples', () => assert.ok(/少样本|示例/.test(COMMUNICATION_SYSTEM_PROMPT) && /自然角/.test(COMMUNICATION_SYSTEM_PROMPT) && /骑行/.test(COMMUNICATION_SYSTEM_PROMPT) && /成人/.test(COMMUNICATION_SYSTEM_PROMPT)));
  await check('growth prompt separates facts from interpretations and follow-up', () => assert.ok(/发展解读/.test(GROWTH_PROFILE_SYSTEM_PROMPT) && /继续观察/.test(GROWTH_PROFILE_SYSTEM_PROMPT) && /示例/.test(GROWTH_PROFILE_SYSTEM_PROMPT)));
  await check('valid literal growth evidence remains usable', async () => assert.deepEqual((await generateGrowthProfile(params, double(profile))).profile, profile));
  await check('invented growth quotation never publishes', async () => {
    await assert.rejects(generateGrowthProfile(params, double({ ...profile, development_clues: ['科学探索：她说“我能独立完成所有挑战”，下次继续看看。'] })));
  });
  await check('single observation cannot prove improved muscle strength', async () => {
    await assert.rejects(generateGrowthProfile(params, double({ ...profile, development_clues: ['这次活动证明肌肉力量明显增强，平衡能力显著提升。'] })));
  });
  console.log(JSON.stringify({ passed, total: passed + failures.length, failures, real_model_requests: 0 }));
  if (failures.length) process.exitCode = 1;
}
void main();
