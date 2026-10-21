# 部署与维护

行程功能仍为只读；新增可选 AI 助手使用 Node.js 自带 SQLite 保存账号和聊天，不需要第三方 npm 包。启用方式、Key 管理、持久卷及免费 IP HTTPS 见[聊天部署说明](chat-deployment.md)。

## 运行

需要 Node.js 24 及以上。

```sh
npm start
```

默认打开http://localhost:3000/。健康检查为/api/health。

## Docker部署

```sh
docker compose up -d --build
docker compose ps
```

默认端口3000，可以通过GUIDE_PORT环境变量指定主机端口。默认仅绑定宿主机 127.0.0.1，通过 HTTPS 反向代理公开访问。项目原服务器使用666端口，更新时必须同步调整反向代理；已有.env与数据挂载应在发布时保留，不纳入Git。聊天 SQLite 使用独立命名卷，禁止用 `down -v` 更新。

## 更新行程

编辑data/guide.json，days保留有日期的两天行程，referenceDays存放无日期的一天精华游，plans指定各计划对应的日程。景点、交通与示意坐标共用。数据约1秒内重新读取，刷新即可查看；前端样式或逻辑修改后需要重建服务。先运行检查，写入完整有效的JSON，再替换线上文件。

```sh
npm run check
npm test
```

详细的当前安排见[行程参考表](reference-itinerary.md)。地图是关系示意，钟点是规划估算；天气内容由第三方天气页面提供。

## 版本与发布

- 当前网页版本web0.2.0，对应package.json版本0.2.0；可通过页面application-version元信息核对版本。
- 版本说明保存在[CHANGELOG.md](../CHANGELOG.md)，已发布标签不移动或覆盖，后续修改使用新版本号。
- 发布前核对线上源码是否被其他会话更新，并保存源码和容器镜像备份。
- 发布后核对健康接口、手机布局、行程点选和资源版本。回滚时使用该版本源码与镜像；涉及数据变更时同时恢复对应行程数据。

入园时间、酒店、个人资料等实际出行安排由使用者维护，不要向公开仓库写入私人证件、电话或订单信息。
