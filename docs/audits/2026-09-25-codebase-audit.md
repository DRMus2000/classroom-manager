# 2026-09-25 全仓库代码与文档审计

- 范围：`README.md`、`TODO.md`、`需求文档.md`、`docs/`、配置、3 份 SQL 迁移、后端/前端源码、测试与运维脚本；旧审计仅作历史背景
- 方法：静态交叉审查、接口/配置对照、后端与前端构建及类型检查、定向测试
- 结论：**C 级（约 62/100），暂不具备真实学生数据的生产上线条件**

## 1. 执行摘要

核心领域规则有清晰分层：座位编号、换座、积分与回放的纯函数独立于 SQL；写操作普遍使用事务、幂等键、审计记录和提交后 SSE。后端与前端 TypeScript 检查和构建通过，32 个定向纯函数测试通过。

主要风险不在这些算法，而在交付链路：当前 Docker 镜像构建失败，Compose 的备份任务无法在所配置容器中写盘，也没有可用的下载/恢复接口；数据库密码和 HTTPS Cookie 配置没有按文档接通。匿名化账本与数据库之间还存在跨资源提交窗口。下面的问题按当前代码判断，历史审计已修复的项没有重复计入。

## 2. 问题清单

### 高风险

| 编号与路径/代码段 | 问题描述与影响 | 改进方案 |
|---|---|---|
| H1 `Dockerfile:8-17`、`package.json` 的 `typescript` 开发依赖 | 构建阶段运行 `npm ci --omit=dev --ignore-scripts`，随后执行 `npm run build` (`tsc`)。镜像内没有编译器，`docker compose up -d --build` 无法完成。`--ignore-scripts` 还要求对 `argon2` 原生模块做运行验证。 | 构建阶段用完整依赖执行 `npm ci && npm run build`；运行阶段重新安装/复制仅生产依赖。增加镜像构建、启动及登录冒烟测试。 |
| H2 `docker-compose.yml:55`、`Dockerfile:21-35`、`scripts/backup.ts:13-19`、`cli/index.ts:205-212` | 备份脚本在 API 环境调用 `pg_dump` 并写 `backups`，但运行镜像无 PostgreSQL 客户端，`/app/backups` 又以只读方式挂载；Compose 没有定时调用备份脚本。当前不会形成文档承诺的每日可恢复备份。 | 在可写持久卷且有 `pg_dump` 的作业环境运行脚本，传入 `BACKUP_DIR`/保留期，设置调度和失败告警；用真实 dump 做恢复演练。 |
| H3 `docker-compose.yml:10,45,77`、`nginx.conf:23-106`、`src/server.ts:190,218` | Postgres 和 API URL 都硬编码 `classroom_password`，忽略 `.env`；443 端口发布但 TLS server 只是注释模板；Compose 不传 `HTTPS_ENABLED`，因此即使外部终止 TLS，登录 Cookie 也不会带 `Secure`。这会使生产凭据和传输保护与文档不符。 | 使用同一受控环境变量或 secret 配置数据库两端；完成 443 的静态资源/API/SSE 代理及 80 跳转；传 `HTTPS_ENABLED=true`，测试 `Set-Cookie`。 |
| H4 `src/services/students.ts:374-384,489-517`、`src/services/anonMaintenance.ts:88-130` | 匿名化在数据库事务内先将条目追加到库外文件，再执行 SQL 并提交。文件写入后若 SQL/提交失败，数据库会回滚，但文件不会；旧备份恢复后的 `anon-reapply` 可能把原本未提交的匿名化当成已完成操作。 | 设计可恢复的两阶段/outbox 协议：先持久化待导出意图，提交后写文件并确认；恢复时校验已提交的匿名化登记或操作版本。补“文件成功、SQL/提交失败”的故障注入测试。 |

### 中风险

