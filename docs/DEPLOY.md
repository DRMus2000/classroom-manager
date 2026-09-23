# 部署与恢复

目标机器是一台 Ubuntu，至少 2 核 4GB，已安装 Docker 与 Docker Compose。数据库不对公网开放。试运行只用测试数据，通过 IP 和端口访问。域名和可信 HTTPS 配好之后，才录入真实学生信息。

当前仓库还没有 `src/server.ts` 和前端页面。按本文启动会在 API 进程入口失败。差异见 `docs/DEVIATIONS.md`。下面的步骤是设计定稿后的运行方式。

## 1. 配置

```bash
cp .env.example .env
```

必须更换的值：

| 变量 | 要求 |
|---|---|
| `POSTGRES_PASSWORD` / `DATABASE_URL` | 同一套强密码。Compose 里的数据库口令与 URL 一致 |
| `SESSION_SECRET` | 至少 32 字节随机串 |
| `ANON_LEDGER_KEY` | `openssl rand -hex 32`。单独备份到密码库，不放进数据库备份 |

`REPLAY_CHECKPOINT_EVENT_THRESHOLD` 默认 200。

## 2. 构建与启动

```bash
cd web && npm ci && npm run build && cd ..
docker compose up -d --build
docker compose exec api node dist/scripts/migrate.js up
docker compose exec api node dist/cli/index.js create-teacher --username teacher
```

`create-teacher` 和 `reset-password` 从终端读取密码，不回显，不进入 shell 历史。重置密码会使已有会话失效。

迁移之后要执行一次符合 `docs/DESIGN.md` §3.1 的编号回填，54 座才是 1–54 的蛇形编号。`001` 只插入槽位。

对外端口只有 Nginx 的 80/443。Postgres 的 5432 没有宿主端口映射。

## 3. 试运行与 HTTPS

试运行保持 `nginx.conf` 的 80 端口站点，只放测试数据。Basic 认证不能代替 HTTPS。

真实数据上线前：

1. 放入证书，取消 `nginx.conf` 里 HTTPS 跳转的注释。
2. 关闭纯 HTTP 的业务 `location`。
3. 再导入真实名单。

## 4. 备份

备份在宿主机 cron 里执行，不在加减分请求里执行。API 容器把备份卷挂成只读，供下载。写入由 Postgres 容器完成。

```cron
17 2 * * * cd /opt/classroom-manager && docker compose exec -T postgres pg_dump -U classroom -Fc classroom_manager > /var/backups/classroom/$(date +\%F).dump
```

保留最近 30 天。每次执行向 `backup_record` 写入文件名、大小、剩余磁盘、成功或失败。剩余空间低于 3GB 时，管理界面显示警告。失败也要留下记录。

恢复演练在录入真实数据之前做一次：

```bash
docker compose exec api node dist/cli/index.js restore /path/to/file.dump --confirm
```

恢复命令先把当前库再导出为 `pre-restore.dump`，然后才 `pg_restore`。

异地复制备份留作以后的增强。现在的做法是每天本机备份，由教师定期下载。

## 5. 匿名化账本

库内 `anon_registry` 与库外账本都只含：

| 字段 | 说明 |
|---|---|
| `student_id` | 内部 UUID |
| `anon_code` | 展示用代号 |
| `processed_at` | 匿名化时间 |
| `process_version` | 从 1 递增 |
| `ledger_entry_id` | 外部条目 id |

不写姓名、学号、备注、姓名哈希。

外部文件在 `anon_ledger` 卷，用 `ANON_LEDGER_KEY` 加密后追加。密钥不在这份卷里，也不在 `pg_dump` 里。导出失败时 `anon_ledger_export.state = failed`，界面告警，任务重试。学生行上的姓名清空与账本条目在同一业务流程里完成；账本写入失败则整次匿名化回滚，避免库内已匿名而外部没有记录。

从旧备份恢复之后、对教师开放之前：

1. `pg_restore` 到数据库。
2. 用独立保存的密钥读取外部账本。
3. 对账本里有、而恢复出来的库尚未应用的 `process_version`，重新清空对应学生的姓名、学号、备注。
4. 检查这些 `student_id` 的姓名和学号已经为空。
5. 然后才启动对教师开放的站点。

已下载的旧 Excel 和未过期的旧备份里仍可能有原身份。恢复流程不能把它们自动抹掉，所以真实环境要限制备份下载权限，并在保留期结束后删除。

## 6. 检查点与维护命令

| 命令 | 作用 |
|---|---|
| `recompute-balance --term <id>` | 用账本重算余额并比对 |
| `cleanup-idempotency --days 7` | 清理已完成的幂等记录 |
| `anon-export-status` | 查看外部账本导出失败 |

回放检查点由后台任务写入：每 200 个回放事件一次，每天 `07 3 * * *` 兜底。任务失败不回滚已经提交的积分。

## 7. 日志与限流

日志不记录密码、密码哈希、会话令牌、Cookie。每条请求带 `request_id`。

登录失败写入 `login_attempt`。同一用户名或同一 IP 在 15 分钟内失败 5 次后返回 429。

上传只接受扩展名与 ZIP 魔数都符合的 xlsx，最大 2MB。解析单元格的值，不执行公式。
