/**
 * HTTP 入口。路由调用已经按设计文档改过的服务。
 * 卫生、回放、点名、倒计时和导出仍没有对应服务，这些路径返回 404。
 */

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { ZodError, type ZodTypeAny } from 'zod';
import { AppError } from './lib/errors.js';
import { healthCheck, db } from './repo/db.js';
import * as classRepo from './repo/class.js';
import * as auditRepo from './repo/audit.js';
import * as authService from './services/auth.js';
import * as classService from './services/class.js';
import * as studentService from './services/students.js';
import * as layoutService from './services/layout.js';
import * as seatService from './services/seats.js';
import * as pointsService from './services/points.js';
import {
  activateTermInput,
  applyLayoutChangeInput,
  changePasswordInput,
  createBatchInput,
  createClassInput,
  createStudentInput,
  createTermInput,
  leaveStudentInput,
  listEntriesQuery,
  loginInput,
  patchClassInput,
  patchStudentInput,
  planSeatsInput,
  previewLayoutChangeInput,
  restoreStudentInput,
  reverseBatchInput,
  reverseEntryInput,
  seatAssignmentsInput,
  sseQuery,
} from './lib/schema.js';

const SESSION_COOKIE = 'session';

interface AuthUser {
  session_id: string;
  teacher_id: string;
  username: string;
  token_version: number;
}

function parse<T>(schema: ZodTypeAny, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('VALIDATION_FAILED', '请求参数不正确', { issues: result.error.issues });
  }
  return result.data as T;
}

async function requireUser(request: FastifyRequest): Promise<AuthUser> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) throw new AppError('UNAUTHENTICATED', '未登录');
  const user = await authService.authenticate(token);
  if (!user) throw new AppError('SESSION_REVOKED', '会话已失效');
  return user;
}

async function currentTermId(): Promise<string> {
  const term = await classRepo.currentTerm(db);
  if (!term) throw new AppError('NOT_FOUND', '当前学期不存在');
  return term.term_id;
}

