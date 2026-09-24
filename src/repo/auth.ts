/**
 * 认证数据访问：teacher / session / login_attempt。
 *
 * 约定：
 * - 密码哈希不出此模块（只返回 teacher_id / username）。
 * - 会话令牌只存哈希；校验时传入明文，内部哈希后比对。
 * - 登录限流查询最近 15 分钟失败次数。
 */

import { sql, type Db, type Tx, now, uuid } from './db.js';
import { hashPassword, verifyPassword, generateSessionToken, hashToken } from '../lib/crypto.js';

export interface Teacher {
  teacher_id: string;
  username: string;
  token_version: number;
  password_changed_at: Date;
  created_at: Date;
}

export interface Session {
  session_id: string;
  teacher_id: string;
  token_version: number;
  user_agent: string | null;
  last_seen_ip: string | null;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

export interface CreateTeacherInput {
  username: string;
  password: string;
}

export interface CreateSessionInput {
  teacher_id: string;
  token_version: number;
  user_agent?: string;
  ip?: string;
  expires_in_ms?: number; // 默认 7 天
}

/** 查询教师（by username）。 */
export async function findTeacherByUsername(db: Db | Tx, username: string): Promise<Teacher | null> {
  const rows = await db.execute<Teacher>(
    sql`SELECT teacher_id, username, token_version, password_changed_at, created_at
        FROM teacher WHERE username = ${username}`,
  );
  return rows[0] ?? null;
}

/** 查询教师（by id）。 */
export async function findTeacherById(db: Db | Tx, teacherId: string): Promise<Teacher | null> {
  const rows = await db.execute<Teacher>(
    sql`SELECT teacher_id, username, token_version, password_changed_at, created_at
        FROM teacher WHERE teacher_id = ${teacherId}`,
  );
  return rows[0] ?? null;
}

/** 创建教师（CLI 用）。 */
export async function createTeacher(db: Db | Tx, input: CreateTeacherInput): Promise<Teacher> {
  const passwordHash = await hashPassword(input.password);
  const rows = await db.execute<Teacher>(
    sql`INSERT INTO teacher (username, password_hash)
        VALUES (${input.username}, ${passwordHash})
        RETURNING teacher_id, username, token_version, password_changed_at, created_at`,
  );
  return rows[0]!;
}

/** 校验密码（by username）。 */
export async function verifyTeacherPassword(
  db: Db | Tx,
  username: string,
  password: string,
): Promise<Teacher | null> {
  const rows = await db.execute<{ teacher_id: string; password_hash: string; token_version: number }>(
    sql`SELECT teacher_id, password_hash, token_version FROM teacher WHERE username = ${username}`,
  );
  const row = rows[0];
  if (!row) return null;

  const valid = await verifyPassword(row.password_hash, password);
  if (!valid) return null;

  return findTeacherById(db, row.teacher_id);
}

/** 改密 + token_version +1（踢出其他设备）。 */
export async function changePassword(
  db: Db | Tx,
  teacherId: string,
  oldPassword: string,
  newPassword: string,
): Promise<number | null> {
  const rows = await db.execute<{ password_hash: string }>(
    sql`SELECT password_hash FROM teacher WHERE teacher_id = ${teacherId}`,
  );
  const row = rows[0];
  if (!row) return null;

  const valid = await verifyPassword(row.password_hash, oldPassword);
  if (!valid) return null;

  const newHash = await hashPassword(newPassword);
  const updated = await db.execute<{ token_version: number }>(
    sql`UPDATE teacher
        SET password_hash = ${newHash},
            token_version = token_version + 1,
            password_changed_at = ${now()}
        WHERE teacher_id = ${teacherId}
        RETURNING token_version`,
  );
  return updated[0]?.token_version ?? null;
}

/** 创建会话（返回明文 token + session_id）。 */
export async function createSession(
  db: Db | Tx,
  input: CreateSessionInput,
): Promise<{ session_id: string; token: string }> {
  const { token, tokenHash } = generateSessionToken();
  const sessionId = uuid();
  const expiresAt = new Date(Date.now() + (input.expires_in_ms ?? 7 * 24 * 60 * 60 * 1000));

  await db.execute(
    sql`INSERT INTO session (session_id, teacher_id, token_hash, token_version, user_agent, last_seen_ip, expires_at)
        VALUES (${sessionId}, ${input.teacher_id}, ${tokenHash}, ${input.token_version},
                ${input.user_agent ?? null}, ${input.ip ?? null}, ${expiresAt})`,
  );

  return { session_id: sessionId, token };
}

/** 校验会话令牌（返回有效的 session + teacher）。 */
export async function validateSession(
  db: Db | Tx,
  token: string,
): Promise<{ session: Session; teacher: Teacher } | null> {
  const tokenHash = hashToken(token);
  const rows = await db.execute<Session>(
    sql`SELECT session_id, teacher_id, token_version, user_agent, last_seen_ip,
               created_at, last_seen_at, expires_at, revoked_at
        FROM session
        WHERE token_hash = ${tokenHash}
          AND revoked_at IS NULL
          AND expires_at > ${now()}`,
  );
  const session = rows[0];
  if (!session) return null;

  const teacher = await findTeacherById(db, session.teacher_id);
  if (!teacher) return null;

  // token_version 不匹配 → 已被"退出其他设备"作废
  if (session.token_version !== teacher.token_version) return null;

  return { session, teacher };
}

/** 撤销会话（by session_id）。 */
export async function revokeSession(db: Db | Tx, sessionId: string): Promise<void> {
  await db.execute(
    sql`UPDATE session SET revoked_at = ${now()} WHERE session_id = ${sessionId}`,
  );
}

/** 撤销教师的全部未失效会话。 */
export async function revokeAllSessions(db: Db | Tx, teacherId: string): Promise<void> {
  await db.execute(
    sql`UPDATE session
        SET revoked_at = ${now()}
        WHERE teacher_id = ${teacherId}
          AND revoked_at IS NULL`,
  );
}

/** 撤销教师的全部会话（除指定 session_id）。 */
export async function revokeOtherSessions(
  db: Db | Tx,
  teacherId: string,
  exceptSessionId: string,
): Promise<void> {
  await db.execute(
    sql`UPDATE session
        SET revoked_at = ${now()}
        WHERE teacher_id = ${teacherId}
          AND session_id != ${exceptSessionId}
          AND revoked_at IS NULL`,
  );
}

/** 记录登录尝试（限流用）。 */
export async function logLoginAttempt(
  db: Db | Tx,
  username: string,
  ip: string | undefined,
  success: boolean,
): Promise<void> {
  await db.execute(
    sql`INSERT INTO login_attempt (username, ip, success) VALUES (${username}, ${ip ?? null}, ${success})`,
  );
}

/** 查询最近 15 分钟失败次数（登录限流）。 */
export async function countRecentFailures(db: Db | Tx, username: string): Promise<number> {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000);
  const rows = await db.execute<{ count: number }>(
    sql`SELECT COUNT(*)::int AS count FROM login_attempt
        WHERE username = ${username}
          AND success = false
          AND attempted_at > ${cutoff}`,
  );
  return Number(rows[0]?.count ?? 0);
}

/** 查询同一 IP 最近 15 分钟失败次数。 */
export async function countRecentFailuresByIp(db: Db | Tx, ip: string): Promise<number> {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000);
  const rows = await db.execute<{ count: number }>(
    sql`SELECT COUNT(*)::int AS count FROM login_attempt
        WHERE ip = ${ip}::inet
          AND success = false
          AND attempted_at > ${cutoff}`,
  );
  return Number(rows[0]?.count ?? 0);
}
