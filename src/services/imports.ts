/**
 * 名单导入服务：解析 → 校验 → 预览 → 整体提交。
 *
 * 约定（第 2、3、60、61 项 / 第一阶段验收）：
 * - 两种固定模板：行表（学号/姓名/座位号/备注）、平面座位表（每个机位一个填写格）。
 * - 错误必须定位到工作表 + 单元格或行。
 * - 按班内学号更新已有学生，新学号新增；未出现在文件中的学生保留（积分与标记不动）。
 * - 以下情况阻止提交，且不产生部分写入：
 *     文件内重复学号（含姓名相同的重复行）/ 重复占座 / 座位不存在 / 超员 /
 *     与保留学生的座位冲突 / 匹配到停用学生 / 匹配到已匿名化学生 /
 *     存在无座在班学生（数据异常，不静默修复）
 * - 同学号改姓名允许，但预览必须高亮。
 * - preview_token 绑定内容哈希 + class.seat_version + TTL，提交时校验。
 */

import { withTx, type Db, db as defaultDb, sql } from '../repo/db.js';
import * as studentRepo from '../repo/student.js';
import * as classRepo from '../repo/class.js';
import * as layoutRepo from '../repo/layout.js';
import * as auditRepo from '../repo/audit.js';
import { Errors } from '../lib/errors.js';
import { withIdempotency } from './idempotency.js';
import { readCellText } from './importTemplate.js';
import { createHash } from 'node:crypto';
import type { ImportIssue, ImportChange, ImportPreviewDto, ImportTemplateKind } from '../lib/schema.js';

const PREVIEW_TTL_MS = 15 * 60 * 1000; // 15 分钟

interface ParsedRow {
  sheet: string;
  row: number | null;
  cell: string | null;
  student_no: string;
  name: string;
  seat_number: number | null;
  remark: string | null;
}

interface PreviewPayload {
  token: string;
  classId: string;
  kind: ImportTemplateKind;
  expiresAt: number;
  contentHash: string;
  seatVersion: number;
}

/**
 * 预览令牌：绑定内容哈希 + 班级座次版本 + TTL。
 * 内存存储足够（单进程部署，且 TTL 只有 15 分钟）。
 */
const previews = new Map<string, PreviewPayload>();

function cleanupPreviews(): void {
  const now = Date.now();
  for (const [k, v] of previews) {
    if (v.expiresAt < now) previews.delete(k);
  }
}

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

/**
 * 解析工作簿为结构化行。
 *
 * 只读取单元格的「值」（v），不读取也不计算公式 —— 既避免执行恶意公式，
 * 也符合"上传校验"的安全要求。
 *
 * 行表格式（sheet 名 "名单"）：表头行 + 数据行，列为 学号 | 姓名 | 座位号 | 备注
 * 平面表格式（sheet 名 "座位表"）：每个机位一个格子，形如 "1号：20240101 张三"
 */
