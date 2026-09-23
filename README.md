# 电脑室学生积分管理系统

一位信息技术教师管理多个班级，围绕真实机房座位完成学生积分、课堂展示和卫生管理的 Web 应用。学生无需登录。

## 核心特性

**第一阶段（领域规则与主要 HTTP 入口已按设计接上，页面仍未做）**
- 单账号登录 + 改密 + 踢出其他设备
- 班级与学期管理（全局切换、旧学期只读）
- 名单导入（双模板：行表 / 平面座位表）+ 冲突检测 + 整体提交
- 全局机房布局（4 列 54 座，插入/删除后自动重排编号）
- 座次管理（换座草稿 + P1–P3 校验 + 批量保序移动）
- 积分账本（单人/批量记分 + 撤销 + 时间线 + 模板覆盖）
- 幂等保证（`request_id` 全局唯一 + 双击防抖）
- 多端同步（SSE + 事件序号断线续传 + 版本冲突提示）
- 审计日志（所有管理状态变更同事务写入）
- 备份记录（每日 pg_dump + 30 天轮转 + 磁盘监测）

**第二阶段（设计已定，见 `docs/DESIGN.md`，待实施）**
- 普通标记 + 卫生管理员（轮次状态机 + 冻结候选 + 不放回随机替补）
- 排行榜（同分并列 + 破并列：最近一次达到当前分数时间）
- 动态回放（横向柱状竞赛 + 累计/净增减 + 检查点 + 拖动）
- 全屏展示 + 随机点名（本轮不重复）+ 倒计时（服务端状态跨端同步）
- 完整导出（名单/积分明细/排行榜 Excel）

## 技术栈

- **前端**：React 18 + TS + Vite；TanStack Query + Zustand；响应式布局，微信内置浏览器兼容
- **后端**：Node 22 + Fastify + Zod（→ OpenAPI）；Drizzle ORM + 手写迁移；Argon2id 密码哈希
- **数据库**：PostgreSQL 16；事务 + 唯一约束保证一致性；LISTEN/NOTIFY 辅助多端同步
- **实时推送**：SSE（text/event-stream）+ Last-Event-ID 断线重连
- **部署**：Docker Compose（nginx + api + postgres）；2C4G 单机适配；数据库不暴露公网

## 设计原则（贯穿全系统的 12 条公理）

| # | 公理 | 落地体现 |
|---|---|---|
| A1 | 座位编号是显示属性，不是标识 | 任何引用用 `seat_id`(UUID)；快照成对保存 `seat_id + seat_number_snapshot` |
| A2 | 编号由全局重排函数生成（①②③④ 逐列遍历；`toward_back` 升序，`toward_front` 降序） | 规范见 `docs/DESIGN.md` §3.1；历史快照永不回溯 |
| A5 | 账本只追加 | 分数变动 = 插入明细；撤销 = 插入反向明细并双向关联 |
| A6 | 一次批量 = 一个批次，整体成功或整体失败 | 同批次共享同一时间戳（保证并列破序时无人为先后） |
| A7 | 幂等键 `request_id` 全局唯一 | 同键重试返回原结果 200，不重复执行 |
| A8 | 回放 = 事件序列 + 检查点 | 累计分起点随区间滑动；每 N 个事件触发一次检查点 |
| A9 | 卫生轮次与学期、积分完全解耦 | 轮次可跨学期延续；卫生操作永不写账本 |
| A10 | 每班每线最多一个未结束轮次；每轮最多一个未确认抽选（含已取消但未作废的预览） | 见 `docs/DESIGN.md` §4.2 |
| A11 | 离班 = 状态机转移，永不删除数据 | 离班学生不出现在当前榜单/点名池，但可恢复 |
| A12 | 所有写入以服务端校验为准，携带 `expected_version` | 版本过期一律 409，不静默合并 |

## 快速开始

### 本地开发

```bash
# 安装依赖
npm install

# 复制环境变量模板并填写（数据库连接 + SESSION_SECRET）
cp .env.example .env

# 启动 PostgreSQL（本地或 Docker）
docker run -d --name classroom_db \
  -e POSTGRES_DB=classroom_manager \
  -e POSTGRES_USER=classroom \
  -e POSTGRES_PASSWORD=YOUR_PASSWORD \
  -p 5432:5432 postgres:16-alpine

# 执行迁移
npm run migrate up

# 启动开发服务器
npm run dev

# 前端开发（另一终端）
cd web && npm install && npm run dev
```

访问 `http://localhost:3000` （API）和 `http://localhost:5173`（前端）。

### 生产部署

设计正文见 `docs/DESIGN.md`，接口见 `docs/API.md`，部署见 `docs/DEPLOY.md`，与代码的差异见 `docs/DEVIATIONS.md`。部署核心步骤：

