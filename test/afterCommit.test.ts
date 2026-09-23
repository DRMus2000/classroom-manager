import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { afterCommit, runWithCommitHooks } from '../src/repo/afterCommit.js';

describe('afterCommit', () => {
  it('事务成功后才执行回调', async () => {
    const order: string[] = [];
    const result = await runWithCommitHooks(async () => {
      afterCommit(() => order.push('broadcast'));
      order.push('write');
      return 1;
    });
    assert.equal(result, 1);
    assert.deepEqual(order, ['write', 'broadcast']);
  });

  it('事务失败时不广播', async () => {
    let called = false;
    await assert.rejects(
      runWithCommitHooks(async () => {
        afterCommit(() => {
          called = true;
        });
        throw new Error('rollback');
      }),
      /rollback/,
    );
    assert.equal(called, false);
  });

  it('没有事务时立即执行', () => {
    let called = false;
    afterCommit(() => {
      called = true;
    });
    assert.equal(called, true);
  });
});
