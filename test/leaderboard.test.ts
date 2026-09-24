import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assignRanks, compareRank } from '../src/domain/points.js';

describe('leaderboard ranks', () => {
  it('并列名次是 1, 1, 3，空榜和负分也能排序', () => {
    const rows = [
      { balance: 10, last_change_seq: 2, class_name: '乙', student_no: '2' },
      { balance: 10, last_change_seq: 2, class_name: '甲', student_no: '9' },
      { balance: 10, last_change_seq: 5, class_name: '甲', student_no: '1' },
      { balance: -3, last_change_seq: 1, class_name: '甲', student_no: '1' },
    ].sort(compareRank);
    const ranked = assignRanks(rows);
    assert.deepEqual(
      ranked.map((row) => row.rank),
      [1, 1, 3, 4],
    );
    assert.equal(ranked[0]!.class_name, '甲');
    assert.deepEqual(assignRanks([]), []);
  });
});
