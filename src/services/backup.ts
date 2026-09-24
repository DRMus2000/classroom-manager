/**
 * 每日 pg_dump。失败写入 backup_record 并告警，不进入记分事务。
 */

import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { acquireAdvisoryLock, type Db, db as defaultDb } from '../repo/db.js';
import * as auditRepo from '../repo/audit.js';

export const DISK_WARN_BYTES = 3 * 1024 * 1024 * 1024;
export const DEFAULT_RETENTION_DAYS = 30;
export const BACKUP_LOCK_KEY = 'classroom:pg_dump';

export interface BackupJobResult {
  status: 'success' | 'failed' | 'busy';
  file_name: string | null;
  backup_id: string | null;
  disk_free_bytes: number | null;
  disk_warning: boolean;
  removed: string[];
  error: string | null;
}

export function redactSecrets(text: string): string {
  return text
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, 'postgresql://***')
    .replace(/\bpassword=[^\s'"]+/gi, 'password=***')
    .replace(/\bPGPASSWORD=[^\s'"]+/gi, 'PGPASSWORD=***');
}

export function resolveRetentionDays(raw: string | undefined): number {
  if (raw == null || raw.trim() === '') return DEFAULT_RETENTION_DAYS;
  if (!/^[1-9]\d{0,3}$/.test(raw.trim())) return DEFAULT_RETENTION_DAYS;
  const days = Number(raw.trim());
  if (days > 3650) return DEFAULT_RETENTION_DAYS;
  return days;
}

export function backupFileName(now: Date, taken: ReadonlySet<string>): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  const day = `${pick('year')}-${pick('month')}-${pick('day')}`;
  const daily = `${day}.dump`;
  if (!taken.has(daily)) return daily;
  const stamped = `${day}-${pick('hour')}${pick('minute')}${pick('second')}.dump`;
  if (!taken.has(stamped)) return stamped;
  throw new Error(`备份文件名已占用：${stamped}`);
}

export function isDumpFileName(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:-\d{6})?\.dump$/.test(name);
}

export function diskWarning(freeBytes: number | null): boolean {
  return freeBytes != null && freeBytes < DISK_WARN_BYTES;
}

export function pgDumpArgs(databaseUrlValue: string): { args: string[]; password?: string } {
  let url: URL;
  try {
    url = new URL(databaseUrlValue);
  } catch {
    throw new Error('DATABASE_URL 无法解析');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL 协议无效');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!url.hostname || !database || !url.username) throw new Error('DATABASE_URL 缺少主机、库名或用户');
  return {
    args: [
      '--format=custom',
      '--host',
      url.hostname,
      '--port',
      url.port || '5432',
      '--username',
      decodeURIComponent(url.username),
      '--dbname',
      database,
    ],
    password: url.password ? decodeURIComponent(url.password) : undefined,
  };
}

export function dumpWithPgDump(databaseUrlValue: string, filePath: string): Promise<void> {
  const parsed = pgDumpArgs(databaseUrlValue);
  return new Promise((resolve, reject) => {
    const child = spawn('pg_dump', [...parsed.args, '--file', filePath], {
      env: { ...process.env, ...(parsed.password ? { PGPASSWORD: parsed.password } : {}) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2000);
    });
    child.on('error', (err) => reject(err));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(redactSecrets(stderr).trim() || `pg_dump 退出码 ${code ?? 'null'}`));
    });
  });
}

function insideDir(dir: string, fileName: string): string {
  if (!isDumpFileName(fileName)) throw new Error('备份文件名无效');
  const root = path.resolve(dir);
  const target = path.resolve(root, fileName);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('备份路径越界');
  return target;
}

function clipError(err: unknown): string {
  const message = err instanceof Error ? err.message : '备份失败';
  return redactSecrets(message).slice(0, 500) || '备份失败';
}

export async function runDailyBackup(
  input: {
    dir: string;
    retentionDays: number;
    now?: Date;
    dump: (filePath: string) => Promise<void>;
    diskFree?: (dir: string) => Promise<number | null>;
  },
  db: Db = defaultDb,
): Promise<BackupJobResult> {
  if (!input.dir || path.basename(input.dir) === '..') {
    throw new Error('备份目录无效');
  }
  const release = await acquireAdvisoryLock(BACKUP_LOCK_KEY);
  if (!release) {
    return {
      status: 'busy',
      file_name: null,
      backup_id: null,
      disk_free_bytes: null,
      disk_warning: false,
      removed: [],
      error: null,
    };
  }
  try {
    return await runUnlocked(input, db);
  } finally {
    await release();
  }
}

async function runUnlocked(
  input: {
    dir: string;
    retentionDays: number;
    now?: Date;
    dump: (filePath: string) => Promise<void>;
    diskFree?: (dir: string) => Promise<number | null>;
  },
  db: Db,
): Promise<BackupJobResult> {
  const now = input.now ?? new Date();
  await mkdir(input.dir, { recursive: true });
  const existing = new Set(await readdir(input.dir));
  let fileName: string;
  try {
    fileName = backupFileName(now, existing);
  } catch (err) {
    const error = clipError(err);
    const backupId = await auditRepo.startBackup(db, 'unnamed.dump');
    await auditRepo.finishBackup(db, backupId, { status: 'failed', error });
    return {
      status: 'failed',
      file_name: null,
      backup_id: backupId,
      disk_free_bytes: null,
      disk_warning: false,
      removed: [],
      error,
    };
  }

  const filePath = insideDir(input.dir, fileName);
  const backupId = await auditRepo.startBackup(db, fileName);
  let diskFree: number | null = null;
  try {
    await input.dump(filePath);
    const info = await stat(filePath);
    if (!info.isFile() || info.size <= 0) throw new Error('备份文件为空');
    diskFree = await readDiskFree(input.dir, input.diskFree);
    await auditRepo.finishBackup(db, backupId, {
      status: 'success',
      size_bytes: info.size,
      disk_free_bytes: diskFree ?? undefined,
    });
    const removed = await pruneOldDumps(input.dir, now, input.retentionDays, fileName);
    return {
      status: 'success',
      file_name: fileName,
      backup_id: backupId,
      disk_free_bytes: diskFree,
      disk_warning: diskWarning(diskFree),
      removed,
      error: null,
    };
  } catch (err) {
    const error = clipError(err);
    await rm(filePath, { force: true }).catch(() => undefined);
    diskFree = await readDiskFree(input.dir, input.diskFree).catch(() => null);
    await auditRepo.finishBackup(db, backupId, {
      status: 'failed',
      error,
      disk_free_bytes: diskFree ?? undefined,
    });
    return {
      status: 'failed',
      file_name: fileName,
      backup_id: backupId,
      disk_free_bytes: diskFree,
      disk_warning: diskWarning(diskFree),
      removed: [],
      error,
    };
  }
}

async function readDiskFree(
  dir: string,
  diskFree?: (dir: string) => Promise<number | null>,
): Promise<number | null> {
  if (!diskFree) return null;
  const free = await diskFree(dir);
  if (free == null) return null;
  if (!Number.isFinite(free) || free < 0) return null;
  return Math.floor(free);
}

async function pruneOldDumps(dir: string, now: Date, retentionDays: number, keepName: string): Promise<string[]> {
  const days = resolveRetentionDays(String(retentionDays));
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  for (const name of await readdir(dir)) {
    if (name === keepName || !isDumpFileName(name)) continue;
    const filePath = insideDir(dir, name);
    const info = await stat(filePath);
    if (info.mtimeMs >= cutoff) continue;
    await rm(filePath, { force: true });
    removed.push(name);
  }
  return removed;
}
