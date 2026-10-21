# 表情包

回复末尾可以带一张表情图。不是随机贴图：模型自己判断「这句话配不配图」，再选分类。

## 机制

沿用 [shirachino/astrbot-deepseek-meme-pack](https://github.com/shirachino/astrbot-deepseek-meme-pack) 的 manifest 思路——每个分类配一句「什么时候用」，这句话直接进系统指令，模型据此挑分类。

```
用户：给你看个乐子
AI：草 绷不住了<meme:laugh>
        ↓ 服务端剥离标记、随机取图
AI：草 绷不住了
    [一张 laugh 分类的表情图]
```

拼装顺序里，表情包提示放在「长期记忆」之后、「此刻」之前——它比实时情景稳定，比人设易变。

## 标签协议

- 模型只在**整段回复的最末尾**输出一个 `<meme:分类名>`。
- 分类名必须在 manifest 里，否则标记被剥掉但不发图（不报错）。
- 流式时标记可能被切在两段之间（`<meme:ha` + `ppy>`），`lib/memes.mjs` 的 `createMemeStream` 会扣住不完整前缀，等下一段拼上再判断。
- 收尾仍不闭合的残片按普通文本返回，不吞字。
- 标记永远不进历史上下文：存库前已剥离，否则模型会学着自己复读。

## 当前资源是占位图

`public/memes/` 下现在有 12 个分类、每个一张 `placeholder.png`，是脚本生成的纯色占位图，只用来把链路跑通。

**换成真实表情包**：

```sh
# 先下载并解压 https://github.com/shirachino/astrbot-deepseek-meme-pack
node scripts/import-memes.mjs <解压后的目录> happy,like,surprised,confused,sad,baka,fool,see,sigh,sleep,meow,laugh
```

不给第二个参数就导入源 manifest 里的全部分类。脚本会跳过超过 2MB 的单张图，并重写 `public/memes/manifest.json`。

## 为什么只留这几个分类

原包有 20 多个分类，其中 `_genshin`（原神）、`_kg`（鸣潮）、`_stock`（股票）这些跟景区场景无关，而且带明显的圈层梗。留给旅行伙伴用的应该是情绪类的十来个。

## 体积

原包里很多 GIF 是 2–5MB。网页端加载一张 5MB 的图，在景区弱网下体验很差。导入脚本的 2MB 上限就是为此。如果一定要用，建议先压成 WebP。

## 关掉表情包

删掉 `public/memes/manifest.json` 即可：`loadMemes` 返回 `null`，系统指令里不再出现表情包段落，模型也不会再输出标记。

## 静态路由

`/memes/<分类>/<文件名>.<扩展名>`，只允许这一层路径，正则会拒绝嵌套目录、非图片扩展名和 `..`；解析后还会再校验真实路径仍在 `public/memes` 下。图片是公共资源，不鉴权，带 `max-age=86400`。
