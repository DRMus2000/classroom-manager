import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { expandTargetsFromAnchor, planSwap, type SeatGeometry } from '../src/domain/seatMove.js';

function seats(): SeatGeometry[] {
  return [
    { seat_id: 's1', seat_number: 1, student_id: 'A', column_id: 'c1', display_order: 4, sort_in_column: 1 },
    { seat_id: 's2', seat_number: 2, student_id: 'B', column_id: 'c1', display_order: 4, sort_in_column: 2 },
    { seat_id: 's3', seat_number: 3, student_id: null, column_id: 'c1', display_order: 4, sort_in_column: 3 },
    { seat_id: 's4', seat_number: 15, student_id: 'C', column_id: 'c2', display_order: 3, sort_in_column: 1 },
  ];
}

describe('planSwap', () => {
  it('只选 A、目标为 2 号时，B 被轮换到 1 号', () => {
    const plan = planSwap(seats(), ['A'], ['s2']);
    assert.equal(plan.ok, true);
    const byStudent = new Map(plan.assignments.map((a) => [a.student_id, a]));
    assert.equal(byStudent.get('A')?.to_seat_id, 's2');
    assert.equal(byStudent.get('A')?.role, 'selected');
    assert.equal(byStudent.get('B')?.to_seat_id, 's1');
    assert.equal(byStudent.get('B')?.role, 'affected');
  });

  it('A、B 移到 2 号和 3 号时，重叠链成功且 1 号空出', () => {
    const plan = planSwap(seats(), ['A', 'B'], ['s2', 's3']);
    assert.equal(plan.ok, true);
    const byStudent = new Map(plan.assignments.map((a) => [a.student_id, a]));
    assert.equal(byStudent.get('A')?.to_seat_id, 's2');
    assert.equal(byStudent.get('B')?.to_seat_id, 's3');
    assert.equal(byStudent.has('C'), false);
  });

  it('人数不等或目标不存在时拒绝', () => {
    assert.equal(planSwap(seats(), ['A', 'B'], ['s3']).ok, false);
    assert.equal(planSwap(seats(), ['A'], ['missing']).issues[0]?.code, 'TARGET_NOT_FOUND');
  });
});

describe('expandTargetsFromAnchor', () => {
  it('锚点给出列偏移和槽位偏移', () => {
    const result = expandTargetsFromAnchor(seats(), ['A', 'B'], 's4');
    assert.equal(result.ok, false);
    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0]?.student_id, 'B');
    assert.deepEqual(result.target_seat_ids, ['s4']);
  });

  it('同列下移一格得到连续目标', () => {
    const result = expandTargetsFromAnchor(seats(), ['A', 'B'], 's2');
    assert.equal(result.ok, true);
    assert.deepEqual(result.target_seat_ids, ['s2', 's3']);
  });
});
