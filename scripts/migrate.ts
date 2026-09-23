/**
 * 迁移执行器：按文件名顺序执行 migrations/*.sql。
 *
 * 用法：
 *   npm run migrate up        # 执行全部未执行的迁移
 *   npm run migrate status    # 查看已执行/未执行
 *   npm run migrate down N    # 回滚最近 N 个（需要对应的 down 脚本，暂未实现）
 *
 * 迁移记录存在 schema_migrations 表（filename + checksum + applied_at）。
 * 已执行迁移的 checksum 变化会报警（防止篡改历史迁移）。
 */

import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, sql, withTx, closeDb } from '../src/repo/db.js';
import { changedDiff, renumerate, type RoomColumn, type RoomSlot } from '../src/domain/renumber.js';
import { applySeatNumbers } from '../src/repo/layout.js';
import type { SeatDirection } from '../src/lib/schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

interface MigrationFile {
  filename: string;
  sql: string;
  checksum: string;
}

async function ensureMigrationsTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function loadMigrations(): Promise<MigrationFile[]> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const out: MigrationFile[] = [];
  for (const filename of files) {
    const content = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');
    out.push({
      filename,
      sql: content,
      checksum: createHash('sha256').update(content, 'utf8').digest('hex'),
    });
  }
  return out;
}

async function appliedMigrations(): Promise<Map<string, { checksum: string; applied_at: Date }>> {
  const rows = await db.execute<{ filename: string; checksum: string; applied_at: Date }>(
    sql`SELECT filename, checksum, applied_at FROM schema_migrations ORDER BY filename`,
  );
  return new Map(rows.map((r) => [r.filename, { checksum: r.checksum, applied_at: r.applied_at }]));
}

async function migrateUp(): Promise<void> {
  await ensureMigrationsTable();
  const [all, applied] = await Promise.all([loadMigrations(), appliedMigrations()]);

  let count = 0;
  for (const m of all) {
    const prev = applied.get(m.filename);

    if (prev) {
      if (prev.checksum !== m.checksum) {
        console.warn(
          `⚠️  ${m.filename} 已执行但内容已变更（checksum 不符）。请勿修改历史迁移，应新建迁移文件。`,
        );
      }
      continue;
    }

    console.log(`▶ 执行 ${m.filename} ...`);
    await withTx(db, async (tx) => {
      await tx.execute(sql.raw(m.sql));
      await tx.execute(
        sql`INSERT INTO schema_migrations (filename, checksum) VALUES (${m.filename}, ${m.checksum})`,
      );
    });
    console.log(`✓ ${m.filename} 完成`);
    count++;
  }

  if (count === 0) console.log('没有待执行的迁移。');
  else console.log(`\n共执行 ${count} 个迁移。`);

  await fillSeatNumbers();
}

/** 迁移不写显示编号。此处用 renumerate() 回填，已正确的编号不会重写。 */
async function fillSeatNumbers(): Promise<void> {
  const tables = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'room_slot'
    ) AS exists
  `);
  if (!tables[0]?.exists) return;

  const columns = await db.execute<{
    column_id: string;
    code: string;
    display_order: number;
    direction: SeatDirection;
  }>(sql`
    SELECT column_id, code, display_order, direction::text AS direction
    FROM room_column
  `);
  const slots = await db.execute<{
    seat_id: string;
    column_id: string;
    sort_in_column: number;
    seat_number: number | null;
  }>(sql`
    SELECT seat_id, column_id, sort_in_column, seat_number
    FROM room_slot
  `);

  const roomColumns: RoomColumn[] = columns.map((column) => ({
    column_id: column.column_id,
    code: column.code,
    display_order: column.display_order,
    direction: column.direction,
  }));
  const roomSlots: RoomSlot[] = slots.map((slot) => ({
    seat_id: slot.seat_id,
    column_id: slot.column_id,
    sort_in_column: slot.sort_in_column,
    seat_number: slot.seat_number,
  }));
  const diff = renumerate(roomColumns, roomSlots);
  if (changedDiff(diff).length === 0) {
    console.log('座位编号已与 renumerate() 一致。');
    return;
  }

  await withTx(db, async (tx) => {
    await applySeatNumbers(tx, diff);
  });
  console.log(`已按 renumerate() 回填 ${diff.length} 个座位编号。`);
}

async function migrateStatus(): Promise<void> {
  await ensureMigrationsTable();
  const [all, applied] = await Promise.all([loadMigrations(), appliedMigrations()]);

  console.log('迁移状态：\n');
  for (const m of all) {
    const prev = applied.get(m.filename);
    if (prev) {
      const dirty = prev.checksum !== m.checksum ? '  ⚠️ checksum 不符' : '';
      console.log(`  [已执行] ${m.filename}  (${prev.applied_at.toISOString()})${dirty}`);
    } else {
      console.log(`  [待执行] ${m.filename}`);
    }
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'up';

  try {
    switch (cmd) {
      case 'up':
        await migrateUp();
        break;
      case 'status':
        await migrateStatus();
        break;
      default:
        console.error(`未知命令：${cmd}\n用法：npm run migrate [up|status]`);
        process.exit(1);
    }
  } catch (err) {
    console.error('迁移失败：', err);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

main();
