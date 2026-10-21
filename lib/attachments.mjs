import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

// 只接受 DeepSeek Vision 支持的四种格式；按文件内容判断，不信 MIME 和扩展名。
const SIGNATURES = [
  { mime: 'image/jpeg', ext: 'jpg', test: bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  { mime: 'image/png', ext: 'png', test: bytes => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/gif', ext: 'gif', test: bytes => bytes.subarray(0, 6).toString('latin1').match(/^GIF8[79]a$/) !== null },
  { mime: 'image/webp', ext: 'webp', test: bytes => bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP' }
];

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export function detectImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null;
  return SIGNATURES.find(signature => signature.test(bytes)) || null;
}

export function decodeDataUrl(value, maxBytes = MAX_IMAGE_BYTES) {
  if (typeof value !== 'string') throw new Error('图片格式不正确。');
  const match = /^data:([a-z]+)\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/i.exec(value);
  if (!match) throw new Error('图片格式不正确。');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > maxBytes) throw new Error('单张图片不能超过 4MB。');
  const kind = detectImage(bytes);
  if (!kind) throw new Error('只支持 JPEG、PNG、GIF 或 WebP 图片。');
  return { bytes, ...kind };
}

/**
 * 图片正文存磁盘、元数据进数据库：避免 SQLite 被 base64 撑大，也让备份策略可以分开。
 * 文件名带随机后缀，即使内容相同也不会互相覆盖或泄露哈希。
 */
export function createAttachmentStore(directory) {
  const root = path.resolve(directory);
  return {
    directory: root,
    async save(bytes, ext) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}-${randomBytes(8).toString('hex')}.${ext}`;
      await writeFile(path.join(root, name), bytes, { mode: 0o600, flag: 'wx' });
      return name;
    },
    async read(name) {
      // 文件名由服务端生成；这里再挡一次路径穿越，防御数据库被改写的极端情况。
      if (!/^[a-f0-9]{32}-[a-f0-9]{16}\.(jpg|png|gif|webp)$/.test(name)) return null;
      try { return await readFile(path.join(root, name)); }
      catch { return null; }
    },
    async remove(name) {
      if (!/^[a-f0-9]{32}-[a-f0-9]{16}\.(jpg|png|gif|webp)$/.test(name)) return;
      await rm(path.join(root, name), { force: true });
    }
  };
}

/**
 * 把一段文本切成多条消息，模拟"一条一条发"的节奏。
 * 句末标点必断；长句在逗号处断；仍然超长则硬切，避免一个气泡塞满整屏。
 */
export function splitSegments(text, { maxLength = 90 } = {}) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n');
  const segments = [];
  let buffer = '';
  const flush = () => { const value = buffer.trim(); if (value) segments.push(value); buffer = ''; };
  for (const char of source) {
    buffer += char;
    if ('。！？!?～…\n'.includes(char)) flush();
    else if (buffer.length >= maxLength && '，,、；;：:'.includes(char)) flush();
  }
  flush();
  const limited = [];
  for (const segment of segments) {
    if (segment.length <= maxLength) { limited.push(segment); continue; }
    let rest = segment;
    while (rest.length > maxLength) {
      const cut = rest.lastIndexOf('，', maxLength);
      const index = cut > maxLength / 3 ? cut + 1 : maxLength;
      limited.push(rest.slice(0, index).trim());
      rest = rest.slice(index).trim();
    }
    if (rest) limited.push(rest);
  }
  return limited.length ? limited.filter(Boolean) : [''];
}

