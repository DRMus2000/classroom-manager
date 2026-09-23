/**
 * 两份导入模板、上传边界，以及预览/提交路由已挂上。
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { AppError } from '../src/lib/errors.js';
import { importCommitResult, importTemplateQuery } from '../src/lib/schema.js';
import {
  MAX_IMPORT_BYTES,
  assertXlsxUpload,
  buildImportTemplate,
  contentDisposition,
  detectImportKind,
  readCellText,
} from '../src/services/importTemplate.js';

const CLASS_ID = '8f2c0000-0000-4000-8000-000000000010';

describe('import templates', () => {
  it('行表只有表头，座位表是空格子，说明页不参与识别', async () => {
    const rows = await buildImportTemplate('rows');
    const seatmap = await buildImportTemplate('seatmap');
    assert.equal(rows.filename, '名单模板.xlsx');
    assert.equal(seatmap.filename, '座位表模板.xlsx');
    assert.equal(rows.body[0], 0x50);
    assert.equal(rows.body[1], 0x4b);
    assert.ok(rows.body.length < MAX_IMPORT_BYTES);
    assert.equal(await detectImportKind(rows.body), 'rows');
    assert.equal(await detectImportKind(seatmap.body), 'seatmap');
    assert.match(contentDisposition(rows.filename), /filename\*=UTF-8''/);
    assert.match(contentDisposition(rows.filename), /filename="[^"]+"/);
  });

  it('空模板解析后没有数据行', async () => {
    process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
    const { parseWorkbook } = await import('../src/services/imports.js');
    const rows = await buildImportTemplate('rows');
    const seatmap = await buildImportTemplate('seatmap');
    const parsedRows = await parseWorkbook(rows.body, 'rows');
    const parsedSeats = await parseWorkbook(seatmap.body, 'seatmap');
    assert.deepEqual(parsedRows.rows, []);
    assert.deepEqual(parsedRows.issues, []);
    assert.deepEqual(parsedSeats.rows, []);
    assert.deepEqual(parsedSeats.issues, []);
  });

  it('填好的两份模板能读回学号、姓名和座位号', async () => {
    process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
    const ExcelJS = (await import('exceljs')).default;
    const { parseWorkbook } = await import('../src/services/imports.js');

    const rowsFile = await buildImportTemplate('rows');
    const rowsBook = new ExcelJS.Workbook();
    await rowsBook.xlsx.load(rowsFile.body);
    rowsBook.getWorksheet('名单')!.addRow(['202401', '张三', 12, '备注']);
    const rowsBuffer = Buffer.from(await rowsBook.xlsx.writeBuffer());
    const parsedRows = await parseWorkbook(rowsBuffer, 'rows');
    assert.equal(parsedRows.issues.length, 0);
    assert.deepEqual(parsedRows.rows[0], {
      sheet: '名单',
      row: 2,
      cell: null,
      student_no: '202401',
      name: '张三',
      seat_number: 12,
      remark: '备注',
    });

    const seatFile = await buildImportTemplate('seatmap');
    const seatBook = new ExcelJS.Workbook();
    await seatBook.xlsx.load(seatFile.body);
    seatBook.getWorksheet('座位表')!.getCell('B3').value = '12号：20240101 张三';
    const seatBuffer = Buffer.from(await seatBook.xlsx.writeBuffer());
    const parsedSeats = await parseWorkbook(seatBuffer, 'seatmap');
    assert.equal(parsedSeats.issues.length, 0);
    assert.equal(parsedSeats.rows.length, 1);
    assert.equal(parsedSeats.rows[0]!.student_no, '20240101');
    assert.equal(parsedSeats.rows[0]!.name, '张三');
    assert.equal(parsedSeats.rows[0]!.seat_number, 12);
    assert.equal(parsedSeats.rows[0]!.cell, 'B3');
  });

  it('公式只读取缓存结果，没有结果时不当成学号', async () => {
    assert.equal(readCellText({ formula: 'A1', result: '202401' }), '202401');
    assert.equal(readCellText({ formula: '1+1' }), '');
    assert.equal(readCellText({ richText: [{ text: '张' }, { text: '三' }] }), '张三');
    assert.equal(readCellText({ text: '备注', hyperlink: 'https://example.test' }), '备注');
    assert.equal(readCellText(new Date('not-a-date')), '');

    process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
    const ExcelJS = (await import('exceljs')).default;
    const { parseWorkbook } = await import('../src/services/imports.js');
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('名单');
    sheet.addRow(['学号', '姓名', '座位号', '备注']);
    sheet.getCell('A2').value = { formula: 'CONCAT("20","2401")', result: '202401' };
    sheet.getCell('B2').value = '张三';
    sheet.getCell('C2').value = { formula: '6+6', result: 12 };
    const buffer = Buffer.from(await book.xlsx.writeBuffer());
    const parsed = await parseWorkbook(buffer, 'rows');
    assert.equal(parsed.rows[0]?.student_no, '202401');
    assert.equal(parsed.rows[0]?.name, '张三');
    assert.equal(parsed.rows[0]?.seat_number, 12);
    assert.equal(parsed.rows[0]?.student_no.includes('CONCAT'), false);
  });

  it('缺少指定工作表、两种模板混在一起、损坏的压缩包都会拒绝', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const both = new ExcelJS.Workbook();
    both.addWorksheet('名单');
    both.addWorksheet('座位表');
    const bothBuffer = Buffer.from(await both.xlsx.writeBuffer());
    await assert.rejects(detectImportKind(bothBuffer), (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'IMPORT_INVALID');
      return true;
    });

    const other = new ExcelJS.Workbook();
    other.addWorksheet('Sheet1');
    await assert.rejects(detectImportKind(Buffer.from(await other.xlsx.writeBuffer())), (err: unknown) => {
      assert.ok(err instanceof AppError);
      const issues = (err.details as { issues: { code: string }[] }).issues;
      assert.equal(issues[0]?.code, 'SHEET_MISSING');
      return true;
    });

    const broken = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 3]);
    await assert.rejects(detectImportKind(broken), (err: unknown) => {
      assert.ok(err instanceof AppError);
      const issues = (err.details as { issues: { code: string }[] }).issues;
      assert.equal(issues[0]?.code, 'FILE_UNREADABLE');
      return true;
    });
  });
});

describe('xlsx upload guard', () => {
  it('接受正好 2MB 的 xlsx 魔数，拒绝空文件、超限、错扩展名和伪 xlsx', () => {
    const atLimit = Buffer.alloc(MAX_IMPORT_BYTES);
    atLimit[0] = 0x50;
    atLimit[1] = 0x4b;
    atLimit[2] = 0x03;
    atLimit[3] = 0x04;
    assert.equal(assertXlsxUpload('C:\\fakepath\\名单.XLSX', atLimit), '名单.XLSX');

    const tooBig = Buffer.alloc(MAX_IMPORT_BYTES + 1);
    tooBig[0] = 0x50;
    tooBig[1] = 0x4b;
    tooBig[2] = 0x03;
    tooBig[3] = 0x04;
    const cases: Array<[string, Buffer, string]> = [
      ['', atLimit, 'FILE_NAME'],
      ['..', atLimit, 'FILE_NAME'],
      ['a.xlsx\0.exe', atLimit, 'FILE_NAME'],
      ['x'.repeat(256) + '.xlsx', atLimit, 'FILE_NAME'],
      ['名单.csv', atLimit, 'FILE_TYPE'],
      ['名单.xlsx.txt', atLimit, 'FILE_TYPE'],
      ['名单.xlsx', Buffer.alloc(0), 'FILE_EMPTY'],
      ['名单.xlsx', tooBig, 'FILE_TOO_LARGE'],
      ['名单.xlsx', Buffer.from('<html></html>'), 'FILE_TYPE'],
      ['名单.xlsx', Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), 'FILE_TYPE'],
    ];
    for (const [name, body, code] of cases) {
      assert.throws(
        () => assertXlsxUpload(name, body),
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.code, 'IMPORT_INVALID');
          assert.equal(err.httpStatus, 422);
          const issues = (err.details as { issues: { code: string }[] }).issues;
          assert.equal(issues[0]?.code, code);
          return true;
        },
      );
    }
  });

  it('kind 只接受 rows 和 seatmap，提交响应字段固定', () => {
    assert.equal(importTemplateQuery.parse({ kind: 'rows' }).kind, 'rows');
    assert.equal(importTemplateQuery.parse({ kind: 'seatmap' }).kind, 'seatmap');
    assert.equal(importTemplateQuery.safeParse({}).success, false);
    assert.equal(importTemplateQuery.safeParse({ kind: 'csv' }).success, false);
    assert.equal(importTemplateQuery.safeParse({ kind: '' }).success, false);
    const parsed = importCommitResult.parse({
      seat_version: 4,
      applied: { create: 1, update: 2 },
    });
    assert.deepEqual(parsed, { seat_version: 4, applied: { create: 1, update: 2 } });
  });
});

describe('import routes', () => {
  after(async () => {
    const { closeDb } = await import('../src/repo/db.js');
    await closeDb();
  });

  it('未登录不能下载模板、预览或提交', async () => {
    process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
    const { buildServer } = await import('../src/server.js');
    const app = await buildServer();
    try {
      const template = await app.inject({
        method: 'GET',
        url: `/api/v1/classes/${CLASS_ID}/import/template?kind=rows`,
      });
      const preview = await app.inject({
        method: 'POST',
        url: `/api/v1/classes/${CLASS_ID}/import/preview`,
      });
      const commit = await app.inject({
        method: 'POST',
        url: `/api/v1/classes/${CLASS_ID}/import/commit`,
        payload: {},
      });
      assert.equal(template.statusCode, 401);
      assert.equal(preview.statusCode, 401);
      assert.equal(commit.statusCode, 401);
      assert.equal(template.json().error.code, 'UNAUTHENTICATED');
    } finally {
      await app.close();
    }
  });
});
