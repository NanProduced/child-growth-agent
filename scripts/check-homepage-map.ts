import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildHomepageMapData } from '../src/lib/homepage-map-data';
import type { SchoolClass } from '../src/lib/types';

const classes: SchoolClass[] = [
  { id: 's1', name: '彩虹一班', stage: 'small', school_year: '2026-2027', is_active: true, is_demo: false, created_at: '', updated_at: null },
  { id: 's2', name: '彩虹二班', stage: 'small', school_year: '2026-2027', is_active: true, is_demo: false, created_at: '', updated_at: null },
  { id: 's3', name: '彩虹三班', stage: 'small', school_year: '2026-2027', is_active: true, is_demo: false, created_at: '', updated_at: null },
  { id: 'm1', name: '向日葵班', stage: 'middle', school_year: '2026-2027', is_active: true, is_demo: false, created_at: '', updated_at: null },
  { id: 'l1', name: '蒲公英班', stage: 'large', school_year: '2026-2027', is_active: true, is_demo: false, created_at: '', updated_at: null },
  { id: 'off', name: '停用班级', stage: 'small', school_year: '2025-2026', is_active: false, is_demo: false, created_at: '', updated_at: null },
];
const children = [{ id: 'c1', name: '幼儿甲', class_id: 'm1' }, { id: 'c2', name: '幼儿乙', class_id: 's1' }];
const observations: Parameters<typeof buildHomepageMapData>[2] = [
  { id: 'o1', child_id: 'c1', class_id: 's1', observed_class: classes[0], observed_at: '2026-09-28', created_at: '2026-09-29', context: '建构区', raw_text: '幼儿拿起两块积木，尝试把桥面搭得更稳。', status: 'ai_organized' },
  { id: 'o2', child_id: 'c2', class_id: 's2', observed_class: classes[1], observed_at: '2026-09-27', created_at: '2026-09-30', context: null, raw_text: '幼儿在户外散步时，停下来仔细看叶片的纹路。', status: 'needs_input' },
];
const before = JSON.stringify({ classes, children, observations });
const data = buildHomepageMapData(classes, children, observations);
assert.equal(data.classes.filter((klass) => klass.stage === 'small').length, 3);
assert.equal(data.classes.length, 5);
assert.equal(data.primaryAction.label, '去处理待确认');
assert.equal(data.classes.find((klass) => klass.id === 's1')?.confirmationCount, 1);
assert.equal(data.classes.find((klass) => klass.id === 's1')?.children.length, 1);
assert.equal(data.classes.find((klass) => klass.id === 'm1')?.confirmationCount, 0);
assert.equal(data.recent[0].id, 'o1');
assert.equal(data.recent[0].className, '小班 · 彩虹一班');
assert.equal(data.recent[0].stage, 'small');
assert.equal(data.pending[0].id, 'o1');
assert.equal(buildHomepageMapData(classes, children, observations.slice(1)).primaryAction.label, '补充一条观察');
assert.equal(buildHomepageMapData(classes, children, []).primaryAction.label, '开始记录');
assert.equal(buildHomepageMapData(classes, [], []).primaryAction.label, '建立第一个成长档案');
assert.equal(buildHomepageMapData([classes[5]], [], []).primaryAction.label, '建立第一个班级');
assert.equal(buildHomepageMapData([], [], []).recent.length, 0);
assert.equal(before, JSON.stringify({ classes, children, observations }), '输入与原始观察不得改写');
console.log('Homepage map: hierarchy, snapshots, action priority, empty states and immutable input passed.');

if (process.argv.includes('--browser-fixtures')) {
  mkdirSync('.next/homepage-map-qa', { recursive: true });
  writeFileSync('.next/homepage-map-qa/fixtures.json', JSON.stringify({
    multi: data,
    empty: buildHomepageMapData([], [], []),
    noChildren: buildHomepageMapData(classes, [], []),
    noObservations: buildHomepageMapData(classes, children, []),
    needsInput: buildHomepageMapData(classes, children, observations.slice(1)),
    missingClass: { ...data, classes: data.classes.filter((klass) => klass.id !== 's1') },
  }));
}
