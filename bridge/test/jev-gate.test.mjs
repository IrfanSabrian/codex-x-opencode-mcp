import assert from 'node:assert/strict';
import test from 'node:test';
import { applyJevRoute, assertAllowedTool, receiptMarker, routeMarker, routePrompt } from '../plugin/jev-gate-core.mjs';

const payload = { execution_brief: { objective: 'Read note.txt', requirements: ['Quote it'], acceptance_criteria: ['Exact content'] } };

test('Jev gate leaves ordinary OpenCode chat alone', async () => {
  const parts = [{ type: 'text', text: 'tes' }];
  assert.equal(await applyJevRoute(parts, async () => { throw new Error('unexpected'); }), undefined);
  assert.equal(parts[0].text, 'tes');
});

test('Jev gate routes the actual brief and injects a compact receipt', async () => {
  const parts = [{ type: 'text', text: `Instructions\n\n${routeMarker}${JSON.stringify(payload)}` }];
  const jevTrace = '```text\nJev Decision (100ms):\n  complexity : quick (0.95)\n```';
  assert.equal(routePrompt(parts[0].text), 'Read note.txt\nQuote it\nExact content');
  const route = await applyJevRoute(parts, async prompt => {
    assert.equal(prompt, 'Read note.txt\nQuote it\nExact content');
    return { complexity: 'quick', skill: 'quick', is_visual: 0.1, _trace: jevTrace, decision: { category: 'quick', should_ultrawork: false, load_skills: [] } };
  });
  assert.equal(route.category, 'quick');
  assert.equal(route.formatted_trace, jevTrace);
  assert.match(parts[0].text, /"formatted_trace":"```text/);
  assert.match(parts[0].text, new RegExp(`^${receiptMarker}`));
  assert.match(parts[0].text, /do not delegate this quick task/);
  assert.match(parts[0].text, /Prometheus may only divide approved in-scope work among configured agents/);
  assert.match(parts[0].text, /must not change Codex's objective, scope, architecture, or acceptance criteria/);
  assert.match(parts[0].text, /If a required choice crosses those boundaries, ask Codex and wait for its decision/);
  assert.match(parts[0].text, /CODEX_HUB_ROUTE_REQUEST_V1/);
});

test('Jev failure stops the hub turn before Sisyphus runs', async () => {
  const parts = [{ type: 'text', text: `${routeMarker}${JSON.stringify(payload)}` }];
  await assert.rejects(() => applyJevRoute(parts, async () => { throw new Error('Jev unavailable'); }), /Jev unavailable/);
  assert.equal(parts[0].text.startsWith(receiptMarker), false);
});

test('Jev gate retains orchestration decision for full work', async () => {
  const parts = [{ type: 'text', text: `${routeMarker}${JSON.stringify(payload)}` }];
  const route = await applyJevRoute(parts, async () => ({
    complexity: 'full', skill: 'backend-architect', is_visual: 0,
    decision: { category: 'deep', should_ultrawork: true, load_skills: ['backend-architect'] }
  }));
  assert.equal(route.should_ultrawork, true);
  assert.match(parts[0].text, /ultrawork orchestration/);
  assert.match(parts[0].text, /backend-architect/);
});

test('quick route blocks delegation tools while ultrawork route permits them', () => {
  assert.throws(() => assertAllowedTool({ category: 'quick' }, 'task'), /does not permit OMO delegation/);
  assert.throws(() => assertAllowedTool({ category: 'quick' }, 'delegate_task'), /does not permit OMO delegation/);
  assert.doesNotThrow(() => assertAllowedTool({ category: 'quick' }, 'read'));
  assert.doesNotThrow(() => assertAllowedTool({ category: 'ultrabrain' }, 'task'));
});
