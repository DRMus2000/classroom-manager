# API 规格

基线是 `docs/DESIGN.md` v1.1。业务接口前缀 `/api/v1`；健康检查实际路径为根路径 `/healthz`。除登录和健康检查外都要登录。本文件保留目标契约，明确标注尚无路由的接口。页面实际调用了哪些路由，见文末「页面是否调用」。给教师的操作说明见 `docs/使用教程.md`。

业务写操作的 JSON 体一般带 `request_id`（UUID）；登录不带，导入预览用 multipart。座次和卫生轮次写操作带 `expected_version`，切学期带 `expected_current_term_id`；布局提交用 `preview_hash`。时间是带时区的 ISO 8601，服务端生成。支持分页的列表使用 `cursor` 与 `limit`，`limit` 最大 200。

## 错误体

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "座次已被其他设备修改，请载入最新状态",
    "details": {},
    "request_id": "8f2c0000-0000-4000-8000-000000000001"
  }
}
```

| HTTP | code | 含义 |
|---|---|---|
| 400 | `VALIDATION_FAILED` | 字段校验失败，`details.issues` 逐项列出 |
| 401 | `UNAUTHENTICATED` | 未登录 |
| 401 | `SESSION_REVOKED` | 会话已因改密或踢出失效 |
| 403 | `FORBIDDEN` | 已登录但无权 |
| 404 | `NOT_FOUND` | 资源不存在 |
| 409 | `VERSION_CONFLICT` | `expected_version` 过期 |
| 409 | `IDEMPOTENCY_MISMATCH` | 同一个 `request_id`，请求体不同 |
| 409 | `REQUEST_IN_FLIGHT` | 同键请求还在执行 |
| 409 | `SEAT_CONFLICT` | 重复占座 |
| 409 | `SEAT_OCCUPIED` | 删除机位时仍有班级占用，`details.classes` 列出班级 |
| 409 | `ALREADY_REVERSED` | 明细已经冲销 |
| 409 | `DUTY_SELECTION_OPEN` | 本轮已有未确认抽选（`pending` 或 `cancelled`） |
| 409 | `DUTY_NOT_FROZEN` | 尚未冻结候选就抽选 |
| 409 | `NO_PUSH_ALREADY_MARKED` | 本轮该原管理员已登记未推椅子 |
| 422 | `IMPORT_INVALID` | 导入校验失败，`details.issues` 含工作表、单元格或行 |
| 409 | `IMPORT_TOKEN_EXPIRED` | 预览令牌过期 |
| 422 | `SEAT_REQUIRED` | 在班学生没有座位 |
| 422 | `SEAT_MOVE_UNBALANCED` | 人数与目标座位数不相等，或目标座位不存在 |
| 422 | `POLARITY_MISMATCH` | 记分方向与原因模板相反 |
| 422 | `TERM_READONLY` | 学期已归档 |
| 422 | `STUDENT_NO_SEAT` | 班内存在无座在班学生，导入被阻塞 |
| 429 | `RATE_LIMITED` | 登录限流 |
| 500 | `INTERNAL` | 不返回堆栈。用 `request_id` 查日志 |

幂等命中且请求体相同：返回首次的状态码和响应体。首次成功就是 200。

## 认证

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/login` | `{username, password}`。设置 HttpOnly Cookie。同一用户名或 IP 15 分钟 5 次 |
| POST | `/auth/logout` | 撤销当前会话 |
| POST | `/auth/password` | `{old_password, new_password, request_id}`。`token_version + 1`，全部设备失效，并建立当前新会话 |
| POST | `/auth/logout-others` | 保留当前会话，撤销其他会话 |
| GET | `/auth/me` | 用户名、`token_version` |
| GET | `/healthz` | 根路径，不加 `/api/v1`；进程与数据库连通，无需登录 |

