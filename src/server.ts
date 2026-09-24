/**
 * HTTP 入口。路由调用已经按设计文档改过的服务。
 * 卫生、回放、点名、倒计时和导出仍没有对应服务，这些路径返回 404。
 * 名单导入提供模板下载、预览和提交。
 */

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { z, ZodError, type ZodTypeAny } from 'zod';
import { AppError } from './lib/errors.js';
import { randomUUID } from 'node:crypto';
import { healthCheck, db } from './repo/db.js';
import { broadcaster } from './events/broadcaster.js';
import * as classRepo from './repo/class.js';
import * as auditRepo from './repo/audit.js';
import * as authService from './services/auth.js';
import * as classService from './services/class.js';
import * as studentService from './services/students.js';
import * as layoutService from './services/layout.js';
import * as seatService from './services/seats.js';
import * as pointsService from './services/points.js';
import * as markService from './services/marks.js';
import * as auditService from './services/audit.js';
import * as dutyService from './services/duty.js';
import * as importService from './services/imports.js';
import {
  MAX_IMPORT_BYTES,
  XLSX_MIME,
  assertXlsxUpload,
  buildImportTemplate,
  contentDisposition,
  detectImportKind,
  importFileError,
  isUploadTooLarge,
} from './services/importTemplate.js';
import {
  activateTermInput,
  auditQuery,
  applyLayoutChangeInput,
  changePasswordInput,
  createBatchInput,
  dutyAbsentInput,
  dutyAttendanceInput,
  dutyCorrectInput,
  dutyFreezeInput,
  dutyNoPushInput,
  dutySelectionInput,
  dutyVersionInput,
  createClassInput,
  anonymizeClassInput,
  anonymizeStudentInput,
  importCommitInput,
  importTemplateQuery,
  createStudentInput,
  createTemplateInput,
  createTermInput,
  leaveStudentInput,
  listEntriesQuery,
  createMarkInput,
  loginInput,
  markAssignInput,
  patchClassInput,
  patchMarkInput,
  patchTemplateInput,
  patchStudentInput,
  overrideTemplateInput,
  planSeatsInput,
  previewLayoutChangeInput,
  restoreStudentInput,
  reverseBatchInput,
  reverseEntryInput,
  seatAssignmentsInput,
  sseQuery,
  uuid,
} from './lib/schema.js';

const SESSION_COOKIE = 'session';

interface AuthUser {
  session_id: string;
  teacher_id: string;
  username: string;
  token_version: number;
}

