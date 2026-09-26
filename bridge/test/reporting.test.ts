import assert from 'node:assert/strict';
import test from 'node:test';
import { formatJevEstimate, formatTokenCount, jevEstimateUnavailable } from '../src/reporting.js';

test('formats a genuine Jev estimate as the exact compact English block', () => {
  const display = formatJevEstimate({ codex_tokens_saved: 1240, context_avoided: 5000, available: true });

  assert.equal(display, 'Jev Estimate\nCodex tokens saved: ~1.2k tokens\nContext avoided: ~5k tokens');
  assert.ok(!display.includes('%'));
});

test('reports unavailable instead of inventing numbers without a genuine estimate', () => {
  const report = jevEstimateUnavailable();

  assert.equal(report.available, false);
  assert.equal(report.display, 'Jev Estimate\nCodex tokens saved: unavailable\nContext avoided: unavailable');
  assert.equal(formatJevEstimate({ codex_tokens_saved: 0, context_avoided: 0, available: false }), report.display);
});

test('abbreviates absolute token counts with readable k/m units', () => {
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1000), '1k');
  assert.equal(formatTokenCount(1240), '1.2k');
  assert.equal(formatTokenCount(15000), '15k');
  assert.equal(formatTokenCount(1_240_000), '1.2m');
});
