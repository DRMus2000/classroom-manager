import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
describe('replay checkpoints', () => {
  it('满 200 个事件或每日兜底才写检查点，记分服务不调用它', async () => {
    process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
    const { shouldWriteCheckpoint } = await import('../src/services/replay.js');
    assert.equal(shouldWriteCheckpoint(0, false), false);
    assert.equal(shouldWriteCheckpoint(199, false), false);
    assert.equal(shouldWriteCheckpoint(200, false), true);
    assert.equal(shouldWriteCheckpoint(0, true), true);
    assert.equal(shouldWriteCheckpoint(Number.NaN, true), false);
    const scoring = await readFile(new URL('../src/services/points.ts', import.meta.url), 'utf8');
    assert.equal(scoring.includes('shouldWriteCheckpoint'), false);
    assert.equal(scoring.includes('replay_checkpoint'), false);
  });
});
