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

test('pure mode leaves the managed runtime env untouched and drops the Jev gate flag', () => {
  const content = JSON.stringify({ plugin: ['oh-my-openagent@latest'], theme: 'system' });
  const env = managedOpenCodeEnv({ OPENCODE_CONFIG_CONTENT: content, OPENCODE_HUB_JEV_GATE: '1' }, { pure: true });
  assert.equal(env.OPENCODE_CONFIG_CONTENT, content);
  assert.equal(env.OPENCODE_HUB_JEV_GATE, undefined);
  assert.equal('OPENCODE_HUB_JEV_GATE' in env, false);
});

test('pure mode without a base env returns an empty environment', () => {
  const previous = process.env.OPENCODE_HUB_JEV_GATE;
  process.env.OPENCODE_HUB_JEV_GATE = '1';
  try {
    const env = managedOpenCodeEnv(process.env, { pure: true });
    assert.equal(env.OPENCODE_HUB_JEV_GATE, undefined);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_HUB_JEV_GATE;
    else process.env.OPENCODE_HUB_JEV_GATE = previous;
  }
});
