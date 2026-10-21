# 交接文档

给下一个接手的人（或下一个会话的自己）看。读完这一页就能上手。

## 这是什么

九寨沟行程手册 + 一个「旅行伙伴」聊天助手。行程页是公开的参考工具；聊天页要邀请码注册、每个人填自己的 DeepSeek Key。

**线上**：<https://47.111.21.130/>（`http` 会 301 跳到 `https`）

## 现在到哪一步了

| 部分 | 状态 |
|---|---|
| 行程页（地图、时间线、打印、分享） | 可用 |
| 聊天内核（人设、记忆、分段流式、图片、表情包、主动消息、搜索） | 可用，有 83 项自动测试 |
| `/memory` 记忆页 | 可用 |
| HTTPS + IP 证书 + 自动续期 | 可用 |
| 表情包图片 | **占位图**，需要导入真实包 |
| 地图装饰 | 部分完成（矢量山体、水系、栈道；未再加固定风景画） |
| 检索工具（tool call） | 待做 |

> **2026-10-22 本地改动（待部署）**：行程栏回到上一版常显钟点与贴字暖白衬底，点击条目仍在右下详情卡展开；首页删除抵达／住宿折叠区与地图解释段；天气下一段改为「预计 HH:mm 天气」。非当前时段点位淡化保留。`npm test` 83 项通过，浏览器验证通过。

## 架构（按职责分文件）

```
server.mjs              HTTP 入口：静态资源、/api/guide、/api/weather/now、/api/chat/*
lib/chat.mjs            聊天核心：认证、Key 加密、请求转发、流式、记忆触发、主动消息
lib/persona.mjs         人设字段 + composeSystem 拼装 + buildScene 实时情景
lib/memory.mjs          三层记忆：facts / episodes / trips，含治理规则与抽取
lib/attachments.mjs     图片校验与落盘、splitSegments 分段切句
lib/memes.mjs           表情包 manifest、标记解析、流式跨段剥离
lib/search.mjs          关键词触发 + DeepSeek /v1/tools/search
lib/knowledge.mjs       景点常识库，按当天路线挑景点注入
lib/weather.mjs         Open-Meteo 逐小时天气
public/app.js           行程页逻辑：地图 SVG、时间线、天气行、红点
public/timeline.js      把相邻抵达与游览合并成地点节点的小工具
public/chat.js          聊天页：SSE 解析、分段渲染、图片、停止、轮询
public/splash.js        开屏动画
data/guide.json         行程数据（景点、路线、时间）
data/knowledge.json     景点常识与实用提示
```

## 系统指令的拼装顺序

固定不变，越稳定的越靠前（为了命中 DeepSeek 的 prompt 缓存）：

```
人设 → 长期记忆 → 表情包分类 → 景区常识 → 刚搜到的资料 → 此刻（时间/行程第几天）
```

改顺序会影响缓存命中率，也会影响模型对「哪段是指令、哪段是资料」的判断。

## 部署

服务器 `root@47.111.21.130`，代码在 `/opt/jiuzhai-team-guide`，Docker Compose 跑，nginx 反代。

```bash
# 本地
git push origin main

# 服务器
cd /opt/jiuzhai-team-guide
git fetch origin && git reset --hard origin/main
docker compose up -d --build
```

`.env` 必须包含（`GUIDE_BIND=0.0.0.0` 少了会让站点从外网消失）：

```
GUIDE_PORT=666
GUIDE_BIND=0.0.0.0
CHAT_ENABLED=1
CHAT_ORIGIN=https://47.111.21.130
CHAT_INVITE_CODE=<32 hex>
CHAT_ENCRYPTION_KEY=<64 hex>
```

`CHAT_ENCRYPTION_KEY` 一旦设定不要换，换了会拒绝启动（指纹校验）。

## 本地开发

```bash
npm start          # 需要 Node 24+
npm run check      # 语法检查
npm test           # 83 项测试
```

聊天要配置 `.env`（参考 `.env.example`）。测试不需要真实 Key，全部用 mock。

浏览器验收：

```bash
# 需要 Playwright 与 Chrome
PLAYWRIGHT_MODULE=D:\project\fun\shot\node_modules\playwright node tests/chat.browser.cjs
```

真实 DeepSeek 验收需要 `E2E_ORIGIN`、`E2E_DEEPSEEK_KEY`、`E2E_INVITE` 三个环境变量，跑 `tests/real-chat.cjs`。**不要把 Key 写进文件或提交。**

## 下一步建议（按优先级）

1. **导入真实表情包** —— `node scripts/import-memes.mjs <解压目录> happy,like,surprised,confused,sad,baka,fool,see,sigh,sleep,meow,laugh`，再重建镜像
2. **检索工具** —— 给 `chat/completions` 传 `tools`，处理 `tool_calls`；难点是流式下要等 tool_call 收完再续流
3. **地图装饰** —— 纯代码可做：远山渐变阴影、海子从深蓝到浅青、纸纹噪点
4. **关掉 666 明文端口** —— `.env` 改 `GUIDE_BIND=127.0.0.1`，`docker compose up -d`

## 容易踩的坑

- **开屏会挡住测试**：Playwright 里加 `sessionStorage.setItem('splash-seen','1')` 跳过
- **`networkidle` 等不到**：聊天页有轮询和天气请求，用 `domcontentloaded` + 固定等待
- **流式测试要返回 SSE**：mock 返回 JSON 会让服务端解析出空回复
- **`?` 不是句末标点**：人设要求句首问号，`splitSegments` 特意不把 `?` 当断句点
- **IP 证书 6 天有效**：续期靠 `snap.certbot.renew.timer` + `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx`
- **别把它当 IM 机器人**：没有群聊、没有多平台，就是网页私聊

## 记忆为什么这么做

参考 [AML 记忆榜单](https://agentmemories.ai/leaderboard/industry/textual)：文本榜第一 58 分，事实召回 89 但**记忆治理只有 51**。所以这里不追求「记住更多」，而是把**更新、冲突、过期、遗忘**做成显式状态。

真正的取舍记录在 [docs/memory.md](memory.md)。

## 相关文档

- [需求记录](requirements.md) —— 每一条需求、每个被修正的判断
- [记忆设计](memory.md)
- [表情包](memes.md)
- [部署与 HTTPS](chat-deployment.md)
- [验收记录](chat-verification.md)
