import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsSearch, webSearch, searchBlock } from '../lib/search.mjs';

test('only real time questions trigger a search', () => {
  assert.equal(needsSearch('九寨沟今天天气怎么样'), true);
  assert.equal(needsSearch('景区几点关门'), true);
  assert.equal(needsSearch('门票多少钱'), true);
  assert.equal(needsSearch('现在人多吗，要排队吗'), true);
  assert.equal(needsSearch('我有点累'), false);
  assert.equal(needsSearch('你说我拍得好看吗'), false);
  assert.equal(needsSearch('嗯'), false);
  assert.equal(needsSearch(undefined), false);
});

test('search request is scoped to the query and drops malformed results', async () => {
  let captured;
  const results = await webSearch({
    key: 'sk-test',
    query: '  九寨沟 天气  ',
    fetchImpl: async (url, options) => {
      captured = { url, body: JSON.parse(options.body), auth: options.headers.Authorization };
      return Response.json({ results: [
        { title: '天气', summary: '晴，8 度', snippet: '晴', site_name: '气象台', authority: 3, date: '2026-10-21T00:00:00Z' },
        { title: '缺摘要' },
        null
      ] });
    }
  });
  assert.equal(captured.url, 'https://api.deepseek.com/v1/tools/search');
  assert.equal(captured.auth, 'Bearer sk-test');
  assert.equal(captured.body.query, '九寨沟 天气');
  assert.equal(captured.body.need_content, false);
  assert.equal(results.length, 1);
});

test('search failures throw so the caller can fall back silently', async () => {
  await assert.rejects(() => webSearch({ key: 'k', query: '天气', fetchImpl: async () => new Response('no', { status: 500 }) }), /search 500/);
  await assert.rejects(() => webSearch({ key: 'k', query: '天气', fetchImpl: async () => new Response('not json') }), /search invalid/);
});

test('search block keeps the most authoritative three results and stays bounded', () => {
  const results = Array.from({ length: 6 }, (_, index) => ({
    title: `结果${index}`, summary: `摘要${index}`, authority: index, site_name: '某站', date: '2026-10-21T00:00:00Z'
  }));
  const block = searchBlock(results);
  const lines = block.split('\n');
  assert.ok(lines.length <= 6);
  assert.match(lines[0], /结果5/);
  assert.match(block, /某站 · 10\/21/);
  assert.doesNotMatch(block, /结果0/);
});

test('empty search results produce no block at all', () => {
  assert.equal(searchBlock([]), '');
  assert.equal(searchBlock([{ title: 'x' }]), '');
});
