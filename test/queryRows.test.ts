import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rowsOf } from '../src/repo/queryRows.js';

describe('rowsOf', () => {
  it('读取 pg QueryResult 的 rows', () => {
    const rows = rowsOf<{ id: number }>({ rows: [{ id: 1 }], rowCount: 1 });
    assert.deepEqual(rows, [{ id: 1 }]);
  });

  it('已经是数组时原样返回', () => {
    assert.deepEqual(rowsOf<number>([1, 2]), [1, 2]);
  });

  it('没有行时返回空数组', () => {
    assert.deepEqual(rowsOf({ command: 'UPDATE', rowCount: 0 }), []);
    assert.deepEqual(rowsOf(null), []);
  });
});
