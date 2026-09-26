import assert from 'node:assert/strict';
import test from 'node:test';
import { managedOpenCodeEnv } from '../src/runtime.js';

test('managed runtime adds Jev gate without dropping configured OMO plugins', () => {
  const env = managedOpenCodeEnv({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: ['oh-my-openagent@latest'], theme: 'system' }) });
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
  assert.equal(config.theme, 'system');
  assert.ok(config.plugin.includes('oh-my-openagent@latest'));
  assert.equal(config.plugin.filter((item: string) => item.endsWith('/jev-gate.mjs')).length, 1);
  assert.equal(env.OPENCODE_HUB_JEV_GATE, '1');
});
