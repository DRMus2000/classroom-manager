/**
 * 匿名化外部账本（append-only，独立于数据库备份）。
 *
 * 为什么需要它（第 12 项）：
 *   数据库备份包含学生身份信息。今天匿名化了张三，但昨天的备份里还有张三。
 *   恢复昨天的备份后，必须"补做"之后的匿名化 —— 而补做的前提是知道
 *   "哪些 student_id 在备份之后被匿名化了"。这个清单不能存在同一个数据库里
 *   （会被备份覆盖），所以必须独立保存。
 *
 * 只存四项：内部 student_id、class_id、匿名代号、匿名化时间、处理版本。
 * 刻意不存原始姓名与学号 —— 即使账本泄漏也无法反推身份。
 * 加密密钥 ANON_LEDGER_KEY 也必须独立保管（丢了账本就等价于丢了恢复能力）。
 *
 * 存储位置：ANON_LEDGER_PATH（默认 /app/anon-ledger/ledger.jsonl.enc）
 * 挂载在独立卷上，与 backups 卷分开，绝不随数据库恢复被覆盖。
 */

import { readFile, writeFile, rename, mkdir, rm, open, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { encryptAnonLedger, decryptAnonLedger } from '../lib/crypto.js';

export interface AnonLedgerEntry {
  entry_id: string; // 账本条目 id，供 anon_ledger_export.ledger_entry_id 关联
  student_id: string;
  class_id: string;
  anon_code: string;
  processed_at: string; // ISO8601
  process_version: number;
}

const DEFAULT_LEDGER_PATH = '/app/anon-ledger/ledger.jsonl.enc';

function ledgerPath(): string {
  return process.env['ANON_LEDGER_PATH'] ?? DEFAULT_LEDGER_PATH;
}

function ledgerKey(): string {
  const key = process.env['ANON_LEDGER_KEY'];
  if (!key || key.length !== 64) {
    throw new Error(
      'ANON_LEDGER_KEY 未设置或格式不正确（需要 32 字节 hex，共 64 个字符）。' +
        '该密钥必须独立于数据库备份保管，否则恢复旧备份后将无法补做匿名化。',
    );
  }
  return key;
}

/**
 * 读取并解密现有账本。文件不存在 → 返回空数组。
 *
 * 注：为满足"追加保存"语义，实现上是「解密 → 追加 → 重新加密 → 原子写入」。
 * 这在严格意义上是重写文件，但对本场景可接受：账本条目极少（学生级操作）、
 * 运行频率极低，且原子 rename 保证不会读到半截文件。
 */
export async function readLedger(): Promise<AnonLedgerEntry[]> {
  const path = ledgerPath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const plaintext = decryptAnonLedger(raw, ledgerKey());
  return plaintext
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AnonLedgerEntry);
}

export type NewAnonLedgerEntry = Omit<AnonLedgerEntry, 'entry_id'>;

/** 追加一条匿名化记录，返回账本条目 id。 */
export async function appendAnonLedgerEntry(input: NewAnonLedgerEntry): Promise<string> {
  const [entryId] = await appendAnonLedgerEntries([input]);
  if (!entryId) throw new Error('匿名账本没有写入');
  return entryId;
}

/**
 * 一次追加多条。同一学生、同一处理版本已存在时复用原条目，不重复追加。
 * 写入用临时文件再 rename；失败时删掉临时文件，不改已有账本。
 */
export async function appendAnonLedgerEntries(inputs: NewAnonLedgerEntry[]): Promise<string[]> {
  if (inputs.length === 0) return [];
  for (const input of inputs) validateLedgerInput(input);

  return withLedgerLock(async () => {
  const key = ledgerKey();
  const existing = await readLedger();
  const ids: string[] = [];
  const appended: AnonLedgerEntry[] = [];
  for (const input of inputs) {
    const prev =
      existing.find(
        (entry) =>
          entry.student_id === input.student_id && entry.process_version === input.process_version,
      ) ??
      appended.find(
        (entry) =>
          entry.student_id === input.student_id && entry.process_version === input.process_version,
      );
    if (prev) {
      ids.push(prev.entry_id);
      continue;
    }
    const entry: AnonLedgerEntry = { entry_id: randomUUID(), ...input };
    appended.push(entry);
    ids.push(entry.entry_id);
  }
  if (appended.length === 0) return ids;
  await writeEncrypted([...existing, ...appended], key);
  return ids;
  });
}

function validateLedgerInput(input: NewAnonLedgerEntry): void {
  if (!input.student_id || !input.class_id || !input.anon_code) {
    throw new Error('匿名账本条目缺少必要字段');
  }
  if (input.student_id.length > 64 || input.class_id.length > 64 || input.anon_code.length > 64) {
    throw new Error('匿名账本字段过长');
  }
  if (!Number.isInteger(input.process_version) || input.process_version < 1) {
    throw new Error('匿名账本处理版本不合法');
  }
  if (Number.isNaN(Date.parse(input.processed_at))) {
    throw new Error('匿名账本时间不合法');
  }
}

async function withLedgerLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = `${ledgerPath()}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  const stale = await stat(lockPath).catch(() => null);
  if (stale && Date.now() - stale.mtimeMs > 5_000) {
    await rm(lockPath, { force: true });
  }
  const started = Date.now();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (!handle) {
    try {
      handle = await open(lockPath, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (Date.now() - started > 5_000) throw new Error('匿名账本锁等待超时');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await fn();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

async function writeEncrypted(entries: AnonLedgerEntry[], key: string): Promise<void> {
  const plaintext = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
  const ciphertext = encryptAnonLedger(plaintext, key);
  const path = ledgerPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.ledger.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tmp, ciphertext, { encoding: 'utf8', flag: 'wx' });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * 恢复辅助：给定旧备份的恢复时间点，列出"该时间点之后被匿名化"的 student_id。
 *
 * 用途：恢复旧备份 → 用本函数得到待补做的 student_id 清单 →
 *       在新库上重新执行匿名化 → 才能对公网开放（第 12 项）。
 */
export async function listStudentsToReanonymize(
  backupTimestamp: Date,
): Promise<AnonLedgerEntry[]> {
  const all = await readLedger();

  // 同一学生可能有多条记录（重复处理），取每个 student_id 的最新一条
  const latest = new Map<string, AnonLedgerEntry>();
  for (const e of all) {
    const prev = latest.get(e.student_id);
    if (!prev || e.process_version > prev.process_version) latest.set(e.student_id, e);
  }

  return [...latest.values()]
    .filter((e) => new Date(e.processed_at) > backupTimestamp)
    .sort((a, b) => a.processed_at.localeCompare(b.processed_at));
}

/** 账本统计（诊断用）。 */
export async function ledgerStats(): Promise<{
  path: string;
  entries: number;
  students: number;
  max_process_version: number;
  last_processed_at: string | null;
}> {
  const all = await readLedger();
  const students = new Set(all.map((e) => e.student_id));
  const versions = all.map((e) => e.process_version);
  const times = all.map((e) => e.processed_at).sort();

  return {
    path: ledgerPath(),
    entries: all.length,
    students: students.size,
    max_process_version: versions.length > 0 ? Math.max(...versions) : 0,
    last_processed_at: times.length > 0 ? times[times.length - 1]! : null,
  };
}