| 编号与路径/代码段 | 问题描述与影响 | 改进方案 |
|---|---|---|
| M1 `src/services/imports.ts:53-60,662-671` | 预览令牌 15 分钟过期时 `cleanupPreviews()` 只删 `previews`，不删 `payloadChangeSets`。每次上传最多 2MB 的工作簿解析结果会长期留在进程内；反复上传可持续推高内存。 | 合并两张 Map，或在过期清理时同步 `payloadChangeSets.delete(k)`；加过期及大量预览的测试。 |
| M2 `src/services/points.ts:65-80,693-729,799-834` | 班内模板由全局模板行加班级覆盖表示；记分只按 `template_id` 查模板，不验证它在目标班级有效、未隐藏。知道其他班私有模板 ID 的调用者可在本班记分并留下错误原因快照。 | 记分时以目标班的有效模板集校验 `template_id`，拒绝隐藏或不属于该班的模板；增加跨班集成测试。 |
| M3 `src/server.ts:140,180-185`、`src/services/auth.ts:31-49` | 登录限流使用 `request.ip`，Fastify 未设置可信代理。在 Nginx 后所有用户的 IP 都可能成为代理地址，一人的失败会锁住其他人；失败次数检查与插入分开，也挡不住并发突发尝试。 | 仅信任明确的代理链并测试真实客户端 IP；对用户名/IP 的计数与失败记录使用可串行化的限流机制或边缘限流。 |
| M4 `src/services/points.ts:553-575`、`src/repo/points.ts:354-422` | `/points/entries` 用明细序号分页，却把每页明细按批次聚合。同一批次跨分页边界时会在两页出现两个不完整批次，`member_count` 与当前 `entries` 数量不一致。 | 明确以明细为列表单位，或先按批次分页再取该批全部明细；增加单批成员数超过页容量的测试。 |
| M5 `src/services/replay.ts:139-228` | 每页回放从不晚于区间起点的检查点重放至当前页尾。逐页播放长时间轴时前面事件被反复读取和计算，累计成本随页数增长。 | 以游标附近的检查点/已计算状态作为后续页起点，并用长时间轴基准测试确定阈值。 |
| M6 `src/server.ts:139-835`、`docs/API.md` | 路由全部集中在约 700 行的 `server.ts`。文档曾列出座次历史、学生积分详情、余额、备份下载和 OpenAPI，但代码无对应路由，`package.json` 的 `openapi` 脚本目标文件也不存在。调用方会遇到 404 或脚本失败。 | 按模块拆路由并建立机器可验证的路由清单；对目标接口逐一实现或明确撤销，修复或移除无效脚本。当前 API 文档已标注规划接口。 |
| M7 `src/lib/schema.ts:482-490`、`src/services/points.ts:33-135`、`migrations/001_phase1_core.sql` 的积分表 | 需求与原 API 样例允许记分补录备注，但请求 schema 和积分表没有 `note`。Zod 会剥离未知字段，调用方可能收到成功响应却丢失补录缘由。 | 增加迁移、请求契约、账本存储、查询和导出字段，并测备注重放；若不做则明确撤销需求。API 文档已按当前实现去掉该字段。 |

### 低风险

| 编号与路径/代码段 | 问题描述与影响 | 改进方案 |
|---|---|---|
| L1 `web/package.json`、`web/src/` | 安装了 TanStack Query、Zustand，但前端使用自定义 Hook 和 Context，未发现实际导入。多一套未使用依赖增加包维护成本，也使 README 技术栈误导。 | 决定是否采用后移除未使用依赖，或在真正迁移状态管理后再更新文档。 |
| L2 `src/repo/points.ts:410`、`src/lib/schema.ts:742-750` | `student_name` 通过 `as any` 取值；导入契约允许 `seat_change`，服务只产生 `create/update/keep`。局部类型逃逸和过宽契约会掩盖返回形状漂移。 | 给查询结果显式联合类型；收窄枚举或实现并测试 `seat_change`。 |
| L3 `.github/` 不存在、`test/*.integration.test.ts` | 仓库有较多集成测试，但没有 CI 配置；当前环境全量测试未得出完整结果，也没有生产镜像、备份恢复、TLS Cookie、预览清理及跨班模板的回归测试。 | 建立顺序或隔离端口的 PostgreSQL 集成测试流水线，并增加部署冒烟与故障注入检查。 |
| L4 `README.md` 的许可证段、仓库根目录 | README 声明 MIT，但仓库没有 `LICENSE` 正文，外部分发时授权边界不清。 | 确认版权归属后加入 MIT 许可证正文；README 已标注当前状态。 |
| L5 `src/repo/audit.ts:12-13,76-78` | 仓储写事件时直接调用 `afterCommit()` 注册进程内广播，形成 `repo → events` 依赖；与设计里服务层承担事件编排的边界不完全一致。 | 将提交后发布的注册放到服务事务协调层，仓储仅返回已写入的事件行；对所有写入口统一验证提交后才广播。 |