function routeId(request: FastifyRequest): string {
  return parse<{ id: string }>(z.object({ id: uuid }), request.params).id;
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
  await app.register(multipart, {
    limits: { fileSize: MAX_IMPORT_BYTES, files: 1, fields: 4, fieldSize: 1024 },
  });

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
    if (isUploadTooLarge(error)) {
      return reply.status(422).send({
        error: {
          code: 'IMPORT_INVALID',
          message: '导入文件校验失败',
          details: { issues: [{ code: 'FILE_TOO_LARGE', message: '文件超过 2MB' }] },
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

  app.post('/api/v1/auth/password', async (request, reply) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof changePasswordInput.parse>>(changePasswordInput, request.body);
    const { token } = await authService.changePassword(user.teacher_id, user.session_id, body, db, {
      ip: request.ip,
      user_agent: request.headers['user-agent'],
    });
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: process.env['HTTPS_ENABLED'] === 'true',
    });
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

  app.get('/api/v1/marks', async (request) => {
    await requireUser(request);
    return markService.listMarks();
  });

  app.post('/api/v1/marks', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof createMarkInput.parse>>(createMarkInput, request.body);
    return markService.createMark(user.teacher_id, body);
  });

  app.patch('/api/v1/marks/:id', async (request) => {
    const user = await requireUser(request);
    const markId = routeId(request);
    const body = parse<ReturnType<typeof patchMarkInput.parse>>(patchMarkInput, request.body);
    const { request_id, ...patch } = body;
    return markService.patchMark(user.teacher_id, markId, patch, request_id);
  });

  app.post('/api/v1/students/:id/marks/:mark_id', async (request) => {
    const user = await requireUser(request);
    const params = parse<{ id: string; mark_id: string }>(
      z.object({ id: uuid, mark_id: uuid }),
      request.params,
    );
    const body = parse<ReturnType<typeof markAssignInput.parse>>(markAssignInput, request.body);
    await markService.addMark(user.teacher_id, params.id, params.mark_id, body.request_id);
    return { ok: true };
  });

  app.delete('/api/v1/students/:id/marks/:mark_id', async (request) => {
    const user = await requireUser(request);
    const params = parse<{ id: string; mark_id: string }>(
      z.object({ id: uuid, mark_id: uuid }),
      request.params,
    );
    const body = parse<ReturnType<typeof markAssignInput.parse>>(markAssignInput, request.body);
    await markService.removeMark(user.teacher_id, params.id, params.mark_id, body.request_id);
    return { ok: true };
  });

  app.get('/api/v1/audit', async (request) => {
    await requireUser(request);
    const query = parse<ReturnType<typeof auditQuery.parse>>(auditQuery, request.query);
    return auditService.listAudit(query);
  });

  app.get('/api/v1/backup/records', async (request) => {
    await requireUser(request);
    return auditService.listBackups();
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
    return classService.patchClass(user.teacher_id, routeId(request), body);
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
    return classService.activateTerm(user.teacher_id, routeId(request), body);
  });

  app.get('/api/v1/terms/:id/summary', async (request) => {
    await requireUser(request);
    return classService.termSummary(routeId(request));
  });

  app.get('/api/v1/classes/:id/students', async (request) => {
    await requireUser(request);
    const q = request.query as { status?: 'active' | 'left' | 'anonymized' | 'all'; q?: string };
    return studentService.listStudents(routeId(request), {
      status: q.status,
      q: q.q,
    });
  });

  app.post('/api/v1/classes/:id/students', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof createStudentInput.parse>>(createStudentInput, request.body);
    return studentService.createStudent(user.teacher_id, routeId(request), body);
  });

  app.patch('/api/v1/students/:id', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof patchStudentInput.parse>>(patchStudentInput, request.body);
    return studentService.patchStudent(user.teacher_id, routeId(request), body);
  });

  app.post('/api/v1/students/:id/leave', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof leaveStudentInput.parse>>(leaveStudentInput, request.body);
    return studentService.leaveStudent(user.teacher_id, routeId(request), body);
  });

  app.post('/api/v1/students/:id/restore', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof restoreStudentInput.parse>>(restoreStudentInput, request.body);
    return studentService.restoreStudent(user.teacher_id, routeId(request), body);
  });

  app.post('/api/v1/students/:id/anonymize', async (request) => {
    const user = await requireUser(request);
    const studentId = routeId(request);
    const body = parse<ReturnType<typeof anonymizeStudentInput.parse>>(anonymizeStudentInput, request.body);
    return studentService.anonymizeStudent(user.teacher_id, studentId, body.request_id);
  });

  app.post('/api/v1/classes/:id/anonymize', async (request) => {
    const user = await requireUser(request);
    const classId = routeId(request);
    const body = parse<ReturnType<typeof anonymizeClassInput.parse>>(anonymizeClassInput, request.body);
    return studentService.anonymizeClass(user.teacher_id, classId, body.request_id);
  });

  app.get('/api/v1/classes/:id/import/template', async (request, reply) => {
    await requireUser(request);
    const classId = routeId(request);
    const query = parse<ReturnType<typeof importTemplateQuery.parse>>(importTemplateQuery, request.query);
    await classService.requireClass(classId);
    const template = await buildImportTemplate(query.kind);
    return reply
      .header('Content-Type', XLSX_MIME)
      .header('Content-Disposition', contentDisposition(template.filename))
      .header('Content-Length', String(template.body.length))
      .send(template.body);
  });

  app.post('/api/v1/classes/:id/import/preview', async (request) => {
    await requireUser(request);
    const classId = routeId(request);
    let file;
    try {
      file = await request.file();
    } catch (err) {
      if (isUploadTooLarge(err)) throw importFileError('FILE_TOO_LARGE', '文件超过 2MB');
      throw importFileError('FILE_UNREADABLE', '文件读取失败');
    }
    if (!file || file.fieldname !== 'file') {
      throw importFileError('FILE_REQUIRED', '请上传字段名为 file 的 xlsx 文件');
    }
    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch (err) {
      if (isUploadTooLarge(err)) throw importFileError('FILE_TOO_LARGE', '文件超过 2MB');
      throw importFileError('FILE_UNREADABLE', '文件读取失败');
    }
    assertXlsxUpload(file.filename || '', buffer);
    const kind = await detectImportKind(buffer);
    return importService.buildPreviewWithChangeSet(classId, kind, buffer);
  });

  app.post('/api/v1/classes/:id/import/commit', async (request) => {
    const user = await requireUser(request);
    const classId = routeId(request);
    const body = parse<ReturnType<typeof importCommitInput.parse>>(importCommitInput, request.body);
    const result = await importService.commitImport(
      user.teacher_id,
      classId,
      body.preview_token,
      body.expected_version,
      body.request_id,
    );
    return {
      seat_version: result.seat_version,
      applied: { create: result.created, update: result.updated },
    };
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
    return seatService.getClassSeats(routeId(request), await currentTermId());
  });

  app.post('/api/v1/classes/:id/seats/plan', async (request) => {
    await requireUser(request);
    const body = parse<ReturnType<typeof planSeatsInput.parse>>(planSeatsInput, request.body);
    return seatService.planSeats(routeId(request), body);
  });

  app.post('/api/v1/classes/:id/seats/apply', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof seatAssignmentsInput.parse>>(seatAssignmentsInput, request.body);
    return seatService.applySeatAssignments(
      routeId(request),
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
      routeId(request),
      body.request_id,
    );
  });

  app.post('/api/v1/points/entries/:id/reverse', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof reverseEntryInput.parse>>(reverseEntryInput, request.body);
    return pointsService.reverseEntry(
      user.teacher_id,
      routeId(request),
      body.request_id,
    );
  });

  app.get('/api/v1/classes/:id/templates', async (request) => {
    await requireUser(request);
    return pointsService.listEffectiveTemplates(routeId(request));
  });

  app.post('/api/v1/templates', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof createTemplateInput.parse>>(createTemplateInput, request.body);
    return pointsService.createGlobalTemplate(user.teacher_id, body);
  });

  app.patch('/api/v1/templates/:id', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof patchTemplateInput.parse>>(patchTemplateInput, request.body);
    return pointsService.patchGlobalTemplate(user.teacher_id, routeId(request), body);
  });

  app.post('/api/v1/classes/:id/templates', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof createTemplateInput.parse>>(createTemplateInput, request.body);
    return pointsService.createClassTemplate(user.teacher_id, routeId(request), body);
  });

  app.post('/api/v1/classes/:id/templates/:template_id/override', async (request) => {
    const user = await requireUser(request);
    const params = parse<{ id: string; template_id: string }>(
      z.object({ id: uuid, template_id: uuid }),
      request.params,
    );
    const body = parse<ReturnType<typeof overrideTemplateInput.parse>>(overrideTemplateInput, request.body);
    return pointsService.overrideTemplate(user.teacher_id, params.id, params.template_id, body);
  });

  app.delete('/api/v1/classes/:id/templates/:template_id/override', async (request) => {
    const user = await requireUser(request);
    const params = parse<{ id: string; template_id: string }>(
      z.object({ id: uuid, template_id: uuid }),
      request.params,
    );
    const body = parse<ReturnType<typeof markAssignInput.parse>>(markAssignInput, request.body);
    return pointsService.clearTemplateOverride(
      user.teacher_id,
      params.id,
      params.template_id,
      body.request_id,
    );
  });

  app.get('/api/v1/leaderboard', async (request) => {
    await requireUser(request);
    const query = parse<{ term_id: string; class_id?: string }>(
      z.object({
        term_id: uuid,
        class_id: z.string().optional(),
      }),
      request.query,
    );
    const classId = !query.class_id || query.class_id === 'all' ? undefined : query.class_id;
    if (classId && !uuid.safeParse(classId).success) {
      throw new AppError('VALIDATION_FAILED', '请求参数不正确', {
        issues: [{ path: ['class_id'], message: '必须是 UUID 或 all' }],
      });
    }
    return { items: await pointsService.listLeaderboard(query.term_id, classId) };
  });

  app.get('/api/v1/points/entries', async (request) => {
    await requireUser(request);
    const query = parse<ReturnType<typeof listEntriesQuery.parse>>(listEntriesQuery, request.query);
    return pointsService.listTimeline(query);
  });

  app.get('/api/v1/classes/:id/duty', async (request) => {
    await requireUser(request);
    return dutyService.getClassDuty(routeId(request));
  });

  app.post('/api/v1/classes/:id/duty/rounds', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof dutyFreezeInput.parse>>(dutyFreezeInput, request.body);
    return dutyService.startRound(user.teacher_id, routeId(request), body.request_id);
  });

  app.get('/api/v1/duty/rounds/:id', async (request) => {
    await requireUser(request);
    return dutyService.getRound(routeId(request));
  });

  app.post('/api/v1/duty/rounds/:id/attendance', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof dutyAttendanceInput.parse>>(dutyAttendanceInput, request.body);
    return dutyService.markAttendance(user.teacher_id, routeId(request), body.duty_term_ids, body.expected_version, body.request_id);
  });

  app.post('/api/v1/duty/rounds/:id/no-push', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof dutyNoPushInput.parse>>(dutyNoPushInput, request.body);
    return dutyService.markNoPush(user.teacher_id, routeId(request), body.student_ids, body.expected_version, body.request_id);
  });

  app.post('/api/v1/duty/rounds/:id/absent-confirmed', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof dutyAbsentInput.parse>>(dutyAbsentInput, request.body);
    return dutyService.confirmAbsent(user.teacher_id, routeId(request), body.duty_term_id, body.expected_version, body.request_id);
  });

  app.post('/api/v1/duty/rounds/:id/candidates/freeze', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof dutyFreezeInput.parse>>(dutyFreezeInput, request.body);
    return dutyService.freezeCandidates(user.teacher_id, routeId(request), body.request_id);
  });

  app.post('/api/v1/duty/rounds/:id/selections', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof dutySelectionInput.parse>>(dutySelectionInput, request.body);
    return dutyService.drawSelection(user.teacher_id, routeId(request), body.student_id, body.expected_version, body.request_id);
  });

  app.get('/api/v1/duty/selections/:id', async (request) => {
    await requireUser(request);
    return dutyService.getSelection(routeId(request));
  });

  app.post('/api/v1/duty/selections/:id/cancel', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof dutyFreezeInput.parse>>(dutyFreezeInput, request.body);
    return dutyService.cancelSelection(user.teacher_id, routeId(request), body.request_id);
  });

  app.post('/api/v1/duty/selections/:id/reopen', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof dutyFreezeInput.parse>>(dutyFreezeInput, request.body);
    return dutyService.reopenSelection(user.teacher_id, routeId(request), body.request_id);
  });

  app.post('/api/v1/duty/selections/:id/confirm', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof dutyFreezeInput.parse>>(dutyFreezeInput, request.body);
    return dutyService.confirmSelection(user.teacher_id, routeId(request), body.request_id);
  });

  app.post('/api/v1/duty/terms/:id/correct', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof dutyCorrectInput.parse>>(dutyCorrectInput, request.body);
    return dutyService.correctTerm(user.teacher_id, routeId(request), body);
  });

  app.post('/api/v1/duty/rounds/:id/close', async (request) => {
    const user = await requireUser(request);
    const body = parse<ReturnType<typeof dutyVersionInput.parse>>(dutyVersionInput, request.body);
    return dutyService.closeRound(user.teacher_id, routeId(request), body.expected_version, body.request_id);
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
    const { current, rows } = await auditService.eventsSince(since, query.class_id);
    raw.write(`event: snapshot\ndata: ${JSON.stringify({ current_event_seq: current })}\n\n`);
    if (since > 0 && rows.length === 0 && current > since + 1000) {
      raw.write(`event: resync\ndata: ${JSON.stringify({ reason: 'seq_expired' })}\n\n`);
    }
    let sent = since;
    for (const row of rows) {
      const seq = Number(row.event_seq);
      raw.write(
        `id: ${seq}\ndata: ${JSON.stringify({
          event_seq: seq,
          kind: row.kind,
          class_id: row.class_id,
          payload: row.payload,
          occurred_at: row.occurred_at,
        })}\n\n`,
      );
      sent = seq;
    }
    const unsubscribe = broadcaster.subscribe(randomUUID(), raw, {
      classId: query.class_id,
      lastEventId: sent,
    });
    raw.on('close', unsubscribe);
  });

  return app;
}

const port = Number(process.env['API_PORT'] ?? 3000);
if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  const app = await buildServer();
  await app.listen({ port, host: '0.0.0.0' });
}
