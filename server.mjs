import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadGuide, publicGuide, weatherLinks } from './lib/guide.mjs';
import { createLimiter, createCache } from './lib/security.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const defaultGuide = path.join(root, 'data', 'guide.json');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.json': 'application/json; charset=utf-8' };
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://www.jiuzhai.com; frame-src https://embed.windy.com; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'";

function representation(body, type = 'application/json; charset=utf-8') {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return { bytes, type, etag: `"${createHash('sha256').update(bytes).digest('base64url')}"` };
}

export function createServer({ guideFile = process.env.GUIDE_FILE || defaultGuide, cacheTtlMs = 1000, rateLimit = {} } = {}) {
  const limit = createLimiter(rateLimit);
  const cache = createCache({ ttlMs: cacheTtlMs });
  const health = representation({ status: 'ok', service: 'jiuzhai-team-guide' });
  const snapshot = () => cache('guide', async () => {
    const guide = await loadGuide(guideFile);
    return {
      guide: representation(publicGuide(guide)),
      spots: representation(guide.spots),
      weather: Object.fromEntries(['clouds', 'rain', 'temp', 'wind'].map(layer => [layer, representation(weatherLinks(guide.weather, layer))]))
    };
  });
  const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 10000, keepAliveTimeout: 5000, connectionsCheckingInterval: 1000 }, async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    const send = (status, body, type = 'application/json; charset=utf-8', cache = 'no-cache') => {
      const { bytes, etag, type: contentType } = body?.bytes ? body : representation(body, type);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', status === 200 ? cache : 'no-store');
      if (status === 200) {
        res.setHeader('ETag', etag);
        if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
      }
      res.setHeader('Content-Length', bytes.length);
      res.writeHead(status);
      res.end(req.method === 'HEAD' ? undefined : bytes);
    };
    const retryAfter = limit(req.socket.remoteAddress || 'unknown');
    if (retryAfter) {
      res.setHeader('Retry-After', retryAfter);
      res.setHeader('Connection', 'close');
      send(429, { error: '请求过于频繁，请稍后重试。' });
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD');
      res.setHeader('Connection', 'close');
      send(405, { error: 'This guide is read-only.' });
      return;
    }
    if (req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) {
      res.setHeader('Connection', 'close');
      send(400, { error: 'Request bodies are not supported.' });
      return;
    }
    if (req.url.length > 2048) { send(414, { error: 'URL too long' }); return; }
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { send(400, { error: 'Invalid URL' }); return; }
    try {
      if (url.pathname === '/api/health') { send(200, health); return; }
      if (url.pathname.startsWith('/api/')) {
        if (!['/api/guide', '/api/spots', '/api/weather'].includes(url.pathname)) { send(404, { error: 'Not found' }); return; }
        const layer = url.searchParams.get('layer') || 'clouds';
        if (url.pathname === '/api/weather' && !['clouds', 'rain', 'temp', 'wind'].includes(layer)) { send(400, { error: 'Unsupported weather layer' }); return; }
        const data = await snapshot();
        if (url.pathname === '/api/guide') send(200, data.guide);
        else if (url.pathname === '/api/spots') send(200, data.spots);
        else {
          send(200, data.weather[layer]);
        }
        return;
      }
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); }
      catch { send(400, { error: 'Invalid path' }); return; }
      if (pathname.includes('\\') || pathname.includes('\0') || pathname.includes('%') || pathname.split('/').includes('..')) { send(400, { error: 'Invalid path' }); return; }
      // The deployed frontend has a fixed asset set; unknown paths do no disk I/O.
      const asset = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (!['index.html', 'app.js', 'timeline.js', 'style.css', 'favicon.svg', 'sw.js', 'paper-landscape-v1.webp'].includes(asset)) { send(404, { error: 'Not found' }); return; }
      const content = await cache(`asset:${asset}`, async () => {
        const publicRoot = await realpath(path.join(root, 'public'));
        const canonical = await realpath(path.join(publicRoot, asset));
        if (!canonical.startsWith(publicRoot + path.sep)) {
          const error = new Error('Asset outside public directory');
          error.code = 'ENOENT';
          throw error;
        }
        return representation(await readFile(canonical), mime[path.extname(canonical)]);
      });
      send(200, content);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) send(404, { error: 'Not found' });
      else {
        console.error('Guide request failed:', error.message);
        send(500, { error: '攻略暂时无法加载，请稍后重试。' });
      }
    }
  });
  server.maxConnections = 64;
  server.maxHeadersCount = 40;
  server.maxRequestsPerSocket = 100;
  server.setTimeout(10000, socket => socket.destroy());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await loadGuide(process.env.GUIDE_FILE || defaultGuide);
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  const server = createServer();
  server.listen(port, host, () => console.log(`九寨同行已启动 http://localhost:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