export async function parseWorkbook(
  buffer: Buffer,
  kind: ImportTemplateKind,
): Promise<{ rows: ParsedRow[]; issues: ImportIssue[] }> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);

  const rows: ParsedRow[] = [];
  const issues: ImportIssue[] = [];

  if (kind === 'rows') {
    const ws = wb.getWorksheet('名单');
    if (!ws) {
      issues.push({
        severity: 'error',
        code: 'SHEET_MISSING',
        message: '未找到工作表「名单」',
        sheet: '名单',
        cell: null,
        row: null,
        student_no: null,
      });
      return { rows, issues };
    }

    // 表头在第 1 行，数据从第 2 行起
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;

      const studentNo = readCellText(row.getCell(1).value);
      const name = readCellText(row.getCell(2).value);
      const seatRaw = readCellText(row.getCell(3).value);
      const remark = readCellText(row.getCell(4).value);

      // 整行为空 → 跳过。公式没有缓存结果时也视为空，不把公式文本写入学号。
      if (!studentNo && !name && !seatRaw) return;

      let seatNumber: number | null = null;
      if (seatRaw !== '') {
        const n = Number(seatRaw);
        if (!Number.isInteger(n) || n <= 0) {
          issues.push({
            severity: 'error',
            code: 'SEAT_INVALID',
            message: `座位号「${seatRaw}」不是有效的正整数`,
            sheet: ws.name,
            cell: `C${rowNumber}`,
            row: rowNumber,
            student_no: studentNo || null,
          });
        } else {
          seatNumber = n;
        }
      }

      if (!studentNo) {
        issues.push({
          severity: 'error',
          code: 'STUDENT_NO_MISSING',
          message: '学号不能为空',
          sheet: ws.name,
          cell: `A${rowNumber}`,
          row: rowNumber,
          student_no: null,
        });
      }
      if (!name) {
        issues.push({
          severity: 'error',
          code: 'NAME_MISSING',
          message: '姓名不能为空',
          sheet: ws.name,
          cell: `B${rowNumber}`,
          row: rowNumber,
          student_no: studentNo || null,
        });
      }

      rows.push({
        sheet: ws.name,
        row: rowNumber,
        cell: null,
        student_no: studentNo,
        name,
        seat_number: seatNumber,
        remark: remark || null,
      });
    });
  } else {
    // 平面座位表：每个机位一个格子，内容形如 "20240101 张三"
    const ws = wb.getWorksheet('座位表');
    if (!ws) {
      issues.push({
        severity: 'error',
        code: 'SHEET_MISSING',
        message: '未找到工作表「座位表」',
        sheet: '座位表',
        cell: null,
        row: null,
        student_no: null,
      });
      return { rows, issues };
    }

    ws.eachRow((row, rowNumber) => {
      row.eachCell((cell, colNumber) => {
        const raw = readCellText(cell.value);
        if (!raw) return;

        // 期望格式： "<座位号>号:<学号> <姓名>" 或 "<学号> <姓名>"（座位号从表头解析）
        const m = raw.match(/^(\d+)\s*号\s*[:：]\s*(\S+)\s+(.+)$/);
        let seatNumber: number | null = null;
        let studentNo = '';
        let name = '';

        if (m) {
          seatNumber = Number(m[1]);
          studentNo = m[2]!;
          name = m[3]!.trim();
        } else {
          const parts = raw.split(/\s+/);
          if (parts.length < 2) {
            issues.push({
              severity: 'error',
              code: 'CELL_FORMAT',
              message: `单元格格式无法识别（应形如「12号：20240101 张三」）`,
              sheet: ws.name,
              cell: cell.address,
              row: rowNumber,
              student_no: null,
            });
            return;
          }
          studentNo = parts[0]!;
          name = parts.slice(1).join(' ');
        }

        rows.push({
          sheet: ws.name,
          row: rowNumber,
          cell: cell.address,
          student_no: studentNo,
          name,
          seat_number: seatNumber,
          remark: null,
        });
      });
    });
  }

  return { rows, issues };
}

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

