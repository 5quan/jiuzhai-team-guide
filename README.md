# 九寨同行

一个九寨沟行程手册，外加一个「记得你」的旅行伙伴。

<https://47.111.21.130/>

## 可以做什么

**行程页**

- 查看一天精华游或两天慢游的地点顺序、交通方式、预计用时和停留时长。
- 在同一画面里看行程与示意地图，点地点定位，拖动或缩放看周边。
- 顶部显示当前天气和下一小时的预报。
- 分享网页或打印参考行程；右下角可以直接进聊天。

**AI 助手**（`/chat`，需要邀请码和每个人自己的 DeepSeek Key）

- 固定人格「大肥鱼」，说话短、带点毒舌，不是客服腔。
- 第一次进来会先问你怎么称呼。
- 回复一句一句出，可以随时停止；支持发图片。
- 关键信息会被整理成记忆，下次还能接上；记忆可以在「她记得的事」里查看和删除。
- 问到天气、开放时间这类实时信息时会联网查一次。
- 可选：让她偶尔主动找你（默认关闭，在 Key 设置里打开）。

## 怎么用

行程页打开就能用，不需要注册。

聊天需要邀请码注册，然后填入自己的 DeepSeek API Key——Key 加密保存在服务器，费用走你自己的账户。

## 本地运行

需要 Node.js 24 以上，没有第三方运行依赖。

```sh
npm start
```

打开 <http://localhost:3000/>。

```sh
npm run check   # 语法检查
npm test        # 83 项自动测试
```

聊天默认关闭，需要按 [.env.example](.env.example) 配置 `.env` 并设 `CHAT_ENABLED=1`。公网访问必须用 HTTPS，配置见[部署说明](docs/chat-deployment.md)。

## 目录

```
server.mjs          HTTP 入口
lib/                聊天、记忆、人设、表情包、搜索、天气
public/             前端页面与脚本
data/               行程数据与景点常识
docs/               设计、部署与验收文档
scripts/            导入表情包等工具
tests/              83 项自动测试
```

## 文档

- [交接文档](HANDOFF.md) —— 先看这个，能最快上手
- [需求记录](docs/requirements.md) —— 每一条需求和被修正的判断
- [记忆设计](docs/memory.md)
- [表情包](docs/memes.md)
- [部署与 HTTPS](docs/chat-deployment.md)
- [两天行程参考](docs/reference-itinerary.md) · [一天精华游](docs/one-day-plan.md)

## 版本

当前主线在 `main`，最近一次大改是加入 AI 助手。历史版本见 [CHANGELOG.md](CHANGELOG.md)。
