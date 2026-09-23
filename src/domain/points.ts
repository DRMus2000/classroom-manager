/**
 * 积分领域逻辑：余额计算、撤销资格判定、并列破序。
 *
 * 关键口径（已确认）：
 * - 余额 = 账本累加的可校验快照，与账本同事务维护。
 * - 撤销：生成反向记录，原记录永不改写。已撤销明细不得再次冲销（物理层唯一索引保证）。
 * - 部分撤销后整批撤销（Q2 方案 a）：只冲销 status='effective' 的明细。
 * - 并列破序：same balance → 按 last_change_seq（最近一次积分变化的序号）→ 班级 + 学号。
 *   口径 = 最近一次积分变化，不是历史上首次达到当前分数。
 */

import type { EntryStatus, Polarity } from '../lib/schema.js';

export interface PointEntry {
  entry_id: string;
  student_id: string;
  delta: number;
  balance_after: number;
  status: EntryStatus;
  reverses_entry_id: string | null;
  reversed_by_entry_id: string | null;
  seq: number;
}

export interface PointBatch {
  batch_id: string;
  delta_value: number;
  member_count: number;
  kind: 'score' | 'reversal';
  reverses_batch_id: string | null;
  partial_reversed: boolean;
  entries: PointEntry[];
}

/**
 * 计算学生当前余额（从账本全量重放）。
 * 用于 recompute-balance 维护命令的校验。
 */
export function computeBalance(entries: PointEntry[]): number {
  return entries
    .filter((e) => e.status === 'effective')
    .reduce((sum, e) => sum + e.delta, 0);
}

/**
 * 并列破序序号是批次对应的回放事件序号，不是逐条明细的 seq。
 */
export function tieBreakSeq(eventSeq: number): number {
  return eventSeq;
}

/**
 * 判定批次是否可整批撤销（Q2 方案 a）。
 * 只要存在 status='effective' 的明细即可撤销（部分撤销后仍可整批撤销剩余）。
 */
export function canReverseBatch(batch: PointBatch): {
  reversible: boolean;
  effective_count: number;
  already_reversed_count: number;
} {
  const effective = batch.entries.filter((e) => e.status === 'effective');
  const reversed = batch.entries.filter((e) => e.status === 'reversed');
  return {
    reversible: effective.length > 0,
    effective_count: effective.length,
    already_reversed_count: reversed.length,
  };
}

/**
 * 判定单条明细是否可撤销。
 * 已撤销（status='reversed'）的明细不得再次冲销。
 */
export function canReverseEntry(entry: PointEntry): { reversible: boolean; reason?: string } {
  if (entry.status === 'reversed') {
    return { reversible: false, reason: '该明细已被冲销' };
  }
  if (entry.reversed_by_entry_id) {
    return { reversible: false, reason: '该明细已被另一条记录冲销' };
  }
  return { reversible: true };
}

/**
 * 并列排名比较器（用于 ORDER BY）。
 * 口径：balance DESC, last_change_seq ASC, 班级名, 学号。
 *
 * last_change_seq 是该批次的回放事件序号。同一批次的人序号相同，
 * 再按班级名和学号稳定排序。序号越小表示越早达到当前分数。
 */
export function compareRank(
  a: {
    balance: number;
    last_change_seq: number;
    class_name: string;
    student_no: string;
  },
  b: {
    balance: number;
    last_change_seq: number;
    class_name: string;
    student_no: string;
  },
): number {
  if (a.balance !== b.balance) return b.balance - a.balance;
  if (a.last_change_seq !== b.last_change_seq) return a.last_change_seq - b.last_change_seq;
  if (a.class_name !== b.class_name) return a.class_name.localeCompare(b.class_name, 'zh');
  return a.student_no.localeCompare(b.student_no);
}

/**
 * 计算并列名次（1, 1, 3 格式）。
 *
 * @param items 已按 compareRank 排序的学生列表
 * @returns 每人的名次（从 1 起）
 */
export function assignRanks<T extends { balance: number; last_change_seq: number }>(
  items: T[],
): (T & { rank: number })[] {
  if (items.length === 0) return [];

  const result: (T & { rank: number })[] = [];
  let currentRank = 1;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;

    if (i > 0) {
      const prev = items[i - 1]!;
      // 分数或 last_change_seq 不同 → 名次跳跃
      if (item.balance !== prev.balance || item.last_change_seq !== prev.last_change_seq) {
        currentRank = i + 1;
      }
    }

    result.push({ ...item, rank: currentRank });
  }

  return result;
}

/**
 * 校验加减分是否与模板方向一致（第 68 行：当次可改大小，不能反转方向）。
 */
export function validateDeltaPolarity(delta: number, polarity: Polarity): boolean {
  const deltaSign = delta > 0 ? 1 : delta < 0 ? -1 : 0;
  return deltaSign === polarity;
}

/**
 * 撤销批次的元数据生成：返回反向批次的 delta_value 与 kind。
 */
export function makeReversalMeta(original: PointBatch): {
  delta_value: number;
  kind: 'reversal';
  reverses_batch_id: string;
} {
  return {
    delta_value: -original.delta_value,
    kind: 'reversal',
    reverses_batch_id: original.batch_id,
  };
}
