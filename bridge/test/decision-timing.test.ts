import assert from 'node:assert/strict';
import test from 'node:test';
import { DECISION_WAIT_TIMEOUT_MS, evaluateDecisionWait } from '../src/decision-timing.js';

test('a brief-answerable decision never waits for the user', () => {
  assert.equal(evaluateDecisionWait({
    answerableFromBrief: true, promptShownAtMs: 0, nowMs: 600_000, lastUserActivityAtMs: 0
  }), 'answer_now');
});

test('user silence shorter than five minutes keeps waiting', () => {
  assert.equal(evaluateDecisionWait({
    answerableFromBrief: false, promptShownAtMs: 0, nowMs: DECISION_WAIT_TIMEOUT_MS - 1, lastUserActivityAtMs: 0
  }), 'wait');
});

test('five minutes of silence auto-resolves with the recommendation', () => {
  assert.equal(evaluateDecisionWait({
    answerableFromBrief: false, promptShownAtMs: 0, nowMs: DECISION_WAIT_TIMEOUT_MS, lastUserActivityAtMs: 0
  }), 'auto_resolve');
});

test('a user clarification resets the wait instead of auto-resolving', () => {
  assert.equal(evaluateDecisionWait({
    answerableFromBrief: false, promptShownAtMs: 0, nowMs: DECISION_WAIT_TIMEOUT_MS + 60_000, lastUserActivityAtMs: DECISION_WAIT_TIMEOUT_MS + 30_000
  }), 'wait_reset');
});

test('the five-minute timeout is the documented default', () => {
  assert.equal(DECISION_WAIT_TIMEOUT_MS, 300_000);
});