## 班级与学期

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/classes` | 含是否归档、在班人数。默认不含已归档班级；`include_archived=true` 时一并返回，便于恢复 |
| POST | `/classes` | `{name, request_id}` |
| PATCH | `/classes/:id` | 改名或归档 |
| GET | `/terms` | 含 `is_current`、`status` |
| POST | `/terms` | `{name, request_id}`。新建为 `closed`，不自动切换。激活后才成为唯一的 `open` 学期 |
| POST | `/terms/:id/activate` | `{expected_current_term_id, request_id}`。`expected_current_term_id` 为调用时看到的当前学期，没有当前学期时为 `null`。全局切换：旧学期只读，在班学生余额初始化为 0。座次、标记、未结束卫生不动 |
| GET | `/terms/:id/summary` | 只读汇总：总分、流水条数 |

## 学生与导入

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/classes/:id/students` | `status=active\|left\|anonymized\|all`，可选 `q` |
| POST | `/classes/:id/students` | `{student_no, name, remark?, seat_id, request_id, expected_version}`。没有座位则 422 |
| PATCH | `/students/:id` | 改姓名、学号、备注。内部 ID 不变 |
| POST | `/students/:id/leave` | `{reason, note?, confirm_token, request_id, expected_version}`。`reason` 为 `transfer`、`suspension`、`mistake`、`other`。`other` 必须有 `note`。`confirm_token` 必须等于该生当前姓名，用来防止误触 |
| POST | `/students/:id/restore` | `{seat_id, request_id, expected_version}` |
| POST | `/students/:id/anonymize` | `{request_id}`。清空姓名、学号、备注，写外部账本 |
| POST | `/classes/:id/anonymize` | `{request_id}`。班内批量，逐人一条账本 |
| GET | `/classes/:id/import/template` | `kind=rows\|seatmap`，下载 xlsx |
| POST | `/classes/:id/import/preview` | `multipart` 字段 `file`。只接受 xlsx，最大 2MB。不落业务表 |
| POST | `/classes/:id/import/commit` | `{preview_token, expected_version, request_id}` |
| GET | `/classes/:id/export/roster` | 可再次导入的行表 xlsx |

预览问题对象：

```json
{
  "severity": "error",
  "sheet": "座位表",
  "cell": "C12",
  "row": 12,
  "code": "DUPLICATE_STUDENT_NO",
  "message": "学号 202401 在文件中重复",
  "student_no": "202401"
}
```

问题码包括：`DUPLICATE_STUDENT_NO`、`SEAT_NOT_FOUND`、`SEAT_TAKEN`、`OVER_CAPACITY`、`MATCHES_LEFT_STUDENT`、`MATCHES_ANONYMIZED`、`STUDENT_NO_SEAT`。`severity = error` 时 `committable = false`。同学号改姓名是 `kind = update` 且 `name_changed = true` 的变更，不计入错误。

