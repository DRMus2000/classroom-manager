# 电脑室学生积分管理系统

小学信息老师自用的电脑室积分管理系统，使用GPT-6 Astra配合grill-me 制定需求方案，claude fable 5.1进行系统设计（做了一半没额度了让Grok接手了），Grok 4.6 4.7进行代码实现和测试，GPT-6 Astra进行最终审计，最后用cursor cloud agent进行部署验收，第一次用ai来制作工具，经验不足见谅。

以下是AI维护的README内容

## 核心特性

**第一阶段（后端接口、页面和 Compose 部署已接通）**
- 单账号登录 + 改密 + 踢出其他设备
- 班级与学期管理（全局切换、旧学期只读）
- 名单导入（双模板：行表 / 平面座位表）+ 冲突检测 + 整体提交
- 全局机房布局（4 列 54 座，插入/删除后自动重排编号）
- 座次管理（换座草稿 + P1–P3 校验 + 批量保序移动）
- 积分账本（单人/批量记分 + 撤销 + 时间线 + 模板覆盖）
- 幂等保证（`request_id` 全局唯一 + 双击防抖）
- 多端同步（SSE + 事件序号断线续传 + 版本冲突提示）
- 审计日志（所有管理状态变更同事务写入）
- 备份任务与记录（`pg_dump` + 30 天轮转 + 磁盘监测；备份容器每天 02:15 执行）

**第二阶段（业务接口、页面和云上验收已完成）**
- 普通标记 + 卫生管理员（轮次状态机 + 冻结候选 + 不放回随机替补）
- 排行榜（同分并列 + 破并列：最近一次达到当前分数时间）
- 动态回放（横向柱状竞赛 + 累计/净增减 + 检查点 + 拖动）
- 全屏展示 + 随机点名（本轮不重复）+ 倒计时（服务端状态跨端同步）
- 完整导出（名单/积分明细/排行榜 Excel）

## 技术栈

- **前端**：React 18 + TS + Vite。数据获取和状态由本地 Hook 管理
- **后端**：Node 22 + Fastify + Zod；Drizzle 数据库连接与手写 SQL/迁移；Argon2id 密码哈希
- **数据库**：PostgreSQL 16；事务 + 唯一约束保证一致性；事件先写 `event_log`，由服务层在提交后广播
- **实时推送**：SSE（text/event-stream）+ Last-Event-ID 断线重连
- **部署**：Docker Compose（nginx + api + backup + postgres）。见 `docs/DEPLOY.md`

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
npm ci

# 复制环境变量模板并填写（本地开发须把 DATABASE_URL 的主机改成 localhost）
cp .env.example .env

# 启动 PostgreSQL（本地或 Docker）
docker run -d --name classroom_db \
  -e POSTGRES_DB=classroom_manager \
  -e POSTGRES_USER=classroom \
  -e POSTGRES_PASSWORD=YOUR_PASSWORD \
  -p 5432:5432 postgres:16-alpine

# 将 .env 中的变量导入当前终端后执行迁移；Node 脚本不会自动读取 .env
set -a; . ./.env; set +a
npm run migrate up

# 启动开发服务器
npm run dev

# 前端开发（另一终端）
cd web && npm ci && npm run dev
```

访问 `http://localhost:3000` （API）和 `http://localhost:5173`（前端）。

在 PowerShell 中，先将本地连接信息设为进程环境变量（例如 `$env:DATABASE_URL = 'postgresql://classroom:YOUR_PASSWORD@localhost:5432/classroom_manager'`），再运行迁移与后端命令；Node 不会自动读取 `.env`。需要测试匿名化时还须设置有效的 `ANON_LEDGER_KEY` 和可写的 `ANON_LEDGER_PATH`。

### 生产部署

设计正文见 `docs/DESIGN.md`，接口见 `docs/API.md`，部署见 `docs/DEPLOY.md`，与代码的差异见 `docs/DEVIATIONS.md`，云上验收见 `docs/ACCEPTANCE.md`。生产使用 `docker compose up -d --build`。这次云上演练使用自签证书和合成数据。录入真实学生前，换成学校的可信证书。

## 项目结构

```
classroom-manager/
├── migrations/          # SQL 迁移（001 核心到 005 学期默认关闭）
├── src/
│   ├── domain/         # 纯领域逻辑（renumber、seatMove、points 等）
│   ├── lib/            # schema.ts（Zod 契约层）、crypto.ts、errors.ts
│   ├── repo/           # 数据访问层（Drizzle 连接 + 手写 SQL）
│   ├── services/       # 业务编排（事务边界在此）
│   ├── events/         # SSE 广播器
│   └── server.ts       # 应用入口与 Fastify 路由
├── scripts/            # 迁移、检查点、备份脚本
├── cli/                # 账号、余额、检查点、备份和匿名化维护命令
├── web/                # React 前端（独立子项目）
├── docs/               # DESIGN, SCHEMA, API, DEPLOY, DEVIATIONS
├── docker-compose.yml  # nginx + api + backup + postgres
└── nginx.conf          # 反向代理 + SSE 调优
```

## 关键接口

当前 HTTP 接口见 `docs/API.md`。仓库不提供 OpenAPI。

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
- [x] 行表导入蛇形 54 机位；冲突无部分写入
- [x] 所有在班学生各占一座；删除占用机位被拒绝
- [x] 重叠换座可求值并提交；过期版本返回 409
- [x] 单人/批量/无原因/负分/重复请求/部分撤销后整批撤销
- [x] 切学期归零、座次保留、旧学期记账返回 `TERM_READONLY`
- [x] 双设备座次冲突返回 409。断网禁写由前端拦截，见页面实现
- [ ] 54 座交互反馈不超过 100ms、同步不超过 2 秒。这次没有做性能计时
- [x] 自签 HTTPS 与 dump 恢复演练。真实学生仍等可信证书

**第二阶段**
- [x] 卫生轮次、空池任命、取消不重抽、确认幂等、新任者不进本轮原管理员
- [x] 未值日把应值次数从 3 调整为 4；座位卡返回已开始计次的在任任期
- [x] 回放时间轴能看到记分帧；并列名次为 1、1、3
- [x] 花名册与积分明细可以导出；一名学生匿名化后身份已清空

## 数据安全与匿名化

- **密码**：Argon2id（memoryCost=64MB, timeCost=3）+ `token_version` 踢出其他设备
- **登录限流**：同用户名/IP 5 次/15 分钟
- **数据库安全**：容器内网通信，不发布宿主机端口
- **备份**：每天 02:15 由备份容器执行 `pg_dump`，API 可下载成功的 dump；`restore` 只能指向另一个数据库
- **匿名化**：学生级 / 班级批量；先提交库内意图，再写库外加密账本

## 已知限制（首版）

- 单教师账号（不支持多教师协作）
- 学生无账号（无考勤、作业、小组积分）
- 首版不保证断网重新打开页面可用（保留已加载内容，禁止修改）
- 微信小程序留待后续开发
- 异地备份自动同步留作增强

## 许可证

MIT License。正文见仓库根目录的 `LICENSE`。

## 支持

技术问题请提交 Issue，附上：
- 复现步骤
- 预期行为 vs 实际行为
- 浏览器版本（若前端问题）
- 服务端日志相关片段（脱敏后）

安全问题请私信报告，不公开披露。
