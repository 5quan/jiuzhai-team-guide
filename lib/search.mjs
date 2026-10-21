// 联网搜索：只在问题确实需要实时信息时触发，用用户自己的 DeepSeek Key。
// 采用 DeepSeek 官方 /v1/tools/search，而不是再引入一个第三方搜索账号。

const TRIGGERS = /天气|气温|下雨|降雪|几点|开放|开门|关门|闭园|门票|票价|人多|排队|路况|封路|限流|官网|电话|营业|停运|临时/;
const MAX_QUERY = 128;
const MAX_RESULTS = 3;
const MAX_BLOCK = 1200;

export function needsSearch(text) {
  const value = String(text ?? '');
  if (value.length < 4) return false;
  return TRIGGERS.test(value);
}

export async function webSearch({ fetchImpl, key, query, count = 5, signal }) {
  const trimmed = String(query ?? '').trim().slice(0, MAX_QUERY);
  if (!trimmed) return [];
  const response = await fetchImpl('https://api.deepseek.com/v1/tools/search', {
    method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: trimmed, count, ori_question: trimmed, need_content: false }),
    signal: signal || AbortSignal.timeout(12000)
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`search ${response.status}`); }
  let payload;
  try { payload = await response.json(); } catch { throw new Error('search invalid'); }
  const results = Array.isArray(payload?.results) ? payload.results : [];
  return results.filter(result => result && typeof result.title === 'string' && typeof result.summary === 'string');
}

const shortDate = value => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
};

/** 只取前三条的摘要，控制注入体积；权威度高的排前面。 */
export function searchBlock(results, { maxResults = MAX_RESULTS } = {}) {
  const usable = results
    .filter(result => result.summary || result.snippet)
    .sort((a, b) => (b.authority ?? 0) - (a.authority ?? 0))
    .slice(0, maxResults);
  if (!usable.length) return '';
  const lines = usable.map((result, index) => {
    const when = shortDate(result.date);
    const source = [result.site_name, when].filter(Boolean).join(' · ');
    return `${index + 1}. ${result.title}${source ? `（${source}）` : ''}\n${(result.summary || result.snippet).slice(0, 220)}`;
  });
  const block = lines.join('\n');
  return block.length > MAX_BLOCK ? `${block.slice(0, MAX_BLOCK)}…` : block;
}