## 布局与座次

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/layout` | 四列的 `direction`、`facing`，以及机位的 `seat_id`、`sort_in_column`、`seat_number`、占用班级数 |
| POST | `/layout/preview-change` | `{kind, payload}`。`kind` 为 `insert_slot`、`move_slot`、`delete_slot`、`change_column` |
| POST | `/layout/apply-change` | `{kind, payload, preview_hash, request_id}`。同一事务里改槽位并 `renumerate()` |
| GET | `/classes/:id/seats` | 座位、学生、当前分、标记、卫生徽章、`seat_version` |
| POST | `/classes/:id/seats/plan` | 不落库 |
| POST | `/classes/:id/seats/apply` | 落库 |
| GET | `/classes/:id/seats/history` | 不提供独立路由；使用 `GET /audit` |

`POST /classes/:id/seats/plan` 请求：

```json
{
  "source_student_ids": ["…"],
  "target_seat_ids": ["…"]
}
```

响应：

```json
{
  "ok": true,
  "assignments": [
    {
      "student_id": "…",
      "from_seat_id": "…",
      "to_seat_id": "…",
      "role": "selected"
    },
    {
      "student_id": "…",
      "from_seat_id": "…",
      "to_seat_id": "…",
      "role": "affected"
    }
  ],
  "issues": []
}
```

`role = affected` 是未选中、被轮换的学生。`ok = false` 时 `issues[].code` 为 `COUNT_MISMATCH`、`TARGET_NOT_FOUND`、`SOURCE_STUDENT_NOT_FOUND`。部分重叠不是错误码。`apply` 的请求体是 `{assignments: [{student_id, seat_id}], expected_version, request_id}`，`seat_id` 是目标座位。

`apply` 提交同一份 `assignments`，外加 `expected_version` 与 `request_id`。服务端按 §3.2 再算一遍，与提交的分配不一致则 422。

## 积分

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/classes/:id/templates` | 全局模板叠加班内覆盖后的有效模板 |
| POST | `/templates` | 全局新增。`polarity` 为 `-1` 或 `1`，`default_delta` 符号必须一致 |
| PATCH | `/templates/:id` | 可改名称和默认分值，不可改 `polarity` |
| POST | `/classes/:id/templates` | 班内私有模板 |
| POST | `/classes/:id/templates/:template_id/override` | `{name?, default_delta?, hidden?}` |
| DELETE | `/classes/:id/templates/:template_id/override` | 取消覆盖 |
| POST | `/points/batches` | 单人与批量共用 |
| GET | `/points/entries` | 筛选见下 |
| GET | `/points/students/:id` | 学生积分时间线 `{ student, balance, events }`。可选 `term_id` |
| POST | `/points/batches/:id/reverse` | 只冲销仍有效的明细 |
| POST | `/points/entries/:id/reverse` | 单条冲销 |
| GET | `/points/balances/:student_id` | `{ student_id, term_id, balance, last_change_seq }`。可选 `term_id` |

记账：

```json
{
  "request_id": "…",
  "term_id": "…",
  "class_id": "…",
  "student_ids": ["…"],
  "delta": 2,
  "template_id": null
}
```

`template_id` 为空表示无原因。有模板时，`delta` 的符号必须与模板方向一致，且该模板必须属于目标班级的可见模板。可选 `note` 最长 500 字，记在批次上，并出现在时间线、导出和回放事件里。

成功响应里每个条目包含 `entry_id`、`student_id`、`delta`、`balance_before`、`balance_after`、`seat_number_snapshot`、`status`。同一次重试返回这份原文。

`GET /points/entries` 查询参数：`term_id`、`class_id`、`date_from`、`date_to`、`student_id`、`direction=add|sub`、`reason_template_id`、`include_reversals`、`cursor`、`limit`。响应是 `{items, next_cursor}`。

## 普通标记

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/marks` | 未归档定义 |
| POST | `/marks` | `{name, icon, color, request_id}`。`color` 为 `#RRGGBB` |
| PATCH | `/marks/:id` | 改名称、图标、颜色，或归档 |
| POST | `/students/:id/marks/:mark_id` | 打标。重复打标返回 200 |
| DELETE | `/students/:id/marks/:mark_id` | 去掉该标记 |

卫生任职不通过这些接口改变。

## 卫生

