import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyCountdown, displayRemaining, settleCountdown, type CountdownSnapshot } from '../src/domain/countdown.js';

const NOW = Date.parse('2026-09-23T07:00:00.000Z');

describe('countdown', () => {
  it('开始后用绝对截止时间，暂停清空截止时间并记下剩余秒', () => {
    const started = applyCountdown(null, 'start', 180, NOW);
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.equal(started.state.status, 'running');
    assert.equal(started.state.deadline_ms, NOW + 180_000);
    assert.equal(started.state.remaining_sec, null);

    const paused = applyCountdown(started.state, 'pause', undefined, NOW + 30_000);
    assert.equal(paused.ok, true);
    if (!paused.ok) return;
    assert.equal(paused.state.status, 'paused');
    assert.equal(paused.state.deadline_ms, null);
    assert.equal(paused.state.remaining_sec, 150);

    const resumed = applyCountdown(paused.state, 'resume', undefined, NOW + 40_000);
    assert.equal(resumed.ok, true);
    if (!resumed.ok) return;
    assert.equal(resumed.state.deadline_ms, NOW + 40_000 + 150_000);
    assert.equal(resumed.state.remaining_sec, null);
  });

  it('到达截止时间后读取或暂停都记为 finished', () => {
    const running: CountdownSnapshot = {
      status: 'running',
      duration_sec: 10,
      deadline_ms: NOW + 10_000,
      remaining_sec: null,
    };
    const settled = settleCountdown(running, NOW + 10_000);
    assert.equal(settled.status, 'finished');
    assert.equal(settled.remaining_sec, 0);
    assert.equal(displayRemaining(running, NOW + 10_500), 0);

    const paused = applyCountdown(running, 'pause', undefined, NOW + 10_000);
    assert.equal(paused.ok, true);
    if (paused.ok) assert.equal(paused.state.status, 'finished');

    const early = applyCountdown(running, 'pause', undefined, NOW + 9_001);
    assert.equal(early.ok, true);
    if (early.ok) assert.equal(early.state.remaining_sec, 1);
  });

  it('未开始、非法动作、时长越界和剩余 0 的继续都有明确结果', () => {
    assert.equal(applyCountdown(null, 'pause', undefined, NOW).ok, false);
    assert.equal(applyCountdown(null, 'start', undefined, NOW).ok, false);
    assert.equal(applyCountdown(null, 'start', 0, NOW).ok, false);
    assert.equal(applyCountdown(null, 'start', 86401, NOW).ok, false);

    const paused: CountdownSnapshot = {
      status: 'paused',
      duration_sec: 30,
      deadline_ms: null,
      remaining_sec: 30,
    };
    assert.equal(applyCountdown(paused, 'pause', undefined, NOW).ok, false);
    assert.equal(applyCountdown(paused, 'start', undefined, NOW).ok, true);

    const empty: CountdownSnapshot = { ...paused, remaining_sec: 0 };
    const resumed = applyCountdown(empty, 'resume', undefined, NOW);
    assert.equal(resumed.ok, true);
    if (resumed.ok) assert.equal(resumed.state.status, 'finished');

    const reset = applyCountdown(paused, 'reset', 45, NOW);
    assert.equal(reset.ok, true);
    if (reset.ok) {
      assert.equal(reset.state.status, 'reset');
      assert.equal(reset.state.duration_sec, 45);
      assert.equal(reset.state.deadline_ms, null);
      assert.equal(reset.state.remaining_sec, null);
    }
  });
});
