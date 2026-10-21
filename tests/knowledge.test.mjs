import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKnowledge, knowledgeBlock } from '../lib/knowledge.mjs';

const knowledge = {
  spots: {
    wuhuahai: '九寨精华，水色分层。',
    changhai: '最大最高的海子。',
    mirror: '没风时像镜子。'
  },
  tips: ['海拔高，慢慢走。', '早晚冷，带外套。', '紫外线强。', '路远，鞋要舒服。']
};

const guide = (dates) => ({
  days: dates.map(day => ({ date: day.date, spotIds: day.spots })),
  // 一天精华游的路线，用于不在行程日期时的兜底。
  referenceDays: [{ spotIds: ['wuhuahai'] }]
});

test('the real knowledge file loads and contains the main spots', () => {
  const loaded = loadKnowledge(new URL('../data/knowledge.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  assert.ok(loaded, 'knowledge.json should load');
  assert.ok(Object.keys(loaded.spots).length >= 20);
  assert.ok(loaded.tips.length >= 5);
});

test('missing or broken files degrade to null instead of throwing', () => {
  assert.equal(loadKnowledge('does-not-exist.json'), null);
  assert.equal(loadKnowledge(null), null);
});

test('only the spots on the current day are injected, capped at six', () => {
  const block = knowledgeBlock(knowledge, guide([
    { date: '2026-10-30', spots: ['wuhuahai', 'changhai'] }
  ]), { now: new Date('2026-10-30T04:00:00Z') });
  assert.match(block, /水色分层/);
  assert.match(block, /最大最高/);
  assert.doesNotMatch(block, /像镜子/);
  assert.match(block, /紫外线强/);
});

test('outside the trip dates it falls back to one spot plus tips', () => {
  const block = knowledgeBlock(knowledge, guide([{ date: '2026-10-30', spots: ['wuhuahai'] }]), { now: new Date('2026-12-01T04:00:00Z') });
  assert.match(block, /景区常识/);
  assert.match(block, /九寨精华/);
});

test('an empty knowledge object produces no block', () => {
  assert.equal(knowledgeBlock(null, guide([])), '');
  assert.equal(knowledgeBlock({ spots: {}, tips: [] }, guide([])), '');
});

test('the block stays bounded even with a long spot list', () => {
  const big = { spots: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`s${i}`, '很长的说明'.repeat(40)])), tips: ['提示'] };
  const block = knowledgeBlock(big, guide([{ date: '2026-10-30', spots: Array.from({ length: 30 }, (_, i) => `s${i}`) }]), { now: new Date('2026-10-30T04:00:00Z') });
  assert.ok(block.length <= 901, `block too long: ${block.length}`);
});
