/**
 * 对已部署的 HTTPS 服务做验收。不写入真实学生。
 *
 * 用法（先完成 docker compose up、迁移和 create-teacher）：
 *   ACCEPT_PASSWORD='…' POSTGRES_PASSWORD='…' npx tsx scripts/accept-live.ts
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';

const base = (process.env.ACCEPT_BASE_URL ?? 'https://127.0.0.1').replace(/\/$/, '');
const username = process.env.ACCEPT_USER ?? 'teacher';
const password = process.env.ACCEPT_PASSWORD ?? '';
const postgresPassword = process.env.POSTGRES_PASSWORD ?? '';

if (password.length < 12) throw new Error('请设置 ACCEPT_PASSWORD（至少 12 位）');
if (!postgresPassword) throw new Error('请设置 POSTGRES_PASSWORD');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const cookieJar = new Map<string, string>();
const checks: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) throw new Error(`${name} 未通过${detail ? `：${detail}` : ''}`);
  checks.push(name);
  console.log(`✓ ${name}`);
}

function cookieHeader(): string {
  return [...cookieJar.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
}

function storeCookies(response: Response): void {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const lines = headers.getSetCookie?.() ?? [];
  for (const line of lines) {
    const pair = line.split(';', 1)[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq > 0) cookieJar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}

async function request(method: string, path: string, body?: unknown, form?: FormData): Promise<Response> {
  const headers: Record<string, string> = {};
  const cookie = cookieHeader();
  if (cookie) headers.cookie = cookie;
  let payload: string | FormData | undefined;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${base}${path}`, { method, headers, body: payload, redirect: 'manual' });
  storeCookies(response);
  return response;
}

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await request(method, path, body);
  const text = await response.text();
  const parsed = text ? JSON.parse(text) as T & { error?: { code?: string; message?: string } } : {};
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status} ${JSON.stringify(parsed)}`);
  }
  return parsed as T;
}

async function expectStatus(method: string, path: string, status: number, body?: unknown): Promise<{ code?: string }> {
  const response = await request(method, path, body);
  const text = await response.text();
  const parsed = text ? JSON.parse(text) as { error?: { code?: string } } : {};
  if (response.status !== status) {
    throw new Error(`${method} ${path} 期望 ${status}，实际 ${response.status} ${text}`);
  }
  return parsed.error ?? {};
}

function rid(): string {
  return randomUUID();
}

function compose(args: string[], allowFailure = false): string {
  try {
    return execFileSync('docker', ['compose', ...args], {
      encoding: 'utf8',
      env: process.env,
    });
  } catch (err) {
    if (allowFailure) return '';
    const error = err as { stdout?: string; stderr?: string; message?: string };
    throw new Error(error.stderr || error.stdout || error.message || 'docker compose 失败');
  }
}

async function workbook(rows: Array<[string, string, number | '', string]>): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('名单');
  sheet.addRow(['学号', '姓名', '座位号', '备注']);
  for (const row of rows) sheet.addRow(row);
  const out = await book.xlsx.writeBuffer();
  return Buffer.from(out);
}

async function main(): Promise<void> {
  const http = await fetch('http://127.0.0.1/', { redirect: 'manual' });
  check('80 跳转到 HTTPS', http.status === 301 || http.status === 308, String(http.status));

  const health = await json<{ ok: boolean }>('GET', '/healthz');
  check('健康检查', health.ok === true);

  const login = await request('POST', '/api/v1/auth/login', { username, password });
  const loginText = await login.text();
  check('登录', login.ok, loginText);
  const setCookie = (login.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.().join('; ') ?? '';
  check('登录 Cookie 带 Secure', /secure/i.test(setCookie), setCookie);

  const term = await json<{ term_id: string }>('POST', '/api/v1/terms', { name: '验收学期', request_id: rid() });
  await json('POST', `/api/v1/terms/${term.term_id}/activate`, {
    request_id: rid(),
    expected_current_term_id: null,
  });
  const klass = await json<{ class_id: string; seat_version: number }>('POST', '/api/v1/classes', {
    name: '验收一班',
    request_id: rid(),
  });
  const seatsBefore = await json<{ cards: Array<{ seat_id: string; seat_number: number | null }> }>(
    'GET',
    `/api/v1/classes/${klass.class_id}/seats`,
  );
  const numbers = seatsBefore.cards.map((card) => card.seat_number).filter((n): n is number => n != null).sort((a, b) => a - b);
  check('初始 54 座编号为 1–54', numbers.length === 54 && numbers[0] === 1 && numbers[53] === 54, String(numbers.length));

  const rows: Array<[string, string, number, string]> = numbers.map((n) => [`S${String(n).padStart(2, '0')}`, `学生${n}`, n, '']);
  const good = await workbook(rows);
  const goodForm = new FormData();
  goodForm.append('file', new Blob([good]), 'roster.xlsx');
  const previewRes = await request('POST', `/api/v1/classes/${klass.class_id}/import/preview`, undefined, goodForm);
  const preview = await previewRes.json() as {
    preview_token: string;
    committable: boolean;
    summary: { create: number; errors: number };
  };
  check('54 人导入预览可提交', previewRes.ok && preview.committable && preview.summary.create === 54 && preview.summary.errors === 0);
  const committed = await json<{ applied: { create: number } }>('POST', `/api/v1/classes/${klass.class_id}/import/commit`, {
    preview_token: preview.preview_token,
    expected_version: klass.seat_version,
    request_id: rid(),
  });
  check('54 人导入提交', committed.applied.create === 54);

  const students = await json<Array<{ student_id: string; student_no: string; seat: { seat_id: string; seat_number: number } | null }>>(
    'GET',
    `/api/v1/classes/${klass.class_id}/students?status=active`,
  );
  const seated = new Set(students.map((student) => student.seat?.seat_id).filter(Boolean));
  check('在班学生各占一座', students.length === 54 && seated.size === 54);

  const clash = await workbook([
    ['S90', '冲突甲', 1, ''],
    ['S91', '冲突乙', 1, ''],
  ]);
  const clashForm = new FormData();
  clashForm.append('file', new Blob([clash]), 'clash.xlsx');
  const clashRes = await request('POST', `/api/v1/classes/${klass.class_id}/import/preview`, undefined, clashForm);
  const clashBody = await clashRes.json() as { committable?: boolean; summary?: { errors: number } };
  const afterClash = await json<unknown[]>('GET', `/api/v1/classes/${klass.class_id}/students?status=active`);
  check('冲突导入不写入', clashRes.ok && clashBody.committable === false && (clashBody.summary?.errors ?? 0) > 0 && afterClash.length === 54);

  const occupied = students[0]!;
  const impact = await json<{ blockers: Array<{ code: string }> }>('POST', '/api/v1/layout/preview-change', {
    kind: 'delete_slot',
    payload: { seat_id: occupied.seat!.seat_id },
  });
  check('删除占用机位被拒绝', impact.blockers.some((item) => item.code === 'SEAT_OCCUPIED'));

  const [a, b, c] = students;
  if (!a || !b || !c) throw new Error('学生不足');
  const scoreId = rid();
  const scored = await json<{ batch_id: string; entries: Array<{ entry_id: string; student_id: string; balance_after: number }> }>(
    'POST',
    '/api/v1/points/batches',
    {
      request_id: scoreId,
      class_id: klass.class_id,
      term_id: term.term_id,
      student_ids: [a.student_id, b.student_id],
      delta: 5,
      template_id: null,
      note: '验收批次',
    },
  );
  const again = await json<{ batch_id: string }>('POST', '/api/v1/points/batches', {
    request_id: scoreId,
    class_id: klass.class_id,
    term_id: term.term_id,
    student_ids: [a.student_id, b.student_id],
    delta: 5,
    template_id: null,
    note: '验收批次',
  });
  check('重复 request_id 不重复记分', again.batch_id === scored.batch_id);
  const mismatch = await expectStatus('POST', '/api/v1/points/batches', 409, {
    request_id: scoreId,
    class_id: klass.class_id,
    term_id: term.term_id,
    student_ids: [a.student_id],
    delta: 1,
    template_id: null,
  });
  check('同键不同体返回 IDEMPOTENCY_MISMATCH', mismatch.code === 'IDEMPOTENCY_MISMATCH', mismatch.code);

  const negative = await json<{ batch_id: string; entries: Array<{ entry_id: string }> }>('POST', '/api/v1/points/batches', {
    request_id: rid(),
    class_id: klass.class_id,
    term_id: term.term_id,
    student_ids: [c.student_id],
    delta: -2,
    template_id: null,
    note: null,
  });
  check('无原因负分可以入账', negative.entries.length === 1);

  const board = await json<{ items: Array<{ student_id: string; balance: number; rank: number }> }>(
    'GET',
    `/api/v1/leaderboard?term_id=${term.term_id}&class_id=${klass.class_id}`,
  );
  const rankA = board.items.find((item) => item.student_id === a.student_id);
  const rankB = board.items.find((item) => item.student_id === b.student_id);
  const zeroRank = board.items.find((item) => item.balance === 0);
  check('并列名次为 1, 1, 3', rankA?.rank === 1 && rankB?.rank === 1 && zeroRank?.rank === 3, JSON.stringify({ rankA, rankB, zeroRank }));

  const timeline = await json<{ items: Array<{ batch_id: string; note: string | null }> }>(
    'GET',
    `/api/v1/points/entries?class_id=${klass.class_id}&term_id=${term.term_id}`,
  );
  check('时间线保留批次备注', timeline.items.some((item) => item.batch_id === scored.batch_id && item.note === '验收批次'));

  const now = new Date();
  const from = new Date(now.getTime() - 60_000).toISOString();
  const to = new Date(now.getTime() + 60_000).toISOString();
  const replay = await json<{ frame_count: number }>(
    'GET',
    `/api/v1/replay/timeline?term_id=${term.term_id}&class_id=${klass.class_id}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&mode=cumulative`,
  );
  check('回放时间轴包含记分帧', replay.frame_count >= 2, String(replay.frame_count));

  const entry = scored.entries[0];
  if (!entry) throw new Error('缺少明细');
  await json('POST', `/api/v1/points/entries/${entry.entry_id}/reverse`, { request_id: rid() });
  await json('POST', `/api/v1/points/batches/${scored.batch_id}/reverse`, { request_id: rid() });
  const afterUndo = await json<{ items: Array<{ student_id: string; balance: number }> }>(
    'GET',
    `/api/v1/leaderboard?term_id=${term.term_id}&class_id=${klass.class_id}`,
  );
  const undone = afterUndo.items.find((item) => item.student_id === a.student_id || item.student_id === b.student_id);
  check('部分撤销后整批撤销冲销剩余明细', afterUndo.items.filter((item) => item.student_id === a.student_id || item.student_id === b.student_id).every((item) => item.balance === 0), JSON.stringify(undone));

  const currentSeats = await json<{ seat_version: number; cards: Array<{ seat_id: string; student: { student_id: string } | null }> }>(
    'GET',
    `/api/v1/classes/${klass.class_id}/seats`,
  );
  const plan = await json<{ ok: boolean; assignments: Array<{ student_id: string; to_seat_id: string; role: string }> }>(
    'POST',
    `/api/v1/classes/${klass.class_id}/seats/plan`,
    { source_student_ids: [a.student_id], target_seat_ids: [b.seat!.seat_id] },
  );
  const selected = plan.assignments.filter((item) => item.role === 'selected');
  check('重叠换座可以求值', plan.ok && plan.assignments.some((item) => item.role === 'affected') && selected.length === 1);
  const stale = await expectStatus('POST', `/api/v1/classes/${klass.class_id}/seats/apply`, 409, {
    assignments: selected.map((item) => ({ student_id: item.student_id, seat_id: item.to_seat_id })),
    expected_version: currentSeats.seat_version + 9,
    request_id: rid(),
  });
  check('过期座次版本返回 VERSION_CONFLICT', stale.code === 'VERSION_CONFLICT', stale.code);
  await json('POST', `/api/v1/classes/${klass.class_id}/seats/apply`, {
    assignments: selected.map((item) => ({ student_id: item.student_id, seat_id: item.to_seat_id })),
    expected_version: currentSeats.seat_version,
    request_id: rid(),
  });
  check('换座提交成功', true);

  async function dutyState(): Promise<{ round_id: string; version: number; members: Array<{ student_id: string; duty_term_id: string; is_original: boolean }> }> {
    const state = await json<{
      round: { round_id: string; version: number; members: Array<{ student_id: string; duty_term_id: string; is_original: boolean }> } | null;
    }>('GET', `/api/v1/classes/${klass.class_id}/duty`);
    if (!state.round) throw new Error('没有进行中的卫生轮次');
    return state.round;
  }

  const round1 = await json<{ round_id: string; version: number }>('POST', `/api/v1/classes/${klass.class_id}/duty/rounds`, {
    request_id: rid(),
    expected_version: 0,
  });
  const frozen1 = await json<{ version: number; candidates: unknown[] }>('POST', `/api/v1/duty/rounds/${round1.round_id}/candidates/freeze`, {
    request_id: rid(),
    expected_version: round1.version,
  });
  const appointed = await json<{ outcome: string; duty_term_id: string }>('POST', `/api/v1/duty/rounds/${round1.round_id}/selections`, {
    student_id: a.student_id,
    request_id: rid(),
    expected_version: frozen1.version,
  });
  check('空池直接任命', appointed.outcome === 'direct_appoint');
  const round1Now = await dutyState();
  await json('POST', `/api/v1/duty/rounds/${round1.round_id}/close`, {
    request_id: rid(),
    expected_version: round1Now.version,
  });

  const round2 = await json<{ round_id: string; version: number }>('POST', `/api/v1/classes/${klass.class_id}/duty/rounds`, {
    request_id: rid(),
    expected_version: 0,
  });
  const seatedDuty = await json<{ cards: Array<{ student: { student_id: string; duty: { duty_term_id: string; status: string } | null } | null }> }>(
    'GET',
    `/api/v1/classes/${klass.class_id}/seats`,
  );
  const badgeA = seatedDuty.cards.find((card) => card.student?.student_id === a.student_id)?.student?.duty;
  check('座位卡带在任卫生任期', badgeA?.duty_term_id === appointed.duty_term_id && badgeA.status === 'active');

  const absent = await json<{ before_required: number; after_required: number; version: number }>(
    'POST',
    `/api/v1/duty/rounds/${round2.round_id}/absent-confirmed`,
    { duty_term_id: appointed.duty_term_id, request_id: rid(), expected_version: round2.version },
  );
  check('未值日把 3 次调整为 4 次', absent.before_required === 3 && absent.after_required === 4);

  const round3prep = await dutyState();
  await json('POST', `/api/v1/duty/rounds/${round2.round_id}/close`, {
    request_id: rid(),
    expected_version: round3prep.version,
  });
  const round3 = await json<{ round_id: string; version: number; member_count: number }>('POST', `/api/v1/classes/${klass.class_id}/duty/rounds`, {
    request_id: rid(),
    expected_version: 0,
  });
  const members3 = await dutyState();
  const memberA = members3.members.find((member) => member.student_id === a.student_id);
  if (!memberA) throw new Error('新轮次没有原管理员');
  const attended = await json<{ version: number }>('POST', `/api/v1/duty/rounds/${round3.round_id}/attendance`, {
    duty_term_ids: [memberA.duty_term_id],
    request_id: rid(),
    expected_version: round3.version,
  });
  const frozen3 = await json<{ candidates: Array<{ student_id: string }>; version: number }>(
    'POST',
    `/api/v1/duty/rounds/${round3.round_id}/candidates/freeze`,
    { request_id: rid(), expected_version: attended.version },
  );
  check('已值日的原管理员进入候选', frozen3.candidates.some((item) => item.student_id === a.student_id));
  const selection = await json<{ selection_id: string; status: string; picked: Array<{ student_id: string }> }>(
    'POST',
    `/api/v1/duty/rounds/${round3.round_id}/selections`,
    { student_id: b.student_id, request_id: rid(), expected_version: frozen3.version },
  );
  check('有候选时抽选待确认', selection.status === 'pending' && selection.picked.length > 0);
  const cancelled = await json<{ status: string; picked: unknown[] }>('POST', `/api/v1/duty/selections/${selection.selection_id}/cancel`, {
    request_id: rid(),
    expected_version: (await dutyState()).version,
  });
  check('取消抽选保留原结果', cancelled.status === 'cancelled' && cancelled.picked.length === selection.picked.length);
  await json('POST', `/api/v1/duty/selections/${selection.selection_id}/reopen`, {
    request_id: rid(),
    expected_version: (await dutyState()).version,
  });
  const confirmed = await json<{ status: string }>('POST', `/api/v1/duty/selections/${selection.selection_id}/confirm`, {
    request_id: rid(),
    expected_version: (await dutyState()).version,
  });
  const confirmedAgain = await json<{ status: string }>('POST', `/api/v1/duty/selections/${selection.selection_id}/confirm`, {
    request_id: rid(),
    expected_version: (await dutyState()).version,
  });
  check('确认抽选幂等', confirmed.status === 'confirmed' && confirmedAgain.status === 'confirmed');
  const afterConfirm = await json<{
    next_appointees: Array<{ student_id: string }>;
    round: { members: Array<{ student_id: string; is_original: boolean }> } | null;
  }>('GET', `/api/v1/classes/${klass.class_id}/duty`);
  check('新任者不进本轮原管理员', afterConfirm.next_appointees.some((item) => item.student_id === b.student_id)
    && !afterConfirm.round?.members.some((member) => member.student_id === b.student_id && member.is_original));

  const nextTerm = await json<{ term_id: string }>('POST', '/api/v1/terms', { name: '验收学期二', request_id: rid() });
  await json('POST', `/api/v1/terms/${nextTerm.term_id}/activate`, {
    request_id: rid(),
    expected_current_term_id: term.term_id,
  });
  const zero = await json<{ balance: number }>('GET', `/api/v1/points/balances/${c.student_id}?term_id=${nextTerm.term_id}`);
  check('切学期后新学期积分为 0', zero.balance === 0);
  const keptSeat = await json<Array<{ student_id: string; seat: { seat_id: string } | null }>>(
    'GET',
    `/api/v1/classes/${klass.class_id}/students?status=active`,
  );
  check('切学期后座次还在', keptSeat.find((student) => student.student_id === c.student_id)?.seat != null);
  const readonly = await expectStatus('POST', '/api/v1/points/batches', 422, {
    request_id: rid(),
    class_id: klass.class_id,
    term_id: term.term_id,
    student_ids: [c.student_id],
    delta: 1,
    template_id: null,
  });
  check('旧学期记账返回 TERM_READONLY', readonly.code === 'TERM_READONLY', readonly.code);

  const roll = await json<{ rollcall_id: string }>('POST', '/api/v1/rollcall/rounds', {
    class_id: klass.class_id,
    scope: { type: 'all', student_ids: [] },
    exclude_student_ids: [],
    request_id: rid(),
  });
  const drawn = await json<{ picked: unknown[] }>('POST', `/api/v1/rollcall/rounds/${roll.rollcall_id}/draw`, {
    count: 1,
    request_id: rid(),
  });
  check('点名抽出一人', drawn.picked.length === 1);
  const clock = await json<{ status: string }>('PUT', `/api/v1/countdown/${klass.class_id}`, {
    action: 'start',
    duration_sec: 30,
    request_id: rid(),
  });
  check('倒计时开始', clock.status === 'running' || clock.status === 'started');

  const roster = await request('GET', `/api/v1/classes/${klass.class_id}/export/roster`);
  check('花名册导出', roster.ok && (roster.headers.get('content-type') ?? '').includes('spreadsheet'));
  const pointsFile = await request('GET', `/api/v1/export/points?term_id=${term.term_id}&class_id=${klass.class_id}`);
  check('积分明细导出', pointsFile.ok);

  const anonTarget = students[53];
  if (!anonTarget) throw new Error('缺少可匿名学生');
  const anonymized = await json<{ student: { status: string; anon_code: string | null } }>(
    'POST',
    `/api/v1/students/${anonTarget.student_id}/anonymize`,
    { request_id: rid() },
  );
  check('学生匿名化', anonymized.student.status === 'anonymized' && Boolean(anonymized.student.anon_code));

  const events = await fetch(`${base}/api/v1/events`, {
    headers: { cookie: cookieHeader() },
    signal: AbortSignal.timeout(8000),
  });
  check('SSE 通道', events.status === 200 && (events.headers.get('content-type') ?? '').includes('text/event-stream'));
  await events.body?.cancel().catch(() => undefined);

  compose(['exec', '-T', 'backup', 'node', 'dist/cli/index.js', 'backup']);
  const backups = await json<Array<{ backup_id: string; status: string; file_name: string }>>('GET', '/api/v1/backup/records');
  const dump = backups.find((item) => item.status === 'success');
  if (!dump) throw new Error('没有成功的备份记录');
  const download = await request('GET', `/api/v1/backup/download/${dump.backup_id}`);
  const size = Number(download.headers.get('content-length') ?? '0');
  check('可以下载 dump', download.ok && size > 0, String(size));
  await download.body?.cancel();

  compose(['exec', '-T', 'postgres', 'psql', '-U', 'classroom', '-d', 'classroom_manager', '-c', 'DROP DATABASE IF EXISTS classroom_restore'], true);
  compose(['exec', '-T', 'postgres', 'psql', '-U', 'classroom', '-d', 'classroom_manager', '-c', 'CREATE DATABASE classroom_restore']);
  const target = `postgresql://classroom:${postgresPassword}@postgres:5432/classroom_restore`;
  execFileSync('docker', [
    'compose', 'exec', '-T', 'backup',
    'node', 'dist/cli/index.js', 'restore',
    '--backup', dump.backup_id,
    '--target', target,
    '--confirm',
  ], { encoding: 'utf8', env: process.env });
  const restored = compose([
    'exec', '-T', 'postgres', 'psql', '-U', 'classroom', '-d', 'classroom_restore', '-tAc',
    'SELECT COUNT(*) FROM student',
  ]).trim();
  const restoredAnon = compose([
    'exec', '-T', 'postgres', 'psql', '-U', 'classroom', '-d', 'classroom_restore', '-tAc',
    "SELECT COUNT(*) FROM student WHERE status = 'anonymized'",
  ]).trim();
  check('dump 恢复到另一数据库', restored === '54' && restoredAnon === '1', `students=${restored} anonymized=${restoredAnon}`);
  let sameDbFailed = false;
  try {
    execFileSync('docker', [
      'compose', 'exec', '-T', 'backup',
      'node', 'dist/cli/index.js', 'restore',
      '--backup', dump.backup_id,
      '--target', `postgresql://classroom:${postgresPassword}@postgres:5432/classroom_manager`,
      '--confirm',
    ], { encoding: 'utf8', env: process.env });
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string };
    const text = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
    sameDbFailed = text.includes('恢复目标不能是当前 DATABASE_URL');
  }
  check('恢复不能指向正在服务的库', sameDbFailed);

  console.log(`\n验收通过 ${checks.length} 项。`);
}

main().catch((err: unknown) => {
  const error = err instanceof Error ? err : new Error(String(err));
  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
  console.error(`${error.message}${cause}`);
  process.exit(1);
});
