# 代码审查报告 001

- 编号：001
- 日期：2026-09-24
- 范围：全项目首次审查，并核对最新提交 `9b77dd1`（`feat(audit): expose audit pages and backup records`）
- 对照：`docs/DESIGN.md`、`docs/API.md`、`docs/SCHEMA.md`、`.cursorrules`
- 结论：**[CRITICAL BLOCKER]**

最新提交的分页测试有真实断言，不是空跑。全局对照之后，登录锁定、改密会话和审计脱敏没有按契约工作，不能按已完成推进。

## 1. 评审结论

**[CRITICAL BLOCKER]**

登录失败次数不会留下记录，设计要求的 429 锁定到不了。改密后当前会话会被自己作废，又没有签发新会话。新开放的 `GET /audit` 会把姓名和学号原样返回，与接口契约相反。

## 2. 审计发现清单

### 1. 登录锁定被事务回滚吃掉

- **文件与行号**：`src/services/auth.ts` 第 32–44 行；`src/repo/db.ts` 第 68–69 行
- **严重等级**：高
- **问题描述**：失败尝试写在 `withTx` 里，随后抛 `AppError`。Drizzle 会整笔回滚，`login_attempt` 插不进去。`countRecentFailures` 永远是 0，`RATE_LIMITED` 到不了。设计要求同一用户名或同一 IP 在 15 分钟内失败 5 次返回 429，实现只查用户名，不查 IP。
- **修复建议**：失败记录用独立事务先提交，锁定时不要再插入，避免窗口被一直往后推。

```ts
// src/services/auth.ts
const failures = await withTx(db, async (tx) => {
  const byName = await authRepo.countRecentFailures(tx, input.username);
  const byIp = meta.ip ? await authRepo.countRecentFailuresByIp(tx, meta.ip) : 0;
  return Math.max(byName, byIp);
});
if (failures >= MAX_FAILURES) throw Errors.rateLimited();

const teacher = await withTx(db, (tx) =>
  authRepo.verifyTeacherPassword(tx, input.username, input.password),
);
if (!teacher) {
  await withTx(db, (tx) => authRepo.logLoginAttempt(tx, input.username, meta.ip, false));
  throw Errors.unauthenticated('用户名或密码错误');
}
```

`countRecentFailures` 使用 `COUNT(*)::int`。成功登录、建会话、写审计仍放在后面的同一个事务里。

### 2. 改密后当前用户也被踢下线

- **文件与行号**：`src/services/auth.ts` 第 101–114 行；`src/repo/auth.ts` 第 109–116、158–159 行；`src/server.ts` 第 169–173 行
- **严重等级**：高
- **问题描述**：改密把 `teacher.token_version` 加 1，当前 `session.token_version` 仍是旧值。下次 `validateSession` 判定版本不一致，返回 401。路由没有 `Set-Cookie`。设计要求撤销全部旧会话并建立当前新会话。
- **修复建议**：在同一事务里撤销该教师全部会话，创建新会话，把新令牌写回 Cookie。

```ts
// src/services/auth.ts — changePassword 在改密成功后
await authRepo.revokeAllSessions(tx, teacherId);
const created = await authRepo.createSession(tx, {
  teacher_id: teacherId,
  token_version: teacher.token_version, // 已 +1 后的值
  expires_in_ms: SESSION_TTL_MS,
});
return { token: created.token };
```

```ts
// src/server.ts POST /api/v1/auth/password
const { token } = await authService.changePassword(...);
reply.setCookie(SESSION_COOKIE, token, {
  httpOnly: true, sameSite: 'lax', path: '/',
  secure: process.env['HTTPS_ENABLED'] === 'true',
});
```

### 3. 审计接口返回匿名化前的姓名和学号

- **文件与行号**：`src/server.ts` 第 236–239 行；`src/services/audit.ts` 第 58–66 行；`src/services/students.ts` 第 152–158、204–211 行
- **严重等级**：高
- **问题描述**：`docs/API.md` 写明审计记录不包含学生被清空前的姓名和学号。新增和改名把 `name`、`student_no` 写入 `audit_log.before` / `after`，这次提交的 `GET /audit` 原样返回。学生匿名化之后，身份仍可从审计接口读出。
- **修复建议**：写入时不要放姓名和学号。查询时去掉已有记录里的这两个字段。

```ts
function redactAudit(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { name, student_no, ...rest } = value as Record<string, unknown>;
  return rest;
}
// listAudit 映射时：before: redactAudit(r.before), after: redactAudit(r.after)
```

补一条集成测试：匿名化之后 `GET /audit` 的 JSON 里不再出现该生原姓名和学号。

