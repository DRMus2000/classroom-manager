import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { previewRenumber } from '../src/domain/layoutPreview.js';
import { changedDiff, renumerate, type RoomColumn, type RoomSlot } from '../src/domain/renumber.js';

function room(): { columns: RoomColumn[]; slots: RoomSlot[] } {
  const spec = [
    { code: '4', order: 1, direction: 'toward_front' as const, seats: 13 },
    { code: '3', order: 2, direction: 'toward_back' as const, seats: 13 },
    { code: '2', order: 3, direction: 'toward_front' as const, seats: 14 },
    { code: '1', order: 4, direction: 'toward_back' as const, seats: 14 },
  ];
  const columns = spec.map((item) => ({
    column_id: `col-${item.code}`,
    code: item.code,
    display_order: item.order,
    direction: item.direction,
  }));
  const slots = spec.flatMap((item) =>
    Array.from({ length: item.seats }, (_, index) => ({
      seat_id: `${item.code}-${index + 1}`,
      column_id: `col-${item.code}`,
      sort_in_column: index + 1,
      seat_number: null as number | null,
    })),
  );
  for (const diff of renumerate(columns, slots)) {
    const slot = slots.find((item) => item.seat_id === diff.seat_id);
    if (slot) slot.seat_number = diff.new_number;
  }
  return { columns, slots };
}

describe('previewRenumber', () => {
  it('③列后墙端插入一座时，只把④列的编号顺延', () => {
    const { columns, slots } = room();
    const diff = changedDiff(
      previewRenumber(columns, slots, 'insert_slot', { column_id: 'col-3', after_sort: 13 }),
    );
    assert.equal(diff.find((item) => item.seat_id === '3-1'), undefined);
    assert.equal(diff.find((item) => item.seat_id === '1-1'), undefined);
    const back = diff.find((item) => item.seat_id === '4-13');
    assert.equal(back?.old_number, 42);
    assert.equal(back?.new_number, 43);
    assert.equal(diff.find((item) => item.seat_id === '4-1')?.new_number, 55);
  });

  it('调转①列方向时，这一列的编号对调，后面的列不变', () => {
    const { columns, slots } = room();
    const diff = changedDiff(
      previewRenumber(columns, slots, 'change_column', { column_id: 'col-1', direction: 'toward_front' }),
    );
    assert.equal(diff.find((item) => item.seat_id === '1-1')?.new_number, 14);
    assert.equal(diff.find((item) => item.seat_id === '1-14')?.new_number, 1);
    assert.equal(diff.find((item) => item.seat_id === '2-1'), undefined);
  });

  it('只改椅背时编号不变', () => {
    const { columns, slots } = room();
    const diff = changedDiff(
      previewRenumber(columns, slots, 'change_column', { column_id: 'col-1', facing: 'left' }),
    );
    assert.equal(diff.length, 0);
  });

  it('删除①列讲台端空座后，后续编号前移', () => {
    const { columns, slots } = room();
    const diff = changedDiff(previewRenumber(columns, slots, 'delete_slot', { seat_id: '1-1' }));
    assert.equal(diff.find((item) => item.seat_id === '1-2')?.new_number, 1);
    assert.equal(diff.find((item) => item.seat_id === '4-1')?.new_number, 53);
  });
});
