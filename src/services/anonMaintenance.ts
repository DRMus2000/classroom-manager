/**
 * 匿名账本导出重试，以及恢复旧备份后的补做。
 * 不读取、不写回姓名和学号。
 */

import { sql, withTx, type Db, db as defaultDb } from '../repo/db.js';
import * as auditRepo from '../repo/audit.js';
import { writeEvent } from './publishEvent.js';
import { appendAnonLedgerEntry, readLedger, type AnonLedgerEntry } from './anonLedger.js';

export interface LedgerRetryResult {
  exported: number;
  failed: number;
  errors: { anon_id: string; message: string }[];
}

export interface ReapplyResult {
  confirm: boolean;
  applied: number;
  already: number;
  missing: number;
  pending: number;
  rejected: number;
}

interface ExportRow {
  anon_id: string;
  student_id: string;
  class_id: string;
  anon_code: string;
  process_version: number;
  processed_at: Date | string;
}

function clipError(err: unknown): string {
  const message = err instanceof Error ? err.message : '导出失败';
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://***').slice(0, 300);
}

export async function retryFailedLedgerExports(db: Db = defaultDb): Promise<LedgerRetryResult> {
  const rows = await db.execute<ExportRow>(sql`
    SELECT e.anon_id, r.student_id, r.class_id, r.anon_code, r.process_version, r.processed_at
    FROM anon_ledger_export e
    JOIN anon_registry r ON r.anon_id = e.anon_id
    WHERE e.state <> 'exported'
    ORDER BY r.processed_at, r.process_version
  `);
  const result: LedgerRetryResult = { exported: 0, failed: 0, errors: [] };
  for (const row of rows) {
    try {
      const processedAt = row.processed_at instanceof Date ? row.processed_at.toISOString() : String(row.processed_at);
      const entryId = await appendAnonLedgerEntry({
        student_id: row.student_id,
        class_id: row.class_id,
        anon_code: row.anon_code,
        processed_at: processedAt,
        process_version: Number(row.process_version),
      });
      await withTx(db, async (tx) => {
        await tx.execute(sql`
          UPDATE anon_registry SET ledger_entry_id = ${entryId} WHERE anon_id = ${row.anon_id}
        `);
        await tx.execute(sql`
          UPDATE anon_ledger_export
          SET state = 'exported', attempts = attempts + 1, last_error = NULL,
              exported_at = now(), updated_at = now()
          WHERE anon_id = ${row.anon_id}
        `);
      });
      result.exported += 1;
    } catch (err) {
      const message = clipError(err);
      result.failed += 1;
      result.errors.push({ anon_id: row.anon_id, message });
      await withTx(db, async (tx) => {
        await tx.execute(sql`
          UPDATE anon_ledger_export
          SET state = 'failed', attempts = attempts + 1, last_error = ${message}, updated_at = now()
          WHERE anon_id = ${row.anon_id}
        `);
      }).catch((updateErr: unknown) => {
        console.error(`匿名账本导出状态更新失败 ${row.anon_id}：${clipError(updateErr)}`);
      });
    }
  }
  return result;
}

