/**
 * HTTP 辅助：代理信任、会话 Cookie、请求解析。
 */

import type { FastifyReply } from 'fastify';
import { sessionCookieOptions, trustProxyFromEnv } from './lib/httpSecurity.js';
import { z, type ZodTypeAny } from 'zod';
import { AppError } from './lib/errors.js';
import { db } from './repo/db.js';
import * as classRepo from './repo/class.js';
import * as authService from './services/auth.js';
import { uuid } from './lib/schema.js';

export const SESSION_COOKIE = 'session';

export interface AuthUser {
  session_id: string;
  teacher_id: string;
  username: string;
  token_version: number;
}

export { sessionCookieOptions, trustProxyFromEnv };

export function parse<T>(schema: ZodTypeAny, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('VALIDATION_FAILED', '请求参数不正确', { issues: result.error.issues });
  }
  return result.data as T;
}

export function routeId(request: { params: unknown }): string {
  return parse<{ id: string }>(z.object({ id: uuid }), request.params).id;
}

export function leaderboardScope(query: unknown): { term_id: string; class_id?: string } {
  const parsed = parse<{ term_id: string; class_id?: string }>(
    z.object({
      term_id: uuid,
      class_id: z.string().optional(),
    }),
    query,
  );
  const classId = !parsed.class_id || parsed.class_id === 'all' ? undefined : parsed.class_id;
  if (classId && !uuid.safeParse(classId).success) {
    throw new AppError('VALIDATION_FAILED', '请求参数不正确', {
      issues: [{ path: ['class_id'], message: '必须是 UUID 或 all' }],
    });
  }
  return { term_id: parsed.term_id, class_id: classId };
}

export async function requireUser(request: { cookies: Partial<Record<string, string>> }): Promise<AuthUser> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) throw new AppError('UNAUTHENTICATED', '未登录');
  const user = await authService.authenticate(token);
  if (!user) throw new AppError('SESSION_REVOKED', '会话已失效');
  return user;
}

export async function currentTermId(): Promise<string> {
  const term = await classRepo.currentTerm(db);
  if (!term) throw new AppError('NOT_FOUND', '当前学期不存在');
  return term.term_id;
}

export function sendWorkbook(
  reply: FastifyReply,
  file: { filename: string; body: Buffer },
  contentType: string,
  disposition: string,
) {
  return reply
    .header('Content-Type', contentType)
    .header('Content-Disposition', disposition)
    .header('Content-Length', String(file.body.length))
    .send(file.body);
}
