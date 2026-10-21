import { readFileSync, existsSync } from 'node:fs';

// 景区常识与景点看点。只放相对稳定的内容；开放时间、票价这些会变的不写死，
// 交给联网搜索或让模型说不知道。

const MAX_SPOTS = 6;
const MAX_TIPS = 3;
const MAX_BLOCK = 900;

export function loadKnowledge(file) {
  if (!file || !existsSync(file)) return null;
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  const spots = parsed?.spots && typeof parsed.spots === 'object' ? parsed.spots : {};
  const tips = Array.isArray(parsed?.tips) ? parsed.tips.filter(tip => typeof tip === 'string' && tip.trim()) : [];
  if (!Object.keys(spots).length && !tips.length) return null;
  return { spots, tips };
}

/** 按当天行程挑景点说明，避免把整本资料塞进每一轮。 */
export function knowledgeBlock(knowledge, guide, { now = new Date(), timeZone = 'Asia/Shanghai' } = {}) {
  if (!knowledge) return '';
  const lines = [];
  const today = guide?.days?.find(day => day.date === now.toLocaleDateString('en-CA', { timeZone }));
  const day = today || guide?.referenceDays?.[0] || guide?.days?.[0];
  const ids = (day?.spotIds || []).filter(id => knowledge.spots[id]);
  const used = new Set();
  for (const id of ids) {
    if (lines.length >= MAX_SPOTS) break;
    if (used.has(id)) continue;
    used.add(id);
    lines.push(`- ${knowledge.spots[id]}`);
  }
  // 没匹配到具体景点时退一条通用说明，避免整段知识缺席。
  const tips = knowledge.tips.slice(0, MAX_TIPS);
  if (!lines.length) {
    const first = Object.values(knowledge.spots)[0];
    if (first) lines.push(`- ${first}`);
  }
  if (tips.length) lines.push(...tips.map(tip => `- ${tip}`));
  if (!lines.length) return '';
  const block = `【你熟悉的景区常识】\n${lines.join('\n')}`;
  return block.length > MAX_BLOCK ? `${block.slice(0, MAX_BLOCK)}…` : block;
}
