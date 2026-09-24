import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../src/lib/errors.js';
import {
  drawStudents,
  parseStoredIdList,
  rollcallPool,
  uniqueIds,
  unknownStudentIds,
  type PoolStudent,
} from '../src/domain/rollcall.js';

function student(partial: Partial<PoolStudent> & Pick<PoolStudent, 'student_id'>): PoolStudent {
  return {
    name: partial.student_id,
    seat_number: null,
    status: 'active',
    ...partial,
  };
}

describe('rollcall pool', () => {
  const students = [
    student({ student_id: 'a', name: '甲', seat_number: 2 }),
    student({ student_id: 'b', name: '乙', seat_number: 1 }),
    student({ student_id: 'c', name: '丙', seat_number: 3, status: 'left' }),
    student({ student_id: 'd', name: '丁', seat_number: 4, status: 'anonymized' }),
    student({ student_id: 'e', name: '戊', seat_number: 5 }),
  ];

  it('只保留在班、范围内、未排除、未抽中的学生，并按座号排序', () => {
    const pool = rollcallPool(students, { type: 'all', student_ids: [] }, ['e'], ['a']);
    assert.deepEqual(
      pool.map((item) => item.student_id),
      ['b'],
    );
  });

  it('选中范围忽略离班和班外 id，空排除与重复 id 不影响', () => {
    const pool = rollcallPool(
      students,
      { type: 'selected', student_ids: ['e', 'c', 'e', 'missing'] },
      [],
      [],
    );
    assert.deepEqual(
      pool.map((item) => item.student_id),
      ['e'],
    );
    assert.deepEqual(uniqueIds(['e', 'e', 'b']), ['e', 'b']);
    assert.deepEqual(unknownStudentIds(['a', 'b'], ['b', 'z', 'z']), ['z']);
  });

  it('池为空时没有可抽的人', () => {
    const pool = rollcallPool([], { type: 'all', student_ids: [] }, [], []);
    assert.deepEqual(pool, []);
    const drawn = drawStudents(pool, 1, () => 0);
    assert.equal(drawn.ok, false);
    if (!drawn.ok) assert.equal(drawn.reason, 'pool_short');
  });

  it('不放回抽取，人数超过池子或不是正整数时拒绝', () => {
    const pool = rollcallPool(students, { type: 'all', student_ids: [] }, [], []);
    const sequence = [2, 0];
    const drawn = drawStudents(pool, 2, (max) => {
      const next = sequence.shift() ?? 0;
      assert.ok(next < max);
      return next;
    });
    assert.equal(drawn.ok, true);
    if (drawn.ok) {
      assert.deepEqual(
        drawn.picked.map((item) => item.student_id),
        ['e', 'b'],
      );
    }
    const again = drawStudents(pool, 4, () => 0);
    assert.equal(again.ok, false);
    const zero = drawStudents(pool, 0, () => 0);
    assert.equal(zero.ok, false);
    if (!zero.ok) assert.equal(zero.reason, 'invalid_count');
  });

  it('非法 JSON 名单解析失败，合法数组和坏形状分别给出名单或空名单', () => {
    assert.deepEqual(parseStoredIdList('["a","b",1]'), ['a', 'b']);
    assert.deepEqual(parseStoredIdList(['a']), ['a']);
    assert.deepEqual(parseStoredIdList('{"a":1}'), []);
    assert.equal(parseStoredIdList('['), null);
  });

  it('坏 JSON 在服务层变成 INTERNAL，而不是未捕获的解析异常', async () => {
    process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
    const { readStoredIdList } = await import('../src/services/rollcall.js');
    assert.throws(
      () => readStoredIdList('['),
      (err: unknown) => err instanceof AppError && err.code === 'INTERNAL',
    );
  });

  it('随机下标越界时抛出，避免抽到空位', () => {
    const pool = rollcallPool(students, { type: 'selected', student_ids: ['b'] }, [], []);
    assert.throws(() => drawStudents(pool, 1, () => 5), /randomInt/);
  });
});
