/**
 * Excel 导出。花名册使用可再次导入的行表。
 * 积分明细和榜单走与列表相同的筛选，避免两套条件。
 */

import type { ListEntriesQuery } from '../lib/schema.js';
import { Errors } from '../lib/errors.js';
import { type Db, db as defaultDb } from '../repo/db.js';
import * as classRepo from '../repo/class.js';
import * as studentRepo from '../repo/student.js';
import * as pointsRepo from '../repo/points.js';
import { entryFilterFromQuery, listLeaderboard } from './points.js';

const EXPORT_PAGE = 200;
const EXPORT_CAP = 20_000;

export interface WorkbookFile {
  filename: string;
  body: Buffer;
}

async function workbook(sheetName: string, headers: string[], rows: (string | number | null)[][]): Promise<Buffer> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'classroom-manager';
  const sheet = wb.addWorksheet(sheetName);
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true };
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function reasonName(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== 'object') return '';
  const name = (snapshot as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

export async function exportRoster(classId: string, db: Db = defaultDb): Promise<WorkbookFile> {
  const cls = await classRepo.findClass(db, classId);
  if (!cls) throw Errors.notFound('班级', classId);
  const students = await studentRepo.listActiveStudentsWithSeats(db, classId);
  const rows = students
    .slice()
    .sort((a, b) => {
      const seatA = a.seat?.seat_number ?? Number.MAX_SAFE_INTEGER;
      const seatB = b.seat?.seat_number ?? Number.MAX_SAFE_INTEGER;
      if (seatA !== seatB) return seatA - seatB;
      return a.student_no.localeCompare(b.student_no, 'zh');
    })
    .map((student) => [
      student.student_no,
      student.name,
      student.seat?.seat_number ?? null,
      student.remark ?? '',
    ]);
  const body = await workbook('名单', ['学号', '姓名', '座位号', '备注'], rows);
  return { filename: `${cls.name}-花名册.xlsx`, body };
}

export async function exportPoints(query: ListEntriesQuery, db: Db = defaultDb): Promise<WorkbookFile> {
  const filter = entryFilterFromQuery(query);
  const rows: (string | number | null)[][] = [];
  let cursor = filter.cursor_seq;
  for (;;) {
    const page = await pointsRepo.listEntries(db, {
      ...filter,
      cursor_seq: cursor,
      limit: EXPORT_PAGE,
    });
    for (const entry of page) {
      const named = entry as pointsRepo.EntryRow & { student_name?: string | null };
      rows.push([
        Number(entry.seq),
        iso(entry.occurred_at),
        named.student_name ?? '',
        Number(entry.delta),
        Number(entry.balance_after),
        entry.status,
        entry.seat_number_snapshot == null ? null : Number(entry.seat_number_snapshot),
        reasonName(entry.reason_snapshot),
        entry.note ?? '',
      ]);
    }
    if (rows.length > EXPORT_CAP) throw Errors.forbidden('导出结果超过 20000 行，请缩小筛选范围');
    if (page.length < EXPORT_PAGE) break;
    const last = page[page.length - 1];
    if (!last) break;
    cursor = Number(last.seq);
  }
  const body = await workbook(
    '积分明细',
    ['序号', '时间', '姓名', '分值', '余额', '状态', '座位号', '原因', '备注'],
    rows,
  );
  return { filename: '积分明细.xlsx', body };
}

export async function exportLeaderboard(
  termId: string,
  classId: string | undefined,
  db: Db = defaultDb,
): Promise<WorkbookFile> {
  const term = await classRepo.findTerm(db, termId);
  if (!term) throw Errors.notFound('学期', termId);
  if (classId) {
    const cls = await classRepo.findClass(db, classId);
    if (!cls) throw Errors.notFound('班级', classId);
  }
  const items = await listLeaderboard(termId, classId, db);
  if (items.length > EXPORT_CAP) throw Errors.forbidden('导出结果超过 20000 行，请缩小筛选范围');
  const rows = items.map((item) => [item.rank, item.class_name, item.student_no, item.name, item.balance]);
  const body = await workbook('排行榜', ['名次', '班级', '学号', '姓名', '积分'], rows);
  return { filename: '排行榜.xlsx', body };
}