export async function reapplyAnonLedger(confirm: boolean, db: Db = defaultDb): Promise<ReapplyResult> {
  const entries = await readLedger();
  if (!confirm) {
    const plan = await classifyEntries(db, entries);
    return {
      confirm: false,
      applied: 0,
      already: plan.already,
      missing: plan.missing,
      pending: plan.pending.length,
      rejected: plan.rejected,
    };
  }
  return withTx(db, async (tx) => {
    const plan = await classifyEntries(tx, entries);
    for (const entry of plan.pending) {
      await tx.execute(sql`
        UPDATE student
        SET status = 'anonymized', name = '', student_no = '', remark = NULL,
            anon_code = ${entry.anon_code}, anon_at = ${entry.processed_at}
        WHERE student_id = ${entry.student_id}
      `);
      await tx.execute(sql`
        INSERT INTO anon_registry (student_id, class_id, anon_code, processed_at, process_version, ledger_entry_id)
        VALUES (${entry.student_id}, ${entry.class_id}, ${entry.anon_code}, ${entry.processed_at},
                ${entry.process_version}, ${entry.entry_id}::uuid)
        ON CONFLICT (student_id, process_version) DO UPDATE
        SET anon_code = EXCLUDED.anon_code, ledger_entry_id = EXCLUDED.ledger_entry_id
      `);
      await tx.execute(sql`
        INSERT INTO anon_ledger_export (anon_id, state, attempts, exported_at, updated_at)
        SELECT anon_id, 'exported', 1, now(), now()
        FROM anon_registry
        WHERE student_id = ${entry.student_id} AND process_version = ${entry.process_version}
        ON CONFLICT (anon_id) DO UPDATE
        SET state = 'exported', last_error = NULL, exported_at = now(), updated_at = now()
      `);
      await auditRepo.writeAudit(tx, {
        actor: null,
        entity: 'student',
        entity_id: entry.student_id,
        action: 'anonymize_reapplied',
        before: { process_version: entry.process_version },
        after: { status: 'anonymized', anon_code: entry.anon_code },
      });
      await writeEvent(tx, {
        class_id: entry.class_id,
        kind: 'roster_changed',
        payload: {
          class_id: entry.class_id,
          action: 'student_anonymized',
          student_id: entry.student_id,
          anon_code: entry.anon_code,
        },
      });
    }
    if (plan.pending.length > 0) {
      const ids = plan.pending.map((entry) => entry.student_id);
      const leftover = await tx.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n FROM student
        WHERE student_id = ANY(${sql.param(ids)}::uuid[])
          AND (name <> '' OR student_no <> '' OR status <> 'anonymized' OR anon_code IS NULL)
      `);
      if (Number(leftover[0]?.n ?? 0) > 0) {
        throw new Error('补做之后仍有学生保留姓名或学号');
      }
    }
    return {
      confirm: true,
      applied: plan.pending.length,
      already: plan.already,
      missing: plan.missing,
      pending: 0,
      rejected: plan.rejected,
    };
  });
}

async function classifyEntries(
  db: Db,
  entries: AnonLedgerEntry[],
): Promise<{ pending: AnonLedgerEntry[]; already: number; missing: number; rejected: number }> {
  const latest = new Map<string, AnonLedgerEntry>();
  let rejected = 0;
  for (const entry of entries) {
    if (!ledgerEntryUsable(entry)) {
      rejected += 1;
      continue;
    }
    const prev = latest.get(`${entry.student_id}:${entry.process_version}`);
    if (!prev) latest.set(`${entry.student_id}:${entry.process_version}`, entry);
  }
  const pending: AnonLedgerEntry[] = [];
  let already = 0;
  let missing = 0;
  for (const entry of latest.values()) {
    const students = await db.execute<{ name: string; student_no: string; remark: string | null; status: string; anon_code: string | null }>(sql`
      SELECT name, student_no, remark, status, anon_code FROM student WHERE student_id = ${entry.student_id}
    `);
    const student = students[0];
    if (!student) {
      missing += 1;
      continue;
    }
    const registry = await db.execute<{ anon_id: string }>(sql`
      SELECT anon_id FROM anon_registry
      WHERE student_id = ${entry.student_id} AND process_version = ${entry.process_version}
    `);
    const cleared = student.name === '' && student.student_no === '' && (student.remark == null || student.remark === '')
      && student.status === 'anonymized' && student.anon_code === entry.anon_code && registry.length > 0;
    if (cleared) already += 1;
    else pending.push(entry);
  }
  return { pending, already, missing, rejected };
}

export function ledgerEntryUsable(entry: AnonLedgerEntry): boolean {
  return isUuid(entry.student_id) && isUuid(entry.class_id) && isUuid(entry.entry_id)
    && Number.isInteger(entry.process_version) && entry.process_version >= 1
    && Boolean(entry.anon_code) && entry.anon_code.length <= 40;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
