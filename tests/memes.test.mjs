import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadMemes, memePrompt, extractMeme, createMemeStream } from '../lib/memes.mjs';

async function pack(t, { categories = { happy: '开心时用', sad: '难过时用' }, images = { happy: ['a.jpg', 'b.jpg'], sad: ['c.png'] }, manifest } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'jiuzhai-memes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
    name: manifest?.name || '测试表情包',
    categories: manifest?.categories || Object.fromEntries(Object.entries(categories).map(([name, description]) => [name, { description }]))
  }));
  for (const [category, files] of Object.entries(images)) {
    await mkdir(path.join(directory, category), { recursive: true });
    for (const file of files) await writeFile(path.join(directory, category, file), 'x');
  }
  return directory;
}

test('manifest is loaded only for categories that actually contain images', async t => {
  const directory = await pack(t, {
    categories: { happy: '开心时用', sad: '难过时用', empty: '没有图' },
    images: { happy: ['a.jpg'], sad: ['c.png'] }
  });
  const memes = loadMemes(directory);
  assert.equal(memes.name, '测试表情包');
  assert.deepEqual(memes.categories.map(category => category.name), ['happy', 'sad']);
  assert.deepEqual(memes.categories[0].files, ['a.jpg']);
});

test('a directory without manifest degrades to no memes instead of failing', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'jiuzhai-memes-empty-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(loadMemes(directory), null);
  assert.equal(loadMemes(path.join(directory, 'missing')), null);
  assert.equal(memePrompt(null), '');
  assert.deepEqual(extractMeme('你好<meme:happy>', null), { text: '你好<meme:happy>', meme: null });
});

test('prompt lists categories with their usage hints and tells the model to keep it rare', async t => {
  const memes = loadMemes(await pack(t));
  const prompt = memePrompt(memes);
  assert.match(prompt, /- happy：开心时用/);
  assert.match(prompt, /每五六条用一次/);
  assert.match(prompt, /最末尾/);
});

test('non-streaming extraction strips the tag and picks a deterministic image', async t => {
  const memes = loadMemes(await pack(t));
  const result = extractMeme('草 绷不住了<meme:happy>', memes, { rng: () => 0.9 });
  assert.equal(result.text, '草 绷不住了');
  assert.equal(result.meme.category, 'happy');
  assert.equal(result.meme.file, 'b.jpg');
  assert.equal(result.meme.url, '/memes/happy/b.jpg');
});

test('unknown categories are stripped but produce no image', async t => {
  const memes = loadMemes(await pack(t));
  const result = extractMeme('好吧<meme:不存在>', memes);
  assert.equal(result.text, '好吧');
  assert.equal(result.meme, null);
});

test('streaming holds an incomplete tag across chunks and keeps it out of the text', async t => {
  const memes = loadMemes(await pack(t));
  const stream = createMemeStream(memes, { rng: () => 0 });
  assert.equal(stream.feed('草 绷不'), '草 绷不');
  assert.equal(stream.feed('住了<meme:ha'), '住了');
  assert.equal(stream.meme, null);
  assert.equal(stream.feed('ppy>'), '');
  assert.equal(stream.meme.category, 'happy');
  assert.equal(stream.meme.file, 'a.jpg');
});

test('streaming keeps ordinary angle brackets and only removes the first meme', async t => {
  const memes = loadMemes(await pack(t));
  const stream = createMemeStream(memes, { rng: () => 0 });
  assert.equal(stream.feed('3<5 并且 >2'), '3<5 并且 >2');
  assert.equal(stream.feed('<meme:sad><meme:happy>'), '');
  assert.equal(stream.meme.category, 'sad');
  // 收尾时没有残留。
  assert.equal(stream.flush(), '');
});

test('an unterminated tag is returned as plain text on flush instead of vanishing', async t => {
  const memes = loadMemes(await pack(t));
  const stream = createMemeStream(memes);
  assert.equal(stream.feed('好吧<meme:hap'), '好吧');
  assert.equal(stream.flush(), '<meme:hap');
});