路径里的轮次和抽选都属于当前教师账号下的班级。写操作都带 `request_id`。改变轮次可见状态的请求带 `expected_version`，对应 `duty_round.version`，与班级 `seat_version` 分开。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/classes/:id/duty` | 进行中的轮次、原管理员、待确认或已取消的抽选、下一轮新任、在任任期 |
| POST | `/classes/:id/duty/rounds` | 开始本轮 |
| GET | `/duty/rounds/:id` | 成员标志：`attended`、`no_push`、`eligible_for_backfill`、`counted_round`、`is_original` |
| POST | `/duty/rounds/:id/attendance` | `{duty_term_ids, request_id, expected_version}` |
| POST | `/duty/rounds/:id/no-push` | `{student_ids, request_id, expected_version}` |
| POST | `/duty/rounds/:id/absent-confirmed` | `{duty_term_id, request_id, expected_version}`。成功时响应包含 `before_required`、`after_required` |
| POST | `/duty/rounds/:id/candidates/freeze` | 无体也可，仍要 `request_id`。已冻结则 200 并返回原池 |
| POST | `/duty/rounds/:id/selections` | `{student_id, request_id, expected_version}` |
| GET | `/duty/selections/:id` | 原结果。`cancelled` 同样返回原明细 |
| POST | `/duty/selections/:id/cancel` | 关闭预览，明细保留 |
| POST | `/duty/selections/:id/reopen` | `cancelled → pending`，不重新抽 |
| POST | `/duty/selections/:id/confirm` | 幂等。第二次返回首次结果 |
| POST | `/duty/terms/:id/correct` | 见下 |
| POST | `/duty/rounds/:id/close` | 有 `pending` 或 `cancelled` 抽选时 409 |

抽选响应：

```json
{
  "selection_id": "…",
  "status": "pending",
  "new_student_id": "…",
  "outcome": "preview",
  "picked": [
    { "student_id": "…", "duty_term_id": "…", "position": 1 }
  ]
}
```

池空时 `outcome` 为 `direct_appoint`，`status` 为 `confirmed`，`picked` 为空数组，并带 `duty_term_id` 表示新任期。

作废时 `status` 为 `invalidated`，`resolution_note` 说明哪一次纠正导致结果失效。

人工纠正：

```json
{
  "action": "release",
  "note": "职务登记错误",
  "request_id": "…",
  "expected_version": 3
}
```

`action` 取 `release`、`restore`、`adjust_count`。`adjust_count` 另带 `completed_count` 或 `required_count` 的目标值。响应带 `before` 与 `after`。若因此作废了抽选，响应带 `invalidated_selection_id`。

## 榜单、回放、课堂工具

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/leaderboard` | `term_id`、`class_id` 或 `class_id=all`。并列 `1,1,3`。排序见设计文档 §3.3 |
| GET | `/replay/timeline` | `term_id`、`class_id`、`from`、`to`、`mode=cumulative\|net`。返回起点状态、事件数、检查点、时间轴密度 |
| GET | `/replay/frames` | 同上，加 `cursor`。每帧一个回放事件，含当时 Top10 |
| GET | `/replay/state-at` | `at`、`mode`、`term_id`、`class_id` |
| GET | `/classes/:id/rollcall` | 当前 `open` 轮次。没有时 `round` 为 `null` |
| GET | `/rollcall/rounds/:id` | 指定轮次，含已关闭 |
| POST | `/rollcall/rounds` | `{class_id, scope, exclude_student_ids, request_id}`。`scope.type` 为 `all` 或 `selected` |
| POST | `/rollcall/rounds/:id/draw` | `{count, request_id}`。本轮已抽过的人不再抽中 |
| POST | `/rollcall/rounds/:id/exclude` | `{student_ids, request_id}`。并入排除名单 |
| POST | `/rollcall/rounds/:id/close` | `{request_id}`。结束后才能开新的一轮。每班同时只有一个 `open` 轮次 |
| GET | `/countdown/:class_id` | `status`、`duration_sec`、`deadline_at`、`remaining_sec`。尚未开始时 `status=reset` 且 `duration_sec` 为 `null` |
| PUT | `/countdown/:class_id` | `{action, duration_sec?, request_id}`。`action` 为 `start`、`pause`、`resume`、`reset` |
| GET | `/events` | SSE。查询参数 `since`。也认 `Last-Event-ID` |

倒计时只同步动作和 `deadline_at`。客户端用截止时间本地倒计时，服务端不每秒推送。`pause` 时写 `remaining_sec` 并清空有效截止时间。

