import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_ROLE_NAMES, ORCHESTRATION_ROLES, buildOrchestrationInstruction,
  type OrchestrationProfile
} from '../src/orchestration.js';

const PROFILES: OrchestrationProfile[] = ['orchestrated', 'minimal', 'off'];

test('role bindings inject the harness models into the protocol', () => {
  const text = buildOrchestrationInstruction({
    role_bindings: {
      planner: { tier: 'strong', model: 'max-model' },
      implementer: { tier: 'standard' },
      intake: { tier: 'cheap', model: 'mini-model' }
    }
  });
  assert.match(text, /^Role models: /m);
  assert.match(text, /planner=strong \(max-model\)/);
  assert.match(text, /implementer=standard(?! \()/);
  assert.match(text, /intake=cheap \(mini-model\)/);
  assert.match(text, /Run each role as its own subagent bound to that model when the harness supports subagents/);
  assert.doesNotMatch(text, /advisor=/, 'only the roles in the bindings appear');
});

test('no role bindings means no model line', () => {
  assert.doesNotMatch(buildOrchestrationInstruction(), /Role models:/);
});

test('the off profile injects nothing', () => {
  assert.equal(buildOrchestrationInstruction({ profile: 'off' }), '');
});

test('the default profile names every role and states the default parallelism', () => {
  const text = buildOrchestrationInstruction();
  assert.notEqual(text.trim(), '');
  assert.match(text, /^Orchestration protocol \(applies to every cycle\):$/m);
  for (const role of ORCHESTRATION_ROLES) {
    assert.ok(text.includes(DEFAULT_ROLE_NAMES[role]), `missing role name: ${DEFAULT_ROLE_NAMES[role]}`);
  }
  assert.match(text, /^Roles: orchestrator, intake, planner, plan-reviewer, implementer, researcher, reviewer, tester, advisor, inspector\.$/m);
  assert.match(text, /up to 4 at a time/);
  assert.match(text, /Result Contract/);
  assert.match(text, /single agent/);
});

test('no profile leaks a vendor or orchestrator brand name', () => {
  const forbidden = /Sisyphus|Hephaestus|Prometheus|Momus|Metis|Oracle|Jev|OMO/i;
  for (const profile of PROFILES) {
    assert.doesNotMatch(buildOrchestrationInstruction({ profile }), forbidden, `brand leak in ${profile}`);
  }
});

test('role_names overrides the display name in the roles line', () => {
  const text = buildOrchestrationInstruction({
    role_names: { plan_reviewer: 'critic', implementer: 'builder', orchestrator: 'lead' }
  });
  assert.match(text, /^Roles: lead, intake, planner, critic, builder, researcher, reviewer, tester, advisor, inspector\.$/m);
  assert.equal(text.includes(DEFAULT_ROLE_NAMES.orchestrator + ','), false);
  assert.equal(text.includes('plan-reviewer'), false);
});

test('a blank role override keeps the default display name', () => {
  const text = buildOrchestrationInstruction({ role_names: { tester: '   ' } });
  assert.match(text, /, tester, advisor, inspector\./);
});

test('max_parallel_agents is clamped to 1..16 and rejects non-integers', () => {
  assert.match(buildOrchestrationInstruction({ max_parallel_agents: 0 }), /up to 1 at a time/);
  assert.match(buildOrchestrationInstruction({ max_parallel_agents: 99 }), /up to 16 at a time/);
  assert.match(buildOrchestrationInstruction({ max_parallel_agents: 2 }), /up to 2 at a time/);
  assert.match(buildOrchestrationInstruction({ max_parallel_agents: 2.5 }), /up to 4 at a time/);
  assert.match(buildOrchestrationInstruction({ max_parallel_agents: Number.NaN }), /up to 4 at a time/);
  assert.match(buildOrchestrationInstruction({ max_parallel_agents: 16 }), /up to 16 at a time/);
  assert.match(buildOrchestrationInstruction({ max_parallel_agents: 1 }), /up to 1 at a time/);
});

test('the minimal profile stays short, drops the role table, and keeps the report requirement', () => {
  const minimal = buildOrchestrationInstruction({ profile: 'minimal' });
  const full = buildOrchestrationInstruction({ profile: 'orchestrated' });
  assert.notEqual(minimal.trim(), '');
  assert.ok(minimal.length < full.length);
  assert.equal(/^Roles:/m.test(minimal), false);
  assert.equal(minimal.includes('orchestrator'), false);
  assert.match(minimal, /Result Contract/);
  assert.match(minimal, /every list field a JSON array/);
});

test('the orchestrated block stays inside the documented 220 to 320 word range', () => {
  const words = buildOrchestrationInstruction().split(/\s+/).filter(Boolean).length;
  assert.ok(words >= 220, `too short: ${words} words`);
  assert.ok(words <= 320, `too long: ${words} words`);
});

test('the same options always produce the identical string', () => {
  const options = { profile: 'orchestrated' as const, max_parallel_agents: 3, role_names: { reviewer: 'auditor' } };
  assert.equal(buildOrchestrationInstruction(options), buildOrchestrationInstruction(options));
  assert.equal(buildOrchestrationInstruction(), buildOrchestrationInstruction());
  assert.equal(
    buildOrchestrationInstruction({ profile: 'minimal' }),
    buildOrchestrationInstruction({ profile: 'minimal' })
  );
});
