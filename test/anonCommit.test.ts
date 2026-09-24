import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCommittedExport } from '../src/services/anonCommit.js';

describe('anon ledger commit order', () => {
  it('意图提交失败时不写文件', async () => {
    const calls: string[] = [];
    await assert.rejects(
      runCommittedExport({
        commitIntent: async () => {
          calls.push('commit');
          throw new Error('sql failed');
        },
        writeLedger: async () => {
          calls.push('file');
        },
        confirmExport: async () => {
          calls.push('confirm');
        },
      }),
      /sql failed/,
    );
    assert.deepEqual(calls, ['commit']);
  });

  it('文件写入失败时不确认导出', async () => {
    const calls: string[] = [];
    await assert.rejects(
      runCommittedExport({
        commitIntent: async () => {
          calls.push('commit');
        },
        writeLedger: async () => {
          calls.push('file');
          throw new Error('disk full');
        },
        confirmExport: async () => {
          calls.push('confirm');
        },
      }),
      /disk full/,
    );
    assert.deepEqual(calls, ['commit', 'file']);
  });
});
