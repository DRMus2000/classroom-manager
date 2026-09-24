/**
 * 审计与备份查询服务（只读）。
 *
 * 约定（第 11 项）：
 * - 审计记录与业务变更同事务写入，本模块只负责查询与展示。
 * - 审计页按需查询，不做实时推送。
 */

import type { Db } from '../repo/db.js';
import { db as defaultDb } from '../repo/db.js';
import * as auditRepo from '../repo/audit.js';
import { AppError } from '../lib/errors.js';
import type { AuditQuery, BackupRecordDto } from '../lib/schema.js';

function isoTimestamp(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function requiredIso(value: Date | string): string {
  const iso = isoTimestamp(value);
  if (!iso) throw new AppError('INTERNAL', '时间字段无法解析');
  return iso;
}

function redactAudit(value: unknown, entity: string): unknown {
  if (Array.isArray(value)) return value.map((item) => redactAudit(item, entity));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const rest: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === 'student_no') continue;
    if (key === 'name' && (entity === 'student' || 'student_no' in record)) continue;
    rest[key] = redactAudit(child, entity);
  }
  return rest;
}

export interface AuditDto {
  audit_id: number;
  actor: string | null;
  entity: string;
  entity_id: string | null;
  action: string;
  before: unknown;
  after: unknown;
  request_id: string | null;
  created_at: string;
}

export async function eventsSince(since: number, classId?: string, db: Db = defaultDb) {
  const current = await auditRepo.maxEventSeq(db);
  const rows = await auditRepo.listEventsSince(db, since, classId);
  return { current, rows };
}

export async function listAudit(
  q: AuditQuery,
  db: Db = defaultDb,
): Promise<{ items: AuditDto[]; next_cursor: string | null }> {
  const limit = q.limit ?? 50;

  const rows = await auditRepo.listAudit(db, {
    entity: q.entity,
    entity_id: q.entity_id,
    action: q.action,
    date_from: q.date_from ? new Date(q.date_from) : undefined,
    date_to: q.date_to ? new Date(q.date_to) : undefined,
    limit: limit + 1, // 多取一条判断是否还有下一页
    cursor_id: q.cursor ? Number(q.cursor) : undefined,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    items: page.map((r) => ({
      audit_id: Number(r.audit_id),
      actor: r.actor,
      entity: r.entity,
      entity_id: r.entity_id,
      action: r.action,
      before: redactAudit(r.before, r.entity),
      after: redactAudit(r.after, r.entity),
      request_id: r.request_id,
      created_at: requiredIso(r.created_at),
    })),
    next_cursor: hasMore ? String(Number(page[page.length - 1]!.audit_id)) : null,
  };
}

export async function listBackups(db: Db = defaultDb): Promise<BackupRecordDto[]> {
  const rows = await auditRepo.listBackups(db);
  return rows.map((r) => ({
    backup_id: r.backup_id,
    file_name: r.file_name,
    size_bytes: r.size_bytes == null ? null : Number(r.size_bytes),
    disk_free_bytes: r.disk_free_bytes == null ? null : Number(r.disk_free_bytes),
    status: r.status,
    error: r.error,
    started_at: requiredIso(r.started_at),
    finished_at: isoTimestamp(r.finished_at),
  }));
}

/**
 * 备份健康摘要：供管理界面显示"最近成功时间 / 是否失败 / 磁盘剩余"。
 * 磁盘低于阈值（默认 3GB）时给出告警。
 */
export async function backupHealth(db: Db = defaultDb): Promise<{
  last_success_at: string | null;
  last_failure_at: string | null;
  last_failure_error: string | null;
  disk_free_bytes: number | null;
  disk_warning: boolean;
  total_backups: number;
}> {
  const rows = await auditRepo.listBackups(db, 100);

  const success = rows.find((r) => r.status === 'success');
  const failure = rows.find((r) => r.status === 'failed');
  const rawFree = rows.find((row) => row.disk_free_bytes != null)?.disk_free_bytes;
  const diskFree = rawFree == null ? null : Number(rawFree);

  const DISK_WARN_BYTES = 3 * 1024 * 1024 * 1024; // 3 GB

  return {
    last_success_at: isoTimestamp(success?.finished_at),
    last_failure_at: isoTimestamp(failure?.finished_at),
    last_failure_error: failure?.error ?? null,
    disk_free_bytes: diskFree,
    disk_warning: diskFree != null && diskFree < DISK_WARN_BYTES,
    total_backups: rows.length,
  };
}