export async function buildPreview(
  classId: string,
  kind: ImportTemplateKind,
  buffer: Buffer,
  db: Db = defaultDb,
): Promise<ImportPreviewDto> {
  const cls = await classRepo.findClass(db, classId);
  if (!cls) throw Errors.notFound('班级', classId);

  const { rows, issues } = await parseWorkbook(buffer, kind);
  const allIssues: ImportIssue[] = [...issues];

  const [existing, slots, totalSlots] = await Promise.all([
    studentRepo.listStudents(db, classId, { status: 'all' }),
    layoutRepo.listSlots(db),
    studentRepo.countSlots(db),
  ]);

  const byNo = new Map(existing.map((s) => [s.student_no, s]));
  const slotByNumber = new Map(
    slots.filter((s) => s.seat_number != null).map((s) => [s.seat_number!, s]),
  );

  // —— 文件内重复学号（含姓名相同的重复行）
  const seenNo = new Map<string, number>();
  for (const r of rows) {
    if (!r.student_no) continue;
    const prev = seenNo.get(r.student_no);
    if (prev != null) {
      allIssues.push({
        severity: 'error',
        code: 'DUPLICATE_STUDENT_NO',
        message: `学号「${r.student_no}」在文件内重复出现（第 ${prev} 行与之重复）`,
        sheet: r.sheet,
        cell: r.cell,
        row: r.row,
        student_no: r.student_no,
      });
    } else {
      seenNo.set(r.student_no, r.row ?? 0);
    }
  }

  // —— 文件内重复占座
  const seenSeat = new Map<number, string>();
  for (const r of rows) {
    if (r.seat_number == null) continue;
    const prev = seenSeat.get(r.seat_number);
    if (prev != null) {
      allIssues.push({
        severity: 'error',
        code: 'DUPLICATE_SEAT',
        message: `座位号 ${r.seat_number} 被多个学生占用（与学号 ${prev} 冲突）`,
        sheet: r.sheet,
        cell: r.cell,
        row: r.row,
        student_no: r.student_no,
      });
    } else {
      seenSeat.set(r.seat_number, r.student_no);
    }
  }

  // —— 逻辑冲突检查 + 变更集构建
  const changes: ImportChange[] = [];
  const touchedSeats = new Map<number, string>(); // seat_number → student_no
  const rowsByNo = new Map<string, ParsedRow>();
  for (const r of rows) if (r.student_no) rowsByNo.set(r.student_no, r);

  for (const r of rows) {
    if (!r.student_no) continue;

    // 座位不存在
    if (r.seat_number != null && !slotByNumber.has(r.seat_number)) {
      allIssues.push({
        severity: 'error',
        code: 'SEAT_NOT_FOUND',
        message: `座位号 ${r.seat_number} 不存在（可能已被删除，编号不会复用）`,
        sheet: r.sheet,
        cell: r.cell,
        row: r.row,
        student_no: r.student_no,
      });
      continue;
    }

    const existingStudent = byNo.get(r.student_no);

    if (existingStudent) {
      // 匹配到停用学生 → 提示先恢复并安排座位，不自动恢复或另建身份
      if (existingStudent.status === 'left') {
        allIssues.push({
          severity: 'error',
          code: 'STUDENT_LEFT',
          message: `学号「${r.student_no}」对应的学生「${existingStudent.name}」已离班，请先在学生管理中恢复并安排座位`,
          sheet: r.sheet,
          cell: r.cell,
          row: r.row,
          student_no: r.student_no,
        });
        continue;
      }
      if (existingStudent.status === 'anonymized') {
        allIssues.push({
          severity: 'error',
          code: 'STUDENT_ANONYMIZED',
          message: `学号「${r.student_no}」属于已匿名化学生，身份不可逆，不允许重新认领`,
          sheet: r.sheet,
          cell: r.cell,
          row: r.row,
          student_no: r.student_no,
        });
        continue;
      }

      // 同学号改姓名 → 允许，但预览高亮
      const nameChanged = existingStudent.name !== r.name;
      if (nameChanged) {
        allIssues.push({
          severity: 'warning',
          code: 'NAME_CHANGED',
          message: `学号「${r.student_no}」姓名由「${existingStudent.name}」改为「${r.name}」`,
          sheet: r.sheet,
          cell: r.cell,
          row: r.row,
          student_no: r.student_no,
        });
      }

      const currentSeat = await studentRepo.findStudentSeat(db, classId, existingStudent.student_id);
      const toSeatNumber = r.seat_number ?? currentSeat?.seat_number ?? null;

      if (r.seat_number != null) touchedSeats.set(r.seat_number, r.student_no);

      changes.push({
        kind: 'update',
        student_no: r.student_no,
        name: r.name,
        student_id: existingStudent.student_id,
        from_seat_number: currentSeat?.seat_number ?? null,
        to_seat_number: toSeatNumber,
        name_changed: nameChanged,
      });
    } else {
      // 新增
      if (r.seat_number == null) {
        allIssues.push({
          severity: 'error',
          code: 'SEAT_REQUIRED',
          message: `新增学生「${r.name}」必须指定座位号`,
          sheet: r.sheet,
          cell: r.cell,
          row: r.row,
          student_no: r.student_no,
        });
        continue;
      }
      touchedSeats.set(r.seat_number, r.student_no);

      changes.push({
        kind: 'create',
        student_no: r.student_no,
        name: r.name,
        student_id: null,
        from_seat_number: null,
        to_seat_number: r.seat_number,
        name_changed: false,
      });
    }
  }

  // —— 与"保留学生"的座位冲突：未出现在文件中、但座位被文件里别人占用的在班学生
  for (const s of existing) {
    if (s.status !== 'active') continue;
    if (rowsByNo.has(s.student_no)) continue; // 出现在文件中，已在上面处理

    const seat = await studentRepo.findStudentSeat(db, classId, s.student_id);
    if (seat?.seat_number != null && seenSeat.has(seat.seat_number)) {
      allIssues.push({
        severity: 'error',
        code: 'SEAT_CONFLICT_WITH_KEPT',
        message: `保留学生「${s.name}」（学号 ${s.student_no}）占用座位 ${seat.seat_number}，但该座位在文件中被分配给学号 ${seenSeat.get(seat.seat_number)}`,
        sheet: rows[0]?.sheet ?? '',
        cell: null,
        row: null,
        student_no: s.student_no,
      });
    }

    changes.push({
      kind: 'keep',
      student_no: s.student_no,
      name: s.name,
      student_id: s.student_id,
      from_seat_number: seat?.seat_number ?? null,
      to_seat_number: seat?.seat_number ?? null,
      name_changed: false,
    });
  }

  // —— 超员检查
  const creates = changes.filter((c) => c.kind === 'create').length;
  const activeCount = existing.filter((s) => s.status === 'active').length;
  const projectedTotal = activeCount + creates;

  if (projectedTotal > totalSlots) {
    allIssues.push({
      severity: 'error',
      code: 'OVER_CAPACITY',
      message: `导入后将达到 ${projectedTotal} 名在班学生，超过现有 ${totalSlots} 个机位。请先增加座位。`,
      sheet: '',
      cell: null,
      row: null,
      student_no: null,
    });
  }

  // —— 数据异常：存在无座在班学生 → 阻止提交，不静默修复
  const blockers: { code: any; message: string }[] = [];
  const noSeat = await studentRepo.studentsWithoutSeat(db, classId);
  if (noSeat.length > 0) {
    blockers.push({
      code: 'STUDENT_NO_SEAT',
      message: `存在 ${noSeat.length} 名无座在班学生（${noSeat
        .slice(0, 5)
        .map((s) => s.name)
        .join('、')}${noSeat.length > 5 ? ' 等' : ''}）。这是数据异常，请先通过座位修复入口处理，再导入。`,
    });
  }

  // —— 生成预览令牌
  cleanupPreviews();
  const contentHash = createHash('sha256').update(buffer).digest('hex');
  const token = createHash('sha256')
    .update(`${cls.class_id}:${contentHash}:${cls.seat_version}:${Date.now()}`)
    .digest('hex');

  previews.set(token, {
    token,
    classId,
    kind,
    expiresAt: Date.now() + PREVIEW_TTL_MS,
    contentHash,
    seatVersion: cls.seat_version,
  });

  const errorCount = allIssues.filter((i) => i.severity === 'error').length;
  const warnCount = allIssues.filter((i) => i.severity === 'warning').length;

  return {
    preview_token: token,
    template_kind: kind,
    issues: allIssues,
    changes,
    summary: {
      create: creates,
      update: changes.filter((c) => c.kind === 'update').length,
      keep: changes.filter((c) => c.kind === 'keep').length,
      seat_changes: changes.filter(
        (c) => c.kind === 'update' && c.from_seat_number !== c.to_seat_number,
      ).length,
      errors: errorCount,
      warnings: warnCount,
    },
    committable: errorCount === 0 && blockers.length === 0,
    blockers,
  };
}