### 4. 外部匿名账本的读改写没有互斥

- **文件与行号**：`src/services/anonLedger.ts` 第 87–114 行；`src/services/students.ts` 第 487–493 行
- **严重等级**：高
- **问题描述**：两次匿名化会同时读出同一份账本，后完成的 `rename` 覆盖先写入的条目。账本是恢复旧备份后补做匿名化的唯一依据，丢掉的条目无法补做。第 492 行的空 `catch` 把密钥错误和磁盘错误都换成同一句内部错误，原因没有留下。
- **修复建议**：对账本文件加排他锁，包住读取、追加和 `rename`。`catch` 里先记下原始错误再抛 `AppError`。账本写入成功但数据库随后回滚时，重试应复用同一 `student_id + process_version`，这一点现有逻辑可以保留。

### 5. 积分时间线被截断，还告诉客户端已经到头

- **文件与行号**：`src/server.ts` 第 463–468 行；`src/lib/schema.ts` 第 541–543 行；`src/services/points.ts` 第 518–531 行
- **严重等级**：高
- **问题描述**：仓库查询支持 `cursor_seq`，路由却固定返回 `next_cursor: null`。默认 `limit` 为 50，更早的批次不会出现，调用方也无法翻页。`z.coerce.boolean()` 对字符串 `"false"` 得到 `true`，`include_reversals=false` 实际仍包含冲销记录。
- **修复建议**：用最后一条的 `seq` 作为 `next_cursor`；没有更多行时才返回 `null`。布尔查询改成显式枚举：

```ts
include_reversals: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
```

### 6. 本次审计测试没有守住契约

- **文件与行号**：`test/audit.test.ts` 第 33–44 行；`test/audit.integration.test.ts` 第 61–80 行
- **严重等级**：中
- **问题描述**：测试有断言，不是空跑。集成测试也真的连了 PostgreSQL，并核对了分页顺序、备份大小和磁盘告警。缺口是：未登录用例没有断言错误码；没有已登录的 `GET /audit`；没有断言响应里不出现姓名和学号。`cursor` 只限制为数字，超长数字会变成 `Infinity`，分页条件失效。服务里 `requiredIso` 抛的是普通 `Error`，会变成 500，而不是 `AppError`。
- **修复建议**：

```ts
cursor: z.string().regex(/^[1-9]\d{0,18}$/).optional(),
```

已登录请求要断言 `401` 的 `error.code`，以及一条含姓名的审计记录经接口返回后已被去掉姓名和学号。

### 7. 分层和入参校验

- **文件与行号**：`src/server.ts` 第 261、337、482 行；`src/services/marks.ts` 第 85–102 行；`src/services/points.ts` 第 80–84、91–94 行
- **严重等级**：中
- **问题描述**：`.cursorrules` 要求 `server → services → repo`。导入模板和 SSE 在路由里直接调用 `classRepo`、`auditRepo`。多数 `:id` 只做类型断言，非法 UUID 会变成数据库 500，而不是 `VALIDATION_FAILED`。记分用 `SEAT_MOVE_UNBALANCED` 表示分值方向错误。`student_ids` 没有去重，同一学生在一批里会出现两次，余额会被加两次。`createBatch` 在循环里逐人查座位。
- **修复建议**：路径参数统一走已有的 `routeId()`。分值方向改用独立错误码，并同时写入 `ERROR_CODES`、`ERROR_HTTP_STATUS`、`docs/API.md` 和 `web/src/lib/schema.ts`。记分前 `new Set(student_ids)`，长度不一致就返回 `VALIDATION_FAILED`。座位一次按班级查出再在内存里匹配。

### 8. 文档与实现已经脱节

- **文件与行号**：`docs/DEVIATIONS.md` 第 12–13 行
- **严重等级**：低
- **问题描述**：这里仍写没有数据库集成测试、本机没有跑迁移。仓库里已有 `test/*.integration.test.ts`，最新提交也跑了嵌入式 PostgreSQL。后续审计会把已完成项再当成缺口。

## 3. 给开发会话的修复指令摘要

修复三处阻断项，并补上能失败的测试：登录失败必须在独立事务里提交，同一用户名或同一 IP 15 分钟内失败 5 次返回 429，且测试能证明记录没有被回滚；改密时撤销全部旧会话、签发新会话并 `Set-Cookie`，当前设备保持登录，其他设备得到 `SESSION_REVOKED`；`audit_log` 的写入和 `GET /audit` 都不得包含学生姓名与学号，匿名化之后再查审计仍断言不到这两项。匿名账本的读改写加排他锁。`GET /points/entries` 返回真实的 `next_cursor`，`include_reversals=false` 必须能排除冲销。
