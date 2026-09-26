# 部署与恢复

目标机器是一台 Ubuntu，至少 2 核 4GB，已安装 Docker 与 Docker Compose。数据库不对公网开放。Compose 发布 80 和 443。80 跳转到 HTTPS。没有证书时入口脚本会生成自签证书，真实学生数据上线前换成可信证书。

## 1. 配置

```bash
cp .env.example .env
```

| 变量 | 要求 |
|---|---|
| `POSTGRES_PASSWORD` | Compose 用它设置 Postgres，并写入 API 与备份任务的 `DATABASE_URL` |
| `DATABASE_URL` | 直接运行 Node 时读取。容器内由 Compose 组装 |
| `SESSION_SECRET` | Compose 必填。会话令牌仍是随机值加数据库哈希 |
| `ANON_LEDGER_KEY` | `openssl rand -hex 32`。单独备份，不放进数据库备份 |
| `BACKUP_DIR` / `BACKUP_RETENTION_DAYS` | 备份容器写入 `/backups`，默认保留 30 天 |
| `HTTPS_ENABLED` | Compose 默认 `true`，登录 Cookie 带 `Secure` |
| `TRUST_PROXY` | Compose 设为 `1`，只信任 Nginx 这一跳 |
| `REPLAY_CHECKPOINT_EVENT_THRESHOLD` | 默认 200 |

`.env` 供 Docker Compose 变量替换。直接运行 Node 时不会自动加载，先在终端导入。

## 2. 构建与启动

本地开发：

```bash
npm ci
npm run migrate up
npm run dev
```

另一个终端运行 `cd web && npm ci && npm run dev`。API 在 `http://localhost:3000`。`migrate up` 执行 `001` 到 `005`。创建账号用 `npm run cli -- create-teacher --username teacher`。密码从隐藏输入读取，管道里的两行不会丢掉第二行。

生产：

```bash
docker compose up -d --build
docker compose exec api node dist/scripts/migrate.js up
docker compose exec api node dist/cli/index.js create-teacher --username teacher
```

镜像构建阶段安装全部依赖并执行 `tsc`，运行阶段只保留生产依赖，并安装 `postgresql16-client`。编译结果在 `dist/src`、`dist/scripts` 和 `dist/cli`。容器入口先以 root 修正可写的备份卷和匿名账本卷，只读备份卷会跳过，再降到 `nodejs` 用户运行。备份容器不提供 HTTP，因此关闭了镜像自带的 `/healthz` 检查。

`create-teacher` 之后打开网站，只能登录。库里还没有学期和班级，页面会停在「未设置当前学期」，课堂区域只有转圈。第一次建学期、激活学期、建班和导入名单按 `docs/使用教程.md` 的准备步骤做。这些操作目前没有页面按钮。

## 3. HTTPS

Nginx 的 443 提供前端静态资源、`/api/`、`/api/v1/events` 和 `/healthz`。把可信证书放到 `./certs/fullchain.pem` 和 `./certs/privkey.pem`。目录为空时入口脚本会安装 openssl 并生成自签证书；如果构建机访问不到 Alpine 软件源，先在宿主机生成这两个文件再启动。登录响应的 `Set-Cookie` 在 `HTTPS_ENABLED=true` 时包含 `Secure`。

## 4. 备份与恢复

`backup` 容器在 Asia/Shanghai 02:15 执行 `pg_dump -Fc`，写入可写卷，失败时在容器日志里告警并写入 `backup_record`。API 以只读方式挂载同一卷。`GET /api/v1/backup/download/:backup_id` 下载成功的文件。

恢复不能指向正在服务的库：

```bash
node dist/cli/index.js restore --backup <backup_id> --target postgresql://classroom:PASSWORD@127.0.0.1:5432/classroom_restore --confirm
```

恢复后、重新开放前执行 `anon-reapply`，再按需 `anon-reapply --confirm`。

## 5. 匿名化账本

匿名化先在数据库提交待导出记录，提交成功后再写加密账本，最后把导出标成 `exported`。文件写入失败时学生身份已经清空，导出状态保持待重试；`anon-ledger-retry` 或同一个 `request_id` 会补写账本。数据库提交失败时不会写文件。

## 6. 检查点与维护命令

| 命令 | 作用 |
|---|---|
| `recompute-balance --term <id>` | 用账本重算余额并列出差异 |
| `cleanup-idempotency --days 7` | 清理已完成的幂等记录 |
| `anon-export-status` | 查看未导出记录 |
| `anon-ledger-retry` | 重试未导出的匿名化条目 |
| `anon-reapply [--confirm]` | 恢复旧备份后预览、补做匿名化 |
| `checkpoint [--daily]` | 写入到期回放检查点 |
| `backup` | 执行一次备份 |
| `restore --backup <id> --target <url> --confirm` | 恢复到另一个数据库 |

检查点仍由外部调度，建议每天 `07 3 * * *` 运行 `node dist/scripts/checkpoint.js --daily`。

## 7. 日志与限流

日志不记录密码、密码哈希、会话令牌和 Cookie。登录失败在同一事务的咨询锁里计数并写入。同一用户名或同一客户端 IP 在 15 分钟内失败 5 次后返回 429。Nginx 后由 `TRUST_PROXY=1` 读取 `X-Forwarded-For`。
