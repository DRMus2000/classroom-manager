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
import type { AuditQuery, BackupRecordDto } from '../lib/schema.js';

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
      audit_id: r.audit_id,
      actor: r.actor,
      entity: r.entity,
      entity_id: r.entity_id,
      action: r.action,
      before: r.before,
      after: r.after,
      request_id: r.request_id,
      created_at: r.created_at.toISOString(),
    })),
    next_cursor: hasMore ? String(page[page.length - 1]!.audit_id) : null,
  };
}

export async function listBackups(db: Db = defaultDb): Promise<BackupRecordDto[]> {
  const rows = await auditRepo.listBackups(db);
  return rows.map((r) => ({
    backup_id: r.backup_id,
    file_name: r.file_name,
    size_bytes: r.size_bytes,
    disk_free_bytes: r.disk_free_bytes,
    status: r.status,
    error: r.error,
    started_at: r.started_at.toISOString(),
    finished_at: r.finished_at?.toISOString() ?? null,
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
  const diskFree = rows.find((r) => r.disk_free_bytes != null)?.disk_free_bytes ?? null;

  const DISK_WARN_BYTES = 3 * 1024 * 1024 * 1024; // 3 GB

  return {
    last_success_at: success?.finished_at?.toISOString() ?? null,
    last_failure_at: failure?.finished_at?.toISOString() ?? null,
    last_failure_error: failure?.error ?? null,
    disk_free_bytes: diskFree,
    disk_warning: diskFree != null && diskFree < DISK_WARN_BYTES,
    total_backups: rows.length,
  };
}
