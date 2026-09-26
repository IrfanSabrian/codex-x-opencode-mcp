export const DECISION_WAIT_TIMEOUT_MS = 300_000;

export type DecisionWaitInput = {
  answerableFromBrief: boolean;
  promptShownAtMs: number;
  nowMs: number;
  lastUserActivityAtMs: number;
};

export type DecisionWaitOutcome = 'answer_now' | 'wait' | 'wait_reset' | 'auto_resolve';

export function evaluateDecisionWait(input: DecisionWaitInput): DecisionWaitOutcome {
  if (input.answerableFromBrief) return 'answer_now';
  if (input.lastUserActivityAtMs > input.promptShownAtMs) return 'wait_reset';
  if (input.nowMs - input.promptShownAtMs >= DECISION_WAIT_TIMEOUT_MS) return 'auto_resolve';
  return 'wait';
}
