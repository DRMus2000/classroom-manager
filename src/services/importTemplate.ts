/**
 * 导入文件的模板与上传检查。
 * 只接受扩展名为 xlsx、ZIP 魔数正确、且不超过 2MB 的文件。
 * 单元格若带公式，只读取已缓存的结果，不执行公式。
 */

import { AppError } from '../lib/errors.js';
import type { ImportTemplateKind } from '../lib/schema.js';

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const ROWS_SHEET = '名单';
const SEATMAP_SHEET = '座位表';
const HELP_SHEET = '说明';

export function importFileError(code: string, message: string): AppError {
  return new AppError('IMPORT_INVALID', '导入文件校验失败', {
    issues: [{ code, message, sheet: '', cell: null, row: null, student_no: null }],
  });
}

export function isUploadTooLarge(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = 'code' in err ? String((err as { code: unknown }).code) : '';
  const status = 'statusCode' in err ? (err as { statusCode: unknown }).statusCode : undefined;
  return code === 'FST_REQ_FILE_TOO_LARGE' || status === 413;
}

/** 取上传控件给出的文件名，丢掉目录。 */
export function uploadBaseName(filename: string): string {
  const trimmed = filename.trim();
  if (trimmed.includes('\0')) {
    throw importFileError('FILE_NAME', '文件名不合法');
  }
  const parts = trimmed.split(/[/\\]/);
  const base = (parts[parts.length - 1] ?? '').trim();
  if (!base || base.length > 255 || base === '.' || base === '..') {
    throw importFileError('FILE_NAME', '文件名不合法');
  }
  return base;
}

export function assertXlsxUpload(filename: string, buffer: Buffer): string {
  const base = uploadBaseName(filename);
  if (!base.toLowerCase().endsWith('.xlsx')) {
    throw importFileError('FILE_TYPE', '只接受 .xlsx 文件');
  }
  if (buffer.length === 0) {
    throw importFileError('FILE_EMPTY', '文件是空的');
  }
  if (buffer.length > MAX_IMPORT_BYTES) {
    throw importFileError('FILE_TOO_LARGE', '文件超过 2MB');
  }
  if (
    buffer.length < 4 ||
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x4b ||
    buffer[2] !== 0x03 ||
    buffer[3] !== 0x04
  ) {
    throw importFileError('FILE_TYPE', '文件内容不是 xlsx');
  }
  return base;
}

export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** 公式只取缓存结果。没有结果时当空值，避免把公式文本当成学号或姓名。 */
export function readCellText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  }
  if (typeof value !== 'object') return '';

  const record = value as Record<string, unknown>;
  if (Array.isArray(record['richText'])) {
    return record['richText']
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text ?? '') : ''))
      .join('')
      .trim();
  }
  if ('formula' in record || 'sharedFormula' in record) {
    return readCellText(record['result']);
  }
  if (typeof record['text'] === 'string') return record['text'].trim();
  return '';
}

export async function buildImportTemplate(
  kind: ImportTemplateKind,
): Promise<{ filename: string; body: Buffer }> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'classroom-manager';

  if (kind === 'rows') {
    const sheet = wb.addWorksheet(ROWS_SHEET);
    sheet.addRow(['学号', '姓名', '座位号', '备注']);
    sheet.getRow(1).font = { bold: true };
    sheet.columns = [{ width: 18 }, { width: 16 }, { width: 12 }, { width: 28 }];
    const help = wb.addWorksheet(HELP_SHEET);
    help.addRow(['请在「名单」表从第 2 行填写。列顺序固定为：学号、姓名、座位号、备注。']);
    help.addRow(['座位号填写当前显示编号，必须是已经存在的机位。空行会忽略。']);
    help.getColumn(1).width = 72;
    const body = Buffer.from(await wb.xlsx.writeBuffer());
    return { filename: '名单模板.xlsx', body };
  }

  const sheet = wb.addWorksheet(SEATMAP_SHEET);
  sheet.getCell('A1').note = '每个有人的机位填一个格子，例如：12号：20240101 张三';
  const help = wb.addWorksheet(HELP_SHEET);
  help.addRow(['在「座位表」里，每个有人的机位填写一个格子。']);
  help.addRow(['格式示例：12号：20240101 张三']);
  help.getColumn(1).width = 72;
  const body = Buffer.from(await wb.xlsx.writeBuffer());
  return { filename: '座位表模板.xlsx', body };
}

export async function detectImportKind(buffer: Buffer): Promise<ImportTemplateKind> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw importFileError('FILE_UNREADABLE', '无法读取 xlsx，文件可能已损坏');
  }
  const hasRows = wb.getWorksheet(ROWS_SHEET) != null;
  const hasSeatmap = wb.getWorksheet(SEATMAP_SHEET) != null;
  if (hasRows && hasSeatmap) {
    throw importFileError('AMBIGUOUS_TEMPLATE', '文件同时包含「名单」和「座位表」，请只保留一种模板');
  }
  if (hasRows) return 'rows';
  if (hasSeatmap) return 'seatmap';
  throw importFileError('SHEET_MISSING', '未找到工作表「名单」或「座位表」');
}