export async function buildServer() {
  const app = Fastify({ logger: true });
  await app.register(cookie);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.httpStatus).send({
        error: { ...error.toJSON().error, request_id: request.id },
      });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: '请求参数不正确',
          details: { issues: error.issues },
          request_id: request.id,
        },
      });
    }
    request.log.error(error);
    return reply.status(500).send({
      error: { code: 'INTERNAL', message: '服务器内部错误', request_id: request.id },
    });
  });

  app.get('/healthz', async () => healthCheck());

  app.post('/api/v1/auth/login', async (request, reply) => {
    const body = parse<ReturnType<typeof loginInput.parse>>(loginInput, request.body);
    const result = await authService.login(body, {
      ip: request.ip,
      user_agent: request.headers['user-agent'],
    });
    reply.setCookie(SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: process.env['HTTPS_ENABLED'] === 'true',
    });
    return {
      teacher_id: result.teacher.teacher_id,
      username: result.teacher.username,
      token_version: result.teacher.token_version,
    };
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const user = await requireUser(request);
    await authService.logout(user.session_id, user.teacher_id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/v1/auth/password', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof changePasswordInput.parse>>(changePasswordInput, request.body);
    await authService.changePassword(user.teacher_id, user.session_id, body);
    return { ok: true };
  });

  app.post('/api/v1/auth/logout-others', async (request) => {
    const user = await requireUser(request);
    const body = parse<{ request_id: string }>(
      changePasswordInput.pick({ request_id: true }),
      request.body,
    );
    await authService.logoutOtherDevices(user.teacher_id, user.session_id, body.request_id);
    return { ok: true };
  });

  app.get('/api/v1/auth/me', async (request) => {
    const user = await requireUser(request);
    return {
      teacher_id: user.teacher_id,
      username: user.username,
      token_version: user.token_version,
    };
  });

  app.get('/api/v1/classes', async (request) => {
    await requireUser(request);
    return classService.listClasses(false);
  });

  app.post('/api/v1/classes', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof createClassInput.parse>>(createClassInput, request.body);
    return classService.createClass(user.teacher_id, body);
  });

  app.patch('/api/v1/classes/:id', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof patchClassInput.parse>>(patchClassInput, request.body);
    return classService.patchClass(user.teacher_id, (request.params as { id: string }).id, body);
  });

  app.get('/api/v1/terms', async (request) => {
    await requireUser(request);
    return classService.listTerms();
  });

  app.post('/api/v1/terms', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof createTermInput.parse>>(createTermInput, request.body);
    return classService.createTerm(user.teacher_id, body);
  });

  app.post('/api/v1/terms/:id/activate', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof activateTermInput.parse>>(activateTermInput, request.body);
    return classService.activateTerm(user.teacher_id, (request.params as { id: string }).id, body);
  });

  app.get('/api/v1/terms/:id/summary', async (request) => {
    await requireUser(request);
    return classService.termSummary((request.params as { id: string }).id);
  });

  app.get('/api/v1/classes/:id/students', async (request) => {
    await requireUser(request);
    const q = request.query as { status?: 'active' | 'left' | 'anonymized' | 'all'; q?: string };
    return studentService.listStudents((request.params as { id: string }).id, {
      status: q.status,
      q: q.q,
    });
  });

  app.post('/api/v1/classes/:id/students', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof createStudentInput.parse>>(createStudentInput, request.body);
    return studentService.createStudent(user.teacher_id, (request.params as { id: string }).id, body);
  });

  app.patch('/api/v1/students/:id', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof patchStudentInput.parse>>(patchStudentInput, request.body);
    return studentService.patchStudent(user.teacher_id, (request.params as { id: string }).id, body);
  });

  app.post('/api/v1/students/:id/leave', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof leaveStudentInput.parse>>(leaveStudentInput, request.body);
    return studentService.leaveStudent(user.teacher_id, (request.params as { id: string }).id, body);
  });

  app.post('/api/v1/students/:id/restore', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof restoreStudentInput.parse>>(restoreStudentInput, request.body);
    return studentService.restoreStudent(user.teacher_id, (request.params as { id: string }).id, body);
  });

  app.get('/api/v1/layout', async (request) => {
    await requireUser(request);
    return layoutService.getLayout();
  });

  app.post('/api/v1/layout/preview-change', async (request) => {
    await requireUser(request);
    const body = parse<ReturnType<typeof previewLayoutChangeInput.parse>>(
      previewLayoutChangeInput,
      request.body,
    );
    return layoutService.previewLayoutChange(body.kind, body.payload);
  });

  app.post('/api/v1/layout/apply-change', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof applyLayoutChangeInput.parse>>(applyLayoutChangeInput, request.body);
    return layoutService.applyLayoutChange(
      user.teacher_id,
      body.kind,
      body.payload,
      body.preview_hash,
      body.request_id,
    );
  });

  app.get('/api/v1/classes/:id/seats', async (request) => {
    await requireUser(request);
    return seatService.getClassSeats((request.params as { id: string }).id, await currentTermId());
  });

  app.post('/api/v1/classes/:id/seats/plan', async (request) => {
    await requireUser(request);
    const body = parse<ReturnType<typeof planSeatsInput.parse>>(planSeatsInput, request.body);
    return seatService.planSeats((request.params as { id: string }).id, body);
  });

  app.post('/api/v1/classes/:id/seats/apply', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof seatAssignmentsInput.parse>>(seatAssignmentsInput, request.body);
    return seatService.applySeatAssignments(
      (request.params as { id: string }).id,
      await currentTermId(),
      user.teacher_id,
      body,
    );
  });

  app.post('/api/v1/points/batches', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof createBatchInput.parse>>(createBatchInput, request.body);
    return pointsService.createBatch(user.teacher_id, body);
  });

  app.post('/api/v1/points/batches/:id/reverse', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof reverseBatchInput.parse>>(reverseBatchInput, request.body);
    return pointsService.reverseBatch(
      user.teacher_id,
      (request.params as { id: string }).id,
      body.request_id,
    );
  });

  app.post('/api/v1/points/entries/:id/reverse', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof reverseEntryInput.parse>>(reverseEntryInput, request.body);
    return pointsService.reverseEntry(
      user.teacher_id,
      (request.params as { id: string }).id,
      body.request_id,
    );
  });

  app.get('/api/v1/points/entries', async (request) => {
    await requireUser(request);
    const query = parse<ReturnType<typeof listEntriesQuery.parse>>(listEntriesQuery, request.query);
    const items = await pointsService.listTimeline(query);
    return { items, next_cursor: null };
  });

  app.get('/api/v1/events', async (request, reply: FastifyReply) => {
    await requireUser(request);
    const query = parse<ReturnType<typeof sseQuery.parse>>(sseQuery, request.query);
    const sinceHeader = request.headers['last-event-id'];
    const since = sinceHeader ? Number(sinceHeader) : query.since;
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const current = await auditRepo.maxEventSeq(db);
    raw.write(`event: snapshot\ndata: ${JSON.stringify({ current_event_seq: current })}\n\n`);
    const rows = await auditRepo.listEventsSince(db, since, query.class_id);
    if (since > 0 && rows.length === 0 && current > since + 1000) {
      raw.write(`event: resync\ndata: ${JSON.stringify({ reason: 'seq_expired' })}\n\n`);
    }
    for (const row of rows) {
      raw.write(
        `id: ${row.event_seq}\ndata: ${JSON.stringify({
          event_seq: Number(row.event_seq),
          kind: row.kind,
          class_id: row.class_id,
          payload: row.payload,
          occurred_at: row.occurred_at,
        })}\n\n`,
      );
    }
    raw.end();
  });

  return app;
}

const port = Number(process.env['API_PORT'] ?? 3000);
if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  const app = await buildServer();
  await app.listen({ port, host: '0.0.0.0' });
}
