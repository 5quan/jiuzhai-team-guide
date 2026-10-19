import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createLimiter, createCache } from '../lib/security.mjs';
import { createServer } from '../server.mjs';

async function running(options, work) {
  const server = createServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await work(`http://127.0.0.1:${server.address().port}`, server); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('per-peer, global and bounded-client limits expire and recover', () => {
  let time = 0;
  const limit = createLimiter({ perIp: 2, total: 3, windowMs: 2000, maxClients: 2, now: () => time });
  assert.equal(limit('a'), 0);
  assert.equal(limit('a'), 0);
  assert.equal(limit('a'), 2);
  assert.equal(limit('b'), 0);
  assert.equal(limit('c'), 2);
  time = 2001;
  assert.equal(limit('c'), 0);
  const bounded = createLimiter({ maxClients: 1 });
  assert.equal(bounded('a'), 0);
  assert.ok(bounded('b') > 0);
});

test('429 applies to assets and unknown paths; forged proxy headers cannot bypass it', async () => {
  await running({ rateLimit: { perIp: 2 } }, async origin => {
    assert.equal((await fetch(`${origin}/`, { headers: { 'X-Forwarded-For': '1.1.1.1' } })).status, 200);
    assert.equal((await fetch(`${origin}/not-found`)).status, 404);
    const denied = await fetch(`${origin}/api/guide`, { headers: { 'X-Forwarded-For': '2.2.2.2', 'X-Real-IP': '2.2.2.2' } });
    assert.equal(denied.status, 429);
    assert.ok(Number(denied.headers.get('retry-after')) > 0);
    assert.equal(denied.headers.get('cache-control'), 'no-store');
    assert.equal(denied.headers.get('connection'), 'close');
  });
});

test('cache coalesces parallel reads, expires, bounds keys and backs off failures', async () => {
  let time = 0;
  let reads = 0;
  const cached = createCache({ ttlMs: 100, maxEntries: 2, now: () => time });
  const load = async () => { reads++; return 'value'; };
  assert.deepEqual(await Promise.all(Array.from({ length: 40 }, () => cached('guide', load))), Array(40).fill('value'));
  assert.equal(reads, 1);
  time = 101;
  await cached('guide', load);
  assert.equal(reads, 2);
  await cached('asset1', load);
  await cached('asset2', load);
  await cached('guide', load);
  assert.equal(reads, 5);
  let failures = 0;
  const fail = () => { failures++; throw new Error('unavailable'); };
  await assert.rejects(cached('bad', fail));
  await assert.rejects(cached('bad', fail));
  assert.equal(failures, 1);
});

test('parallel local reads retain valid data and random query strings do not alter representation', async () => {
  await running({}, async origin => {
    const replies = await Promise.all(Array.from({ length: 40 }, (_, index) => fetch(`${origin}/api/guide?noise=${index}`)));
    const etags = new Set(replies.map(reply => reply.headers.get('etag')));
    assert.equal(etags.size, 1);
    for (const reply of replies) {
      assert.equal(reply.status, 200);
      assert.equal((await reply.json()).trip.people, 7);
    }
  });
});

test('oversized URL, headers and unsupported request bodies are rejected', async () => {
  await running({}, async origin => {
    assert.equal((await fetch(`${origin}/${'x'.repeat(2048)}`)).status, 414);
    assert.equal((await fetch(origin, { headers: { 'X-Large': 'x'.repeat(9000) } })).status, 431);
    const status = await new Promise((resolve, reject) => {
      const request = http.request(origin, { method: 'GET', headers: { 'Content-Length': '2' } }, response => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on('error', reject);
      request.end('{}');
    });
    assert.equal(status, 400);
  });
});
