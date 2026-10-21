# 单会话 AI 助手部署

## 已实现行为

- `/chat` 提供邀请码注册、用户名密码登录、Key 设置及唯一会话。原行程仍可匿名访问。
- 用户名不区分大小写；密码 10–128 位，用带独立盐的 scrypt 哈希保存；团队邀请码至少 16 位，可通过环境变量轮换。第一版不提供邮件验证或自助找回密码。
- Key 用 AES-256-GCM 加密，绑定用户 ID；会话 Cookie 为 HttpOnly / SameSite=Strict，生产 HTTPS 下为 Secure。Key 不返回前端、不写入日志。
- DeepSeek `/models` 验证 Key 格式及认证有效性；额度是否足够以实际聊天调用结果为准。
- 每次调用 `/chat/completions` 显式 `stream: false`，使用 `deepseek-flash`、关闭思考模式，回复上限 4096 tokens。模型可通过配置变更，无模型选择界面。
- 发送给模型的上下文由「固定人设 + 长期记忆（事实与情景）+ 最近完成的原文」组成，**原文记录一条都不删除**；记忆是派生物，可随时重建，详见[记忆设计](memory.md)。
- 每累计 5 轮已完成对话，异步调用一次模型抽取事实和情景，使用用户自己的 Key，不阻塞回复，失败静默并在下一批重试。
- 问到天气、开放时间、票价这类实时信息时，先用用户自己的 Key 调一次 DeepSeek `/v1/tools/search`，把结果注入系统指令；搜索失败就当没搜过，正常回复。默认开启，`CHAT_SEARCH=0` 关闭。
- 主动消息默认关闭（`CHAT_PROACTIVE=1` 全局开启，用户还要在 Key 设置里单独打开）。开启后按行程情景生成一句话，每天最多 2 条，23:00–08:00 不发。
- 上下文超限时保留记录并提示错误，不自动删除历史。长会话的请求体、内存与费用会随历史增长；第一版没有清空会话功能。
- 同账号同时仅允许一个生成请求；全局最多四个外部请求，每用户有频率限制；90 秒超时。失败可重试最后一条消息，同一请求编号不会重复入库。网络超时后重试可能再次产生模型费用，无法保证外部 API 恰好调用一次。
- 页面每次加载 50 轮、可向前翻页。显示纯文本，模型文字不会作为 HTML 执行。敏感接口和聊天记录不进入 Service Worker 缓存。

## 本地运行

使用 Node.js 24 及以上，SQLite 为 Node 自带模块，无第三方运行依赖。

1. 将 `.env.example` 复制为 `.env`，设置 `CHAT_ENABLED=1`。
2. 独立生成两次随机值，分别填入 `CHAT_ENCRYPTION_KEY` 和 `CHAT_INVITE_CODE`：

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

3. 本地设 `CHAT_ORIGIN=http://localhost:3000`，运行 `npm start`，访问 `http://localhost:3000/chat`。访问地址必须与配置的 origin 一致（localhost 与 127.0.0.1 不同）。
4. 用邀请码注册，填入你自己的 DeepSeek API Key。不要把生产 Key 写入测试、源码或聊天消息。

默认不启用聊天，缺少配置时 `/chat` 提示管理员尚未配置。公网 HTTP origin 被拒绝，仅本机允许 HTTP。

## 公网 IP + 免费 HTTPS

前提：能登录服务器、控制公网 IP、防火墙和安全组允许 TCP 80/443，主机已有 Nginx 与 Certbot 5.4+。本仓库仅提供配置，不假设已有服务器服务可被覆盖。

1. 先检查 80/443 端口和现有 Nginx 配置，备份当前源码、`.env`、容器镜像。不要覆盖其他站点。
2. 将 `deploy/nginx-ip-http.conf` 中 `PUBLIC_IP` 换成实际公网 IP（现有文档为 `47.111.21.130`），安装为独立站点，创建 `/var/www/letsencrypt`，`nginx -t` 成功后加载。
3. 使用官方支持的 webroot 模式申请证书。先用 `--staging --cert-name ip-staging` 验证挑战链路；正式申请删除这两个参数，避免使用测试证书。Certbot 的邮箱与条款由管理员按实际情况填写：

   ```sh
   sudo certbot certonly --preferred-profile shortlived --webroot \
     --webroot-path /var/www/letsencrypt --ip-address YOUR_PUBLIC_IP
   ```

4. `.env` 中设置 `CHAT_ORIGIN=https://YOUR_PUBLIC_IP`、`CHAT_ENABLED=1` 及独立随机的加密密钥和邀请码。Docker 宿主机端口保持 `GUIDE_BIND=127.0.0.1`；指定空闲的 `GUIDE_PORT`，不要让应用的明文端口继续暴露公网。
5. `docker compose up -d --build`。SQLite 写入命名卷 `chat-storage`，容器其他路径保持只读。仅运行一个应用实例；不要通过多个实例共享 SQLite。新建卷从镜像继承 `/app/storage` 的 node 用户权限。
6. 用 `deploy/nginx-ip-https.conf` 替换步骤 2 的站点配置，替换 `PUBLIC_IP` 和 `APP_PORT`，确认实际证书路径。`nginx -t` 成功后重载。非流式请求的代理等待时间为 110 秒，大于后端 90 秒超时。
7. 在 `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx` 安装可执行脚本：

   ```sh
   #!/bin/sh
   set -eu
   nginx -t
   systemctl reload nginx
   ```

8. 检查安装方式所提供的 Certbot 自动续期 timer 已启用，至少每日运行两次；执行 `sudo certbot renew --dry-run`，确认挑战和重载正常。IP 证书仅有效 6 天，必须监控续期失败及剩余有效期。
9. 从公网浏览器访问 `https://YOUR_PUBLIC_IP/chat`，确认无证书警告、能注册、保存 Key 并得到真实回复。再用另一账号确认记录隔离，退出再登录确认记录恢复。

官方资料：[IP 证书与 Certbot](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)、[DeepSeek 聊天 API](https://api-docs.deepseek.com/api/create-chat-completion/)。

## 存储与恢复

本地默认 `storage/chat.sqlite`；Docker 默认 `/app/storage/chat.sqlite`（命名卷）。数据库含用户资料、聊天正文、加密 Key 和会话令牌哈希，因此应限制服务器文件权限，并保护备份。聊天正文目前不是应用层加密。

- **加密密钥与数据库分开备份**，不要随意重新生成加密密钥；丢失密钥就不能恢复已存 Key。启动会检查密钥指纹，避免配置错误后覆盖数据。
- 一致备份：停止应用后备份整个存储目录/卷，再启动。运行中的 WAL 数据库不可只拷贝主 `.sqlite` 文件。
- 不要执行 `docker compose down -v`，这会删除聊天卷。
- 轮换邀请码不会影响已有账号。第一版为可复用的团队邀请码，不是一次性邀请链接。
- 服务重启会将未完成消息标记失败，用户可手动重试。密码重置与账号注销管理尚未提供。
- 生产不记录请求正文、密码或 Key；不得在代理中启用请求体日志。

## 验证与限制

`npm run check` 与 `npm test` 覆盖账号、隔离、持久化、失败重试、全历史、不流式及现有行程回归。浏览器测试 `tests/chat.browser.cjs` 使用模拟 DeepSeek 返回，以验证 UI；真实 DeepSeek 调用必须另外用有效 Key 验收，不计入模拟测试的覆盖。
