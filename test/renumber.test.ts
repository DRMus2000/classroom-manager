import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyRenumberDiff, renumerate, type RoomColumn, type RoomSlot } from '../src/domain/renumber.js';

function column(code: string, order: number, direction: RoomColumn['direction'], seats: number): {
  col: RoomColumn;
  slots: RoomSlot[];
} {
  const column_id = `col-${code}`;
  return {
    col: { column_id, code, display_order: order, direction },
    slots: Array.from({ length: seats }, (_, i) => ({
      seat_id: `${code}-${i + 1}`,
      column_id,
      sort_in_column: i + 1,
      seat_number: null,
    })),
  };
}

describe('renumerate', () => {
  it('初始 54 座按蛇形编成 1–54', () => {
    const parts = [
      column('4', 1, 'toward_front', 13),
      column('3', 2, 'toward_back', 13),
      column('2', 3, 'toward_front', 14),
      column('1', 4, 'toward_back', 14),
    ];
    const diff = renumerate(
      parts.map((p) => p.col),
      parts.flatMap((p) => p.slots),
    );
    const num = (code: string, sort: number) =>
      diff.find((d) => d.seat_id === `${code}-${sort}`)!.new_number;

    assert.equal(num('1', 1), 1);
    assert.equal(num('1', 14), 14);
    assert.equal(num('2', 14), 15);
    assert.equal(num('2', 1), 28);
    assert.equal(num('3', 1), 29);
    assert.equal(num('3', 13), 41);
    assert.equal(num('4', 13), 42);
    assert.equal(num('4', 1), 54);
    assert.equal(new Set(diff.map((d) => d.new_number)).size, 54);
  });

  it('③④列后墙端各加一座后，③为 29–42，④为 43–56', () => {
    const parts = [
      column('4', 1, 'toward_front', 14),
      column('3', 2, 'toward_back', 14),
      column('2', 3, 'toward_front', 14),
      column('1', 4, 'toward_back', 14),
    ];
    const slots = parts.flatMap((p) => p.slots);
    const diff = renumerate(parts.map((p) => p.col), slots);
    applyRenumberDiff(slots, diff);
    const num = (code: string, sort: number) =>
      slots.find((s) => s.seat_id === `${code}-${sort}`)!.seat_number;

    assert.equal(num('1', 1), 1);
    assert.equal(num('1', 14), 14);
    assert.equal(num('2', 14), 15);
    assert.equal(num('2', 1), 28);
    assert.equal(num('3', 1), 29);
    assert.equal(num('3', 14), 42);
    assert.equal(num('4', 14), 43);
    assert.equal(num('4', 1), 56);
  });
});
