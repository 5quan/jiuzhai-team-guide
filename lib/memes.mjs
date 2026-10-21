import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

// 表情包沿用 AstrBot 那套 manifest 思路：每个分类配一句「什么时候用」，
// 这句话直接进系统指令，模型据此挑分类，服务端再随机取图。
// 参考：https://github.com/shirachino/astrbot-deepseek-meme-pack

const IMAGE = /\.(jpe?g|png|gif|webp)$/i;
// 分类名允许非 ASCII：模型偶尔会写 <meme:开心>，标记仍要剥掉，只是不选图。
const TAG = /<meme:([^>\s]{1,20})>/i;
const TAG_ALL = /<meme:[^>\s]{1,20}>/gi;
const TAG_ONE = /<meme:([^>\s]{1,20})>/gi;
const PARTIAL = /<meme:[^>\s]{0,20}$/i;

export function loadMemes(directory) {
  if (!directory || !existsSync(directory)) return null;
  const manifestFile = path.join(directory, 'manifest.json');
  if (!existsSync(manifestFile)) return null;
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestFile, 'utf8')); } catch { return null; }
  const categories = [];
  for (const [name, entry] of Object.entries(manifest.categories || {})) {
    const description = typeof entry === 'string' ? entry : entry?.description;
    if (!name || !description) continue;
    let files = [];
    try { files = readdirSync(path.join(directory, name)).filter(file => IMAGE.test(file)).sort(); } catch { continue; }
    // 没有图的分类不参与：模型看不到，也就不会选到空目录。
    if (files.length) categories.push({ name, description: String(description).slice(0, 120), files });
  }
  return categories.length ? { name: String(manifest.name || '表情包').slice(0, 40), categories } : null;
}

/** 注入系统指令的分类清单。标记放在最后一段末尾，服务端负责剥离。 */
export function memePrompt(memes) {
  if (!memes?.categories?.length) return '';
  const lines = memes.categories.map(category => `- ${category.name}：${category.description}`);
  return [
    '【表情包】可以在回复的最末尾加一个表情标记，例如 <meme:happy>，我会把它换成一张图发出去。',
    '规则：',
    '- 一条消息最多一个标记，且标记必须是整段回复的最后几个字符，后面不要再写字',
    '- 不是每条都用。大概每五六条用一次，觉得不加也说得通就别加',
    '- 只允许下面这些分类，不要自己发明：',
    ...lines
  ].join('\n');
}

const pickFile = (category, rng) => category.files[Math.min(category.files.length - 1, Math.floor(rng() * category.files.length))];

function choose(memes, name, rng) {
  const wanted = String(name || '').toLowerCase();
  const category = memes.categories.find(item => item.name === wanted);
  if (!category) return null;
  const file = pickFile(category, rng);
  return { category: category.name, file, url: `/memes/${category.name}/${encodeURIComponent(file)}` };
}

/** 非流式：取出第一个标记，返回剥离后的文本和选中的表情。 */
export function extractMeme(text, memes, { rng = Math.random } = {}) {
  if (!memes || typeof text !== 'string') return { text, meme: null };
  const match = TAG.exec(text);
  if (!match) return { text, meme: null };
  const cleaned = text.replace(TAG_ALL, '').trim();
  return { text: cleaned, meme: choose(memes, match[1], rng) };
}

/**
 * 流式：标记可能被切在两段之间，所以末尾的不完整前缀先扣住，等下一段再判断。
 * 完整标记一旦出现就剥掉，并只认第一个。
 */
export function createMemeStream(memes, { rng = Math.random } = {}) {
  let hold = '';
  let meme = null;
  return {
    feed(chunk) {
      let value = hold + String(chunk ?? '');
      hold = '';
      if (memes?.categories?.length) {
        value = value.replace(TAG_ONE, (all, name) => {
          if (!meme) meme = choose(memes, name, rng);
          return '';
        });
        const partial = PARTIAL.exec(value);
        if (partial) {
          hold = partial[0];
          value = value.slice(0, partial.index);
        }
      }
      return value;
    },
    /** 收尾：没闭合的残片按普通文本处理，不丢用户能看到的字。 */
    flush() { const rest = hold; hold = ''; return rest; },
    get meme() { return meme; }
  };
}