1. 准备 Ubuntu 云服务器（2C4G+，Docker + Docker Compose）
2. 克隆仓库 + 复制 `.env.example` 为 `.env` 并填写强密码
3. 构建前端：`cd web && npm run build`
4. 启动容器：`docker-compose up -d`
5. 执行迁移：`docker-compose exec api node dist/scripts/migrate.js up`
6. 创建教师账号：`docker-compose exec api node dist/cli/index.js create-teacher`
7. 配置宿主机 cron 每日备份：`17 2 * * * docker-compose exec postgres pg_dump ...`
8. 试运行阶段仅用测试数据；配置 HTTPS 后再录入真实学生信息

## 项目结构

```
classroom-manager/
├── migrations/          # SQL 迁移（001 第一阶段、002 第二阶段）
├── src/
│   ├── domain/         # 纯领域逻辑（renumerate, planSwap, points）
│   ├── lib/            # schema.ts（Zod 契约层）、crypto.ts、errors.ts
│   ├── repo/           # 数据访问层（Drizzle）
│   ├── services/       # 业务编排（事务边界在此）
│   ├── routes/         # Fastify 路由
│   ├── events/         # SSE 广播器
│   └── server.ts       # 应用入口
├── scripts/            # 运维脚本（checkpoint, backup, anon-ledger）
├── cli/                # 维护命令（create-teacher, reset-password, recompute-balance）
├── web/                # React 前端（独立子项目）
├── docs/               # DESIGN, SCHEMA, API, DEPLOY, DEVIATIONS
├── docker-compose.yml  # 三容器编排（nginx + api + postgres）
└── nginx.conf          # 反向代理 + SSE 调优
```

## 关键接口

完整 API 参考见 `docs/API.md` 与 `/api/v1/openapi.json`（由 Zod 生成）。

**第一阶段核心接口**（前缀 `/api/v1`，全部需登录除 `/auth/login`）：
- **认证**：`POST /auth/login` · `POST /auth/logout` · `POST /auth/password`
- **班级与学期**：`GET /classes` · `POST /terms` · `POST /terms/:id/activate`（全局切换）
- **学生**：`GET /classes/:id/students` · `POST /students/:id/leave`（二次确认）· `POST /students/:id/restore`
- **导入**：`POST /classes/:id/import/preview` → `POST /classes/:id/import/commit`（双阶段）
- **布局**：`GET /layout` · `POST /layout/preview-change` → `POST /layout/apply-change`
- **座次**：`GET /classes/:id/seats` · `POST /classes/:id/seats/plan`（求值）· `POST /classes/:id/seats/apply`
- **积分**：`POST /points/batches`（单人/批量统一）· `POST /points/batches/:id/reverse`（整批撤销）· `POST /points/entries/:id/reverse`（单条撤销）· `GET /points/entries`（筛选时间线）
- **事件流**：`GET /events?since=<seq>`（SSE，带 Last-Event-ID 重连）
- **备份**：`GET /backup/records` · `GET /backup/download/:backup_id`

## 验收清单（对应需求 §5）

**第一阶段**
- [ ] 双模板导入蛇形 54 机位；冲突无部分写入
- [ ] 所有在班学生各占一座；删除机位检查全部班级
- [ ] 框选/整列/全班 + 换座全场景（重叠链、空座、列长不同、越界、取消）
- [ ] 单人/批量/无原因/负分/重复请求/部分撤销后整批撤销
- [ ] 切学期归零、座次与延续状态保留、历史只读
- [ ] 双设备冲突提示、断网不写
- [ ] 54 座无卡顿、反馈 < 100ms、同步 < 2s
- [ ] 备份恢复演练 + HTTPS 后上真实数据

**第二阶段**（见需求文档 §5.2）
- [ ] 卫生严格四步顺序、新任者不入本轮候选
- [ ] 覆盖候选耗尽/取消不重抽/刷新继续/两设备重复确认/再次违规/未值日加义务/人工纠正
- [ ] `1/3 → 1/4` 与"下一轮才计次"
- [ ] 回放并列/负分/整批/撤销/跨班/离班/匿名
- [ ] 导出与筛选一致、座位表可回导

## 数据安全与匿名化

- **密码**：Argon2id（memoryCost=64MB, timeCost=3）+ `token_version` 踢出其他设备
- **登录限流**：同用户名/IP 5 次/15 分钟
- **数据库安全**：容器内网通信，不发布宿主机端口
- **备份**：每日 `pg_dump -Fc` 轮转 30 天，可下载；恢复通过维护命令
- **匿名化**：学生级 / 班级批量；清空 `name`/`student_no`/`remark`，保留 `anon_code`；**外部 append-only 账本**独立于数据库备份（见 `DEPLOY.md`），用于恢复旧备份后补做后续匿名化

## 已知限制（首版）

- 单教师账号（不支持多教师协作）
- 学生无账号（无考勤、作业、小组积分）
- 首版不保证断网重新打开页面可用（保留已加载内容，禁止修改）
- 微信小程序留待后续开发
- 异地备份自动同步留作增强

## 许可证

MIT License

## 支持

技术问题请提交 Issue，附上：
- 复现步骤
- 预期行为 vs 实际行为
- 浏览器版本（若前端问题）
- 服务端日志相关片段（脱敏后）

安全问题请私信报告，不公开披露。
