/**
 * 点名池与不放回抽取。落库与 SSE 在 services/rollcall.ts。
 * 池 = 当时在班、在范围内、不在排除名单、且不在本轮已抽名单。
 */

export type RollcallScopeType = 'all' | 'selected';

export interface RollcallScope {
  type: RollcallScopeType;
  student_ids: string[];
}

export interface PoolStudent {
  student_id: string;
  name: string;
  seat_number: number | null;
  status: 'active' | 'left' | 'anonymized';
}

export interface DrawnStudent {
  student_id: string;
  name: string;
  seat_number: number | null;
}

/**
 * 读出库里的 id 名单。非法 JSON 返回 null，由服务层转成业务错误。
 * 不是数组时按空名单处理。
 */
export function parseStoredIdList(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return null;
  }
}

export function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 未知 id（不属于该班）与范围内的在班学生分开，便于服务层拒绝过期客户端。 */
export function unknownStudentIds(classStudentIds: readonly string[], requested: readonly string[]): string[] {
  const known = new Set(classStudentIds);
  return uniqueIds(requested).filter((id) => !known.has(id));
}

export function rollcallPool(
  students: readonly PoolStudent[],
  scope: RollcallScope,
  excludeIds: readonly string[],
  pickedIds: readonly string[],
): PoolStudent[] {
  const exclude = new Set(excludeIds);
  const picked = new Set(pickedIds);
  const selected = scope.type === 'selected' ? new Set(scope.student_ids) : null;
  return students
    .filter((student) => {
      if (student.status !== 'active') return false;
      if (exclude.has(student.student_id) || picked.has(student.student_id)) return false;
      if (selected && !selected.has(student.student_id)) return false;
      return true;
    })
    .slice()
    .sort((a, b) => {
      const seatA = a.seat_number ?? Number.MAX_SAFE_INTEGER;
      const seatB = b.seat_number ?? Number.MAX_SAFE_INTEGER;
      if (seatA !== seatB) return seatA - seatB;
      return a.student_id < b.student_id ? -1 : a.student_id > b.student_id ? 1 : 0;
    });
}

export type DrawFailure = 'invalid_count' | 'pool_short';

export function drawStudents(
  pool: readonly PoolStudent[],
  count: number,
  randomInt: (max: number) => number,
): { ok: true; picked: DrawnStudent[] } | { ok: false; reason: DrawFailure; available: number } {
  if (!Number.isInteger(count) || count < 1) {
    return { ok: false, reason: 'invalid_count', available: pool.length };
  }
  if (count > pool.length) {
    return { ok: false, reason: 'pool_short', available: pool.length };
  }
  const working = pool.slice();
  const picked: DrawnStudent[] = [];
  for (let i = 0; i < count; i += 1) {
    const index = randomInt(working.length);
    if (!Number.isInteger(index) || index < 0 || index >= working.length) {
      throw new Error('randomInt 必须返回 [0, n) 内的整数');
    }
    const [student] = working.splice(index, 1);
    picked.push({
      student_id: student!.student_id,
      name: student!.name,
      seat_number: student!.seat_number,
    });
  }
  return { ok: true, picked };
}