点名池是当时在班、在范围内、不在排除名单、且不在本轮 `picked_ids` 里的学生。

全屏展示没有单独接口，使用座位、榜单、点名的读接口。页面自己隐藏备注和管理按钮。

## 审计、导出、备份

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/audit` | `entity`、`entity_id`、`date_from`、`date_to`、`action`、`cursor`、`limit` |
| GET | `/export/points` | 查询参数与 `/points/entries` 相同，响应为 xlsx |
| GET | `/export/leaderboard` | 查询参数与 `/leaderboard` 相同 |
| GET | `/backup/records` | 成功时间、失败原因、文件大小、当时磁盘剩余 |
| GET | `/backup/download/:backup_id` | 下载成功的 dump。需要登录 |
| GET | `/openapi.json` | 不提供 |

导出与对应列表使用同一套筛选函数，保证行集合一致。

## SSE

`Content-Type: text/event-stream`。事件 `id` 是 `event_seq`。

| kind | 何时 | 客户端 |
|---|---|---|
| `seat_changed` | 换座或布局影响了某班座次 | 可按版本重拉该班座位 |
| `points_appended` | 记账或撤销 | 可按事件合并余额 |
| `roster_changed` | 导入、离班、恢复、匿名化 | 重拉名单 |
| `layout_changed` | 全局布局 | 重拉布局。载荷含编号差异 |
| `term_switched` | 切学期 | 全量刷新 |
| `marks_changed` | 标记变化 | 更新对应卡片 |
| `duty_round_changed` | 卫生写操作 | 重拉卫生状态 |
| `countdown_changed` | 倒计时动作 | 用新的 `deadline_at` |
| `rollcall_changed` | 抽人、排除、关轮 | 重拉当前轮次 |
| `resync` | `since` 已早于服务端保留的序号 | 全量重拉 |

建连时先发一条 `snapshot`，数据为 `{ "current_event_seq": number }`，便于客户端对齐。

## 核心响应体

支持分页的列表返回 `{ "items": [], "next_cursor": null }`；班级、学期、标记等列表直接返回数组。写操作按各接口返回资源或结果对象，只有涉及版本的结果才带新版本号。下面的样例以当前实现为准。

### 登录与当前用户

`POST /auth/login` 与 `GET /auth/me`：

```json
{
  "teacher_id": "…",
  "username": "teacher",
  "token_version": 1
}
```

登录同时设置 Cookie：`HttpOnly`、`SameSite=Lax`、`Path=/`。试运行可以不带 `Secure`；启用 HTTPS 后必须带 `Secure`。响应体不包含会话令牌。

### 班级、学期、学生

```json
{
  "class_id": "…",
  "name": "七年级1班",
  "archived_at": null,
  "seat_version": 3,
  "active_student_count": 54,
  "current_term_id": "…",
  "created_at": "2026-09-23T10:00:00+08:00"
}
```

```json
{
  "term_id": "…",
  "name": "2026秋季",
  "status": "open",
  "is_current": true,
  "started_at": "2026-09-01T00:00:00+08:00",
  "closed_at": null
}
```

`GET /terms/:id/summary`：

```json
{
  "term": { "term_id": "…", "name": "2026秋季", "status": "closed", "is_current": false, "started_at": "2026-09-01T00:00:00Z", "closed_at": "2026-09-23T00:00:00Z" },
  "total_batches": 120,
  "total_entries": 800,
  "total_reversals": 20,
  "students_scored": 54
}
```

```json
{
  "student_id": "…",
  "class_id": "…",
  "student_no": "202401",
  "name": "张小明",
  "remark": null,
  "status": "active",
  "left_reason": null,
  "left_note": null,
  "left_at": null,
  "anon_code": null,
  "anon_at": null,
  "seat": { "seat_id": "…", "seat_number": 23, "column_code": "2" },
  "marks": []
}
```

匿名化之后 `name` 和 `student_no` 为空字符串，`status` 为 `anonymized`，`anon_code` 有值。离班后 `seat` 为 `null`。

### 导入预览

```json
{
  "preview_token": "…",
  "template_kind": "rows",
  "committable": false,
  "issues": [],
  "changes": [
    {
      "kind": "update",
      "student_no": "202401",
      "name": "张小明",
      "student_id": "…",
      "from_seat_number": 23,
      "to_seat_number": 24,
      "name_changed": true
    }
  ],
  "summary": {
    "create": 0,
    "update": 1,
    "keep": 53,
    "seat_changes": 1,
    "errors": 1,
    "warnings": 0
  },
  "blockers": [{ "code": "STUDENT_NO_SEAT", "message": "有在班学生没有座位" }]
}
```

导入预览的 `changes.kind` 只有 `create`、`update`、`keep`。换座人数记在 `summary.seat_changes`。提交成功返回 `{ "seat_version": 4, "applied": { "create": 1, "update": 2 } }`。

### 布局与座次

`GET /layout` 的列对象含 `column_id`、`code`、`display_order`、`direction`、`facing`、`label`、`slot_count`。机位对象含 `seat_id`、`column_id`、`column_code`、`sort_in_column`、`seat_number`、`label`、`occupant_class_count`。另有 `total_slots` 和 `last_renumber_diff`。

`POST /layout/preview-change`：

```json
{
  "kind": "insert_slot",
  "affected_classes": [
    { "class_id": "…", "name": "七年级1班", "students_moved": 54, "seat_assignments_removed": 0 }
  ],
  "renumber_diff": [{ "seat_id": "…", "old": 41, "new": 42 }],
  "blockers": [],
  "preview_hash": "…"
}
```

删除被占用机位时 HTTP 409，`code` 为 `SEAT_OCCUPIED`，`details.classes` 为 `[{class_id, name}]`。预览阶段也可以把同一事实放进 `blockers` 且不给可提交的 `preview_hash`。

`GET /classes/:id/seats`：

```json
{
  "class_id": "…",
  "seat_version": 3,
  "term_id": "…",
  "columns": [],
  "cards": [
    {
      "seat_id": "…",
      "seat_number": 1,
      "column_code": "1",
      "sort_in_column": 1,
      "facing": "right",
      "student": {
        "student_id": "…",
        "name": "张小明",
        "student_no": "202401",
        "balance": 10,
        "marks": [],
        "duty": null
      }
    }
  ]
}
```

空座位的 `student` 为 `null`。`student.duty` 是已经开始计次的在任任期（`status = active` 且 `started_round_id` 已写入）。下一轮新任仍只出现在 `GET /classes/:id/duty` 的 `next_appointees`，座位卡不提前显示。全屏展示使用同一响应，页面不渲染 `remark`。学生详情里的备注只在管理接口 `GET /classes/:id/students` 返回。

### 积分

记账与撤销的成功体：

```json
{
  "batch_id": "…",
  "term_id": "…",
  "class_id": "…",
  "kind": "score",
  "reverses_batch_id": null,
  "delta_value": 2,
  "member_count": 3,
  "partial_reversed": false,
  "occurred_at": "2026-09-23T14:32:07.412+08:00",
  "entries": [
    {
      "entry_id": "…",
      "batch_id": "…",
      "student_id": "…",
      "student_name": "张小明",
      "delta": 2,
      "balance_before": 8,
      "balance_after": 10,
      "seat_id": "…",
      "seat_number_snapshot": 23,
      "reason_snapshot": { "name": "回答问题", "polarity": 1, "source": "global" },
      "status": "effective",
      "reverses_entry_id": null,
      "reversed_by_entry_id": null,
      "occurred_at": "2026-09-23T14:32:07.412+08:00",
      "seq": 1001
    }
  ],
  "undo": { "batch_reverse_available": true, "already_reversed_count": 0 }
}
```

无原因时 `reason_snapshot` 为 `null`。整批撤销的 `kind` 为 `reversal`。部分撤销后再整批撤销时，响应里只有当时仍为 `effective` 的那些反向明细，`already_reversed_count` 是先前已冲销的条数。

有效模板：

```json
{
  "template_id": "…",
  "effective_name": "回答问题",
  "effective_delta": 2,
  "hidden": false,
  "polarity": 1,
  "added_in_class": false,
  "has_override": false,
  "sort_order": 0
}
```

`GET /points/students/:id` 返回 `{ student, balance, events }`。余额数字用 `GET /points/balances/:student_id`。

### 榜单与回放

`GET /leaderboard` 的每一行：

```json
{
  "rank": 1,
  "student_id": "…",
  "name": "张小明",
  "student_no": "202401",
  "anon_code": null,
  "class_id": "…",
  "class_name": "七年级1班",
  "balance": 10,
  "last_change_seq": 1001
}
```

并列时两行的 `rank` 同为 1，下一名为 3。离班和已匿名化学生不在当前榜。匿名化学生若仍在历史回放中，`name` 为空，显示 `anon_code`。

`GET /replay/timeline`：

```json
{
  "mode": "cumulative",
  "from": "2026-09-16T00:00:00+08:00",
  "to": "2026-09-23T23:59:59+08:00",
  "base_state": [{ "student_id": "…", "class_id": "…", "balance": 8, "present": true }],
  "frame_count": 40,
  "checkpoints": [{ "upto_event_seq": 800, "created_at": "…" }],
  "density": [{ "at": "2026-09-20T10:00:00+08:00", "frames": 5 }]
}
```

`cumulative` 的 `base_state.balance` 是区间开始前的分数。`net` 模式下这些起点余额视为 0，响应仍给出区间前分数供对照，字段名为 `balance_before_range`，播放用的起点另由 `base_balance` 给出且为 0。

`GET /replay/frames` 的一项：

```json
{
  "event_seq": 1001,
  "occurred_at": "2026-09-23T14:32:07.412+08:00",
  "kind": "points_appended",
  "top10": []
}
```

`top10` 元素与榜单行相同，但是该帧当时的名次。`GET /replay/state-at` 返回 `{ "at", "mode", "ranking": [] }`，`ranking` 同样使用榜单行。

### 卫生

`GET /classes/:id/duty`：

```json
{
  "line_id": "…",
  "round": {
    "round_id": "…",
    "seq_no": 4,
    "phase": "substituting",
    "version": 2,
    "frozen_at": "2026-09-23T15:00:00+08:00",
    "members": [
      {
        "student_id": "…",
        "duty_term_id": "…",
        "is_original": true,
        "attended": true,
        "no_push": false,
        "eligible_for_backfill": true,
        "counted_round": true,
        "completed_count": 1,
        "required_count": 3,
        "term_status": "active"
      }
    ]
  },
  "open_selection": null,
  "next_appointees": [],
  "active_terms": []
}
```

`phase` 为 `marking`、`substituting` 或没有进行中轮次时 `round` 为 `null`。`open_selection` 在 `pending` 或 `cancelled` 时只返回 `{ selection_id, status, new_student_id }`；完整抽选明细需请求 `/duty/selections/:id`。`next_appointees` 是本轮确认过、`started_round_id` 仍为空的任期。

抽选对象见上文卫生一节。`POST /duty/rounds/:id/absent-confirmed` 成功时：

```json
{
  "duty_term_id": "…",
  "before_required": 3,
  "after_required": 4,
  "version": 3
}
```

### 点名与倒计时

`GET /classes/:id/rollcall` 返回 `{ "round": null }` 或 `{ "round": <下列轮次对象> }`；`GET /rollcall/rounds/:id` 与点名写接口直接返回轮次对象。

```json
{
  "rollcall_id": "…",
  "class_id": "…",
  "status": "open",
  "scope": { "type": "all", "student_ids": [] },
  "exclude_student_ids": ["…"],
  "picked": [{ "student_id": "…", "name": "张小明", "seat_number": 23 }]
}
```

```json
{
  "class_id": "…",
  "status": "running",
  "duration_sec": 180,
  "deadline_at": "2026-09-23T15:03:00+08:00",
  "remaining_sec": null,
  "updated_at": "2026-09-23T15:00:00+08:00"
}
```

`paused` 时 `deadline_at` 为 `null`，`remaining_sec` 为暂停瞬间的剩余秒数。`finished` 由客户端在到达 `deadline_at` 后显示；服务端在下一次读取或 `pause`/`reset` 时把超时的 `running` 记为 `finished`。

### 审计、备份与 SSE 帧

```json
{
  "audit_id": 100,
  "actor": "…",
  "entity": "student",
  "entity_id": "…",
  "action": "leave",
  "before": {},
  "after": {},
  "request_id": "…",
  "created_at": "2026-09-23T15:00:00+08:00"
}
```

审计记录不包含密码、会话令牌、学生被清空前的姓名和学号。

备份记录含 `backup_id`、`file_name`、`size_bytes`、`disk_free_bytes`、`status`（`running`、`success`、`failed`）、`error`、`started_at`、`finished_at`。

SSE 的 `data` 为：

```json
{
  "event_seq": 1001,
  "kind": "points_appended",
  "class_id": "…",
  "payload": {},
  "occurred_at": "2026-09-23T14:32:07.412+08:00"
}
```

`snapshot` 的 `data` 直接是 `{ "current_event_seq": number }`，不包 `payload`。`resync` 的 `payload` 为 `{ "reason": "seq_expired" }`。

## 页面是否调用

2026-09-26 对照 `web/src`。下面这些路由已经注册，页面没有调用。教师能在页面上完成的步骤见 `docs/使用教程.md`。

| 范围 | 已注册、页面未调用 |
|---|---|
| 匿名化 | `POST /students/:id/anonymize`、`POST /classes/:id/anonymize`。名单页会调用学生的新增、修改、离班、恢复，以及导入模板、预览和提交 |
| 标记 | `POST /marks`、`PATCH /marks/:id`、`POST /students/:id/marks/:mark_id`、`DELETE /students/:id/marks/:mark_id`。`GET /marks` 会加载，有标记时座位卡会显示 |
| 原因模板 | `POST /templates`、`PATCH /templates/:id`、`POST /classes/:id/templates`、`POST /classes/:id/templates/:template_id/override`、`DELETE /classes/:id/templates/:template_id/override`。`GET /classes/:id/templates` 只用于记分栏展示 |
| 积分查询 | `GET /points/students/:id`、`GET /points/balances/:student_id`。记分不提交批次 `note` |
| 卫生与点名 | `GET /duty/rounds/:id`、`GET /rollcall/rounds/:id`。当前轮次分别来自 `GET /classes/:id/duty` 和 `GET /classes/:id/rollcall` |
| 导出、审计、备份 | `GET /classes/:id/export/roster`、`GET /export/points`、`GET /audit`、`GET /backup/records`、`GET /backup/download/:backup_id`。`GET /export/leaderboard` 由榜单页的「导出」链接打开 |

页面会调用的写操作：登录、退出、退出其他设备、修改密码、建立学期、激活学期、建班、改名、归档和恢复、新增学生、修改学生、离班、恢复、导入预览与提交、布局预览与提交、换座预览与提交、记分、整批撤销、单条撤销、卫生轮次的开始到结束（含抽选确认与纠正）、点名的开始、抽取、排除和结束、倒计时的 `PUT`。读操作还包括班级（管理页带 `include_archived=true`）、学期、学期汇总、学生列表、导入模板下载、机房布局、座位、模板、标记、积分时间线、榜单、回放三支、当前点名、倒计时、`GET /events` 和 `/healthz`。