## 3. 技术债务与架构演进

| 阶段 | 优先工作 |
|---|---|
| 短期，上线前 | 修复 H1-H4；接通可验证的备份和恢复；修复 M1-M3；用真实 Compose 环境完成迁移、登录、写入、备份、匿名补做、HTTPS 的端到端演练。 |
| 中期 | 按业务模块拆分 `server.ts`；统一路由、Zod 和 API 文档的来源；修复积分分页边界、长回放效率，补契约和性能测试。 |
| 长期 | 为备份做异地副本与定期恢复演练；将库外匿名化账本设计为可对账、可恢复的持久协议；建立 CI/CD、依赖更新和可观测的作业告警。 |

架构边界总体遵循 `server → services → repo` 与 `services → domain`；目前未发现 `domain` 反向依赖数据库的循环。例外是 `repo/audit.ts` 依赖事件广播器。主要职责压力集中在单一 HTTP 入口和 `duty.ts` 的服务层 SQL。对 2C4G 单机目标，优先改善备份可靠性与回放分页，而不是引入多副本或新的框架。

## 4. 文档与代码不一致项

| 原位置 | 已核实偏差与本次维护 |
|---|---|
| `README.md`、`docs/DESIGN.md` | 仍称前端页面/路由未做或 `src/routes` 存在；已改为当前 `web/src` 页面和 `src/server.ts` 集中路由，并区分实现与上线验收。 |
| `README.md`、`docs/API.md`、`src/lib/schema.ts` 注释 | 宣称 `/api/v1/openapi.json` 与生成脚本可用；实际无脚本/路由。文档已标为规划，代码注释仍待随实现修正。 |
| `docs/API.md` | 错误码 `IMPORT_TOKEN_EXPIRED` 实际为 409；学期汇总形状、`snapshot` 帧、座位 `duty` 字段与样例不符；已按代码修正。未实现的路径已逐条标注。 |
| `需求文档.md`、`docs/API.md` 的记分备注 | 原文允许补录备注，当前 schema 和数据库均没有该字段。已标为待验收需求，API 示例不再暗示可以保存。 |
| `docs/DEPLOY.md`、`.env.example` | 曾把 Compose、cron、备份下载和 `restore` CLI 当作现成能力，且未说明 `.env` 不会自动进入 Node 进程。已改为可用本地步骤与生产阻断清单。 |
| `docs/DEVIATIONS.md` | 仍称 Drizzle 返回类型导致类型检查失败；当前已有 `src/repo/db.ts` 包装。已更新差异表。 |
| `需求文档.md` vs `docs/DESIGN.md` | 需求初稿写座位编号追加不复用，最终设计和代码按布局变化全局重排。已保留历史决策并标明最终规范。 |
| `TODO.md` | 全部勾选容易被误读为已通过生产验收；已添加上线前未完成项。历史 `docs/audits/001` 至 `006` 保留原结论，不追溯改写。 |
| `README.md` 的许可证段 | 原文写 MIT License，但仓库无 `LICENSE` 文件；已标为授权意向与待补事项。 |

## 5. 验证与边界

- `npm run typecheck`、`npm run build`、`npm run typecheck --prefix web`、`npm run build --prefix web`：通过。
- 定向纯函数测试：32/32 通过（编号、换座、回放、幂等、备份辅助函数、时间解析）。
- `npm test` 与随后串行运行的数据库集成测试均在本 Windows 沙盒的嵌入式 PostgreSQL 初始化后长时间停滞；已停止测试会话，**不能据此声称集成测试通过或失败**。需在隔离的 PostgreSQL/CI 环境复跑。
- 未执行 Docker 镜像构建、真实备份恢复和 HTTPS 访问演练；对生产阻断项的判断来自配置与代码路径交叉验证。