/* ------------------------------------------------------------------ */
/* 提交                                                                */
/* ------------------------------------------------------------------ */

export async function commitImport(
  actorId: string,
  classId: string,
  previewToken: string,
  expectedVersion: number,
  requestId: string,
  db: Db = defaultDb,
): Promise<{ created: number; updated: number; kept: number; seat_version: number }> {
  cleanupPreviews();

  const outcome = await withTx(db, async (tx) => {
    return withIdempotency(
      tx,
      requestId,
      `POST /api/v1/classes/${classId}/import/commit`,
      { preview_token: previewToken, expected_version: expectedVersion, request_id: requestId },
      async () => {
        const payload = previews.get(previewToken);
        if (!payload || payload.classId !== classId) {
          throw Errors.importTokenExpired('预览令牌无效或已过期，请重新上传文件预览');
        }
        if (payload.expiresAt < Date.now()) {
          previews.delete(previewToken);
          throw Errors.importTokenExpired();
        }

    const cls = await classRepo.lockClass(tx, classId);
    if (!cls) throw Errors.notFound('班级', classId);

    // 预览后座次被改动 → 拒绝，要求重新预览
    if (cls.seat_version !== payload.seatVersion) {
      throw Errors.importTokenExpired('班级座次在预览后已被修改，请重新预览');
    }
    if (cls.seat_version !== expectedVersion) {
      throw Errors.versionConflict(
        `班级座次版本已变更（当前 ${cls.seat_version}，提交 ${expectedVersion}），请载入最新状态`,
      );
    }

    const term = await classRepo.currentTerm(tx);
    if (!term) throw Errors.notFound('当前学期');

    // 重放变更集（令牌里只存了哈希，这里用重新构建的方式保持幂等 —— 变更内容
    // 由 previews 中没有保留，故提交时要求客户端传回的内容必须与预览一致；
    // 简化实现：以预览时记录的 classId + 版本为准，重新读取内存中的变更集。）
    const changeSet = payloadChangeSets.get(previewToken);
    if (!changeSet) {
      throw Errors.importTokenExpired('预览数据已失效，请重新上传');
    }

    let created = 0;
    let updated = 0;
    let kept = 0;
    const createdStudentIds: string[] = [];

    const slots = await layoutRepo.listSlots(tx);
    const slotByNumber = new Map(
      slots.filter((s) => s.seat_number != null).map((s) => [s.seat_number!, s]),
    );

    // 第一步：先释放所有将被重新安置的学生的座位，避免唯一约束冲突
    for (const c of changeSet) {
      if (c.kind === 'update' && c.to_seat_number !== c.from_seat_number && c.student_id) {
        await studentRepo.releaseStudentSeat(tx, classId, c.student_id);
      }
    }

    // 第二步：新增 / 更新
    for (const c of changeSet) {
      if (c.kind === 'create') {
        const seat = c.to_seat_number != null ? slotByNumber.get(c.to_seat_number) : undefined;
        if (!seat) {
          throw Errors.importInvalid([
            { code: 'SEAT_NOT_FOUND', message: `座位号 ${c.to_seat_number} 不存在` },
          ]);
        }

        const s = await studentRepo.createStudent(tx, {
          class_id: classId,
          student_no: c.student_no,
          name: c.name,
          remark: null,
        });
        await studentRepo.assignSeat(tx, classId, seat.seat_id, s.student_id, term.term_id);
        await classRepo.ensureBalanceRow(tx, term.term_id, s.student_id);
        createdStudentIds.push(s.student_id);
        created++;
      } else if (c.kind === 'update' && c.student_id) {
        await studentRepo.updateStudent(tx, c.student_id, { name: c.name });

        if (c.to_seat_number != null && c.to_seat_number !== c.from_seat_number) {
          const seat = slotByNumber.get(c.to_seat_number);
          if (!seat) {
            throw Errors.importInvalid([
              { code: 'SEAT_NOT_FOUND', message: `座位号 ${c.to_seat_number} 不存在` },
            ]);
          }
          await studentRepo.assignSeat(tx, classId, seat.seat_id, c.student_id, term.term_id);
        }
        updated++;
      } else if (c.kind === 'keep') {
        kept++;
      }
    }

    const newVersion = await classRepo.bumpSeatVersion(tx, classId);

    await auditRepo.writeAudit(tx, {
      actor: actorId,
      entity: 'import',
      entity_id: classId,
      action: 'committed',
      after: { created, updated, kept, seat_version: newVersion },
      request_id: requestId,
    });

    await auditRepo.writeEvent(tx, {
      class_id: classId,
      kind: 'roster_changed',
      payload: {
        class_id: classId,
        action: 'import_committed',
        created,
        updated,
        kept,
        created_student_ids: createdStudentIds,
      },
    });

        return {
          statusCode: 200,
          body: { created, updated, kept, seat_version: newVersion },
        };
      },
    );
  });

  if (!outcome.fromCache) {
    previews.delete(previewToken);
    payloadChangeSets.delete(previewToken);
  }

  return outcome.body;
}

/**
 * 预览变更集（内存保存，与 token 同生命周期）。
 * 与 previews 分开存放，便于阅读：previews 存令牌元数据，这里存内容。
 */
const payloadChangeSets = new Map<string, ImportChange[]>();

export async function buildPreviewWithChangeSet(
  classId: string,
  kind: ImportTemplateKind,
  buffer: Buffer,
  db: Db = defaultDb,
): Promise<ImportPreviewDto> {
  const preview = await buildPreview(classId, kind, buffer, db);
  payloadChangeSets.set(preview.preview_token, preview.changes);
  return preview;
}
