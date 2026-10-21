#!/usr/bin/env node
// 把 AstrBot 表情包（如 shirachino/astrbot-deepseek-meme-pack）导入本站。
// 用法：node scripts/import-memes.mjs <解压后的目录> [happy,sad,...]
// 不给分类列表时导入源 manifest 里的全部分类。

import { readFileSync, readdirSync, mkdirSync, copyFileSync, existsSync, statSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'public', 'memes');
const MAX_BYTES = 2 * 1024 * 1024;
const IMAGE = /\.(jpe?g|png|gif|webp)$/i;

const source = process.argv[2];
if (!source) {
  console.error('用法: node scripts/import-memes.mjs <解压后的目录> [happy,sad,...]');
  process.exit(1);
}
const only = process.argv[3] ? new Set(process.argv[3].split(',').map(name => name.trim()).filter(Boolean)) : null;

const manifestFile = path.join(source, 'manifest.json');
if (!existsSync(manifestFile)) {
  console.error(`没有找到 ${manifestFile}，请指向解压后的仓库根目录。`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
const imagesRoot = existsSync(path.join(source, 'memes')) ? path.join(source, 'memes') : source;

const categories = {};
let copied = 0;
let skipped = 0;
for (const [name, entry] of Object.entries(manifest.categories || {})) {
  if (only && !only.has(name)) continue;
  const description = typeof entry === 'string' ? entry : entry?.description;
  const directory = path.join(imagesRoot, name);
  if (!description || !existsSync(directory)) continue;
  const files = readdirSync(directory).filter(file => IMAGE.test(file) && statSync(path.join(directory, file)).size <= MAX_BYTES).sort();
  if (!files.length) continue;
  const destination = path.join(target, name);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const file of files) copyFileSync(path.join(directory, file), path.join(destination, file));
  copied += files.length;
  skipped += readdirSync(directory).filter(file => IMAGE.test(file)).length - files.length;
  categories[name] = { description: String(description).slice(0, 120) };
  console.log(`  ${name}: ${files.length} 张`);
}

if (!Object.keys(categories).length) {
  console.error('没有导入任何图片。检查分类名或目录结构。');
  process.exit(1);
}

mkdirSync(target, { recursive: true });
writeFileSync(path.join(target, 'manifest.json'), JSON.stringify({
  name: manifest.name || '表情包',
  id: manifest.id || 'imported',
  note: `从 ${manifest.source?.repo || source} 导入`,
  source: manifest.source?.repo ? `https://github.com/${manifest.source.repo}` : String(source),
  license: manifest.license || '未知',
  categories
}, null, 2), 'utf8');

console.log(`完成：${Object.keys(categories).length} 个分类，${copied} 张图片` + (skipped ? `，跳过 ${skipped} 张超过 2MB 的图片` : ''));
console.log(`写入 ${path.join(target, 'manifest.json')}`);
