/**
 * 认证服务：登录（限流）、登出、改密、踢出其他设备、会话校验。
 *
 * 约定：
 * - 登录失败 5 次/15 分钟 → 429。
 * - 改密后 token_version +1，所有其他设备会话立即失效。
 * - 敏感凭据不进入日志。
 */

import { withTx, type Db, db as defaultDb } from '../repo/db.js';
import * as authRepo from '../repo/auth.js';
import * as auditRepo from '../repo/audit.js';
import { verifyPassword } from '../lib/crypto.js';
import { Errors } from '../lib/errors.js';
import type { LoginInput, ChangePasswordInput } from '../lib/schema.js';

const MAX_FAILURES = 5;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

export interface LoginResult {
  token: string;
  session_id: string;
  teacher: { teacher_id: string; username: string; token_version: number };
}

export async function login(
  input: LoginInput,
  meta: { ip?: string; user_agent?: string },
  db: Db = defaultDb,
): Promise<LoginResult> {
  return withTx(db, async (tx) => {
    // 1. 限流检查
    const failures = await authRepo.countRecentFailures(tx, input.username);
    if (failures >= MAX_FAILURES) {
      await authRepo.logLoginAttempt(tx, input.username, meta.ip, false);
      throw Errors.rateLimited();
    }

    // 2. 校验密码
    const teacher = await authRepo.verifyTeacherPassword(tx, input.username, input.password);
    if (!teacher) {
      await authRepo.logLoginAttempt(tx, input.username, meta.ip, false);
      throw Errors.unauthenticated('用户名或密码错误');
    }

    // 3. 建会话
    const { session_id, token } = await authRepo.createSession(tx, {
      teacher_id: teacher.teacher_id,
      token_version: teacher.token_version,
      user_agent: meta.user_agent,
      ip: meta.ip,
      expires_in_ms: SESSION_TTL_MS,
    });

    await authRepo.logLoginAttempt(tx, input.username, meta.ip, true);
    await auditRepo.writeAudit(tx, {
      actor: teacher.teacher_id,
      entity: 'teacher',
      entity_id: teacher.teacher_id,
      action: 'login',
      ip: meta.ip ?? null,
    });

    return {
      token,
      session_id,
      teacher: {
        teacher_id: teacher.teacher_id,
        username: teacher.username,
        token_version: teacher.token_version,
      },
    };
  });
}

/** 登出（撤销当前会话）。 */
export async function logout(
  sessionId: string,
  teacherId: string,
  db: Db = defaultDb,
): Promise<void> {
  await withTx(db, async (tx) => {
    await authRepo.revokeSession(tx, sessionId);
    await auditRepo.writeAudit(tx, {
      actor: teacherId,
      entity: 'teacher',
      entity_id: teacherId,
      action: 'logout',
    });
  });
}

/** 改密 + 踢出其他设备。 */
export async function changePassword(
  teacherId: string,
  currentSessionId: string,
  input: ChangePasswordInput,
  db: Db = defaultDb,
): Promise<void> {
  await withTx(db, async (tx) => {
    const ok = await authRepo.changePassword(tx, teacherId, input.old_password, input.new_password);
    if (!ok) throw Errors.unauthenticated('原密码错误');

    // 撤销除当前会话外的全部会话
    await authRepo.revokeOtherSessions(tx, teacherId, currentSessionId);

    await auditRepo.writeAudit(tx, {
      actor: teacherId,
      entity: 'teacher',
      entity_id: teacherId,
      action: 'change_password',
      request_id: input.request_id,
    });
  });
}

/** 退出其他设备（保留当前会话）。 */
export async function logoutOtherDevices(
  teacherId: string,
  currentSessionId: string,
  requestId: string,
  db: Db = defaultDb,
): Promise<void> {
  await withTx(db, async (tx) => {
    await authRepo.revokeOtherSessions(tx, teacherId, currentSessionId);
    await auditRepo.writeAudit(tx, {
      actor: teacherId,
      entity: 'teacher',
      entity_id: teacherId,
      action: 'logout_others',
      request_id: requestId,
    });
  });
}

/** 校验会话（中间件用）。 */
export async function authenticate(
  token: string,
  db: Db = defaultDb,
): Promise<{ session_id: string; teacher_id: string; username: string; token_version: number } | null> {
  const result = await authRepo.validateSession(db, token);
  if (!result) return null;
  return {
    session_id: result.session.session_id,
    teacher_id: result.teacher.teacher_id,
    username: result.teacher.username,
    token_version: result.teacher.token_version,
  };
}
