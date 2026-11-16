import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractFencedJson, firstJsonObject, parseJsonLines, stripAnsi, tail, truncate
} from '../src/harness/output.js';
import {
  extractResultContract, normalizeResult, parseResultContractText, resultContractJsonSchema
} from '../src/harness/contract-extract.js';
import type { SessionMessage } from '../src/opencode-client.js';

function assistant(...texts: string[]): SessionMessage {
  return { info: { role: 'assistant' }, parts: texts.map(text => ({ type: 'text', text })) };
}

function contract(taskId = 'task-1'): Record<string, unknown> {
  return {
    task_id: taskId,
    status: 'complete',
    summary: 'Did the work.',
    what_changed: ['one change'],
    changed_files: ['src/a.ts'],
    artifacts: [],
    validation: { typecheck: 'pass', lint: 'pass', tests: 'pass', build: 'not_run', custom_checks: [] },
    evidence: ['ran typecheck'],
    risks: [],
    assumptions: [],
    unresolved_issues: [],
    decisions_required: [],
    capabilities_used: [],
    capabilities_installed: [],
    agents_used: [],
    models_used: [],
    tools_used: [],
    mcps_used: [],
    mcp_state: [],
    provenance: ['harness:test']
  };
}

test('stripAnsi removes colour, cursor and hyperlink sequences', () => {
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red');
  assert.equal(stripAnsi('\u001b[2K\u001b[1Gprogress'), 'progress');
  assert.equal(stripAnsi('\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007'), 'link');
  assert.equal(stripAnsi('plain text'), 'plain text');
});

test('parseJsonLines counts banners as dropped and keeps parsed values', () => {
  const result = parseJsonLines([
    'Codex CLI 0.42.7',
    '{"type":"thread.started","thread_id":"t1"}',
    '',
    '{"type":"turn.completed","usage":{"output_tokens":3}}'
  ].join('\n'));
  assert.equal(result.values.length, 2);
  assert.equal(result.droppedLines, 1);
  assert.deepEqual(result.values[0], { type: 'thread.started', thread_id: 't1' });
});

test('firstJsonObject parses a whole blob, then scans prose for a balanced object', () => {
  assert.deepEqual(firstJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(firstJsonObject('Done!\n{"a":{"b":2}} trailing prose'), { a: { b: 2 } });
  // Braces inside string literals must not end the candidate early.
  assert.deepEqual(firstJsonObject('note {"a":"}{","b":1}'), { a: '}{', b: 1 });
  assert.equal(firstJsonObject('no json here'), undefined);
  assert.equal(firstJsonObject('   '), undefined);
});

test('extractFencedJson prefers json fences and tolerates unlabelled ones', () => {
  assert.deepEqual(extractFencedJson('text\n```json\n{"a":1}\n```\nmore'), { a: 1 });
  assert.deepEqual(extractFencedJson('```\n{"b":2}\n```'), { b: 2 });
  assert.deepEqual(extractFencedJson('```json\nSure: {"c":3}\n```'), { c: 3 });
  assert.equal(extractFencedJson('no fences'), undefined);
});

test('truncate and tail respect UTF-8 boundaries', () => {
  assert.equal(truncate('abcdef', 3), 'abc');
  assert.equal(truncate('abcdef', 0), '');
  assert.equal(truncate('abc', 10), 'abc');
  const emoji = 'a\u{1F600}b';
  const cut = truncate(emoji, 2);
  assert.ok(!cut.includes('\uFFFD'));
  assert.equal(cut, 'a');
  assert.equal(tail('abcdef', 3), 'def');
  assert.equal(tail('abcdef', 0), '');
  assert.ok(!tail(emoji, 4).includes('\uFFFD'));
});

test('normalizeResult turns string list fields into arrays', () => {
  const normalized = normalizeResult({
    task_id: 'task-1',
    what_changed: 'one thing',
    evidence: '',
    risks: {},
    validation: { typecheck: 'pass', custom_checks: [{ kind: 'smoke' }] }
  }) as Record<string, unknown>;
  assert.deepEqual(normalized.what_changed, ['one thing']);
  assert.deepEqual(normalized.evidence, []);
  assert.deepEqual(normalized.risks, []);
  const validation = normalized.validation as Record<string, unknown>;
  assert.deepEqual(validation.custom_checks, ['harness reported: {"kind":"smoke"}']);
});

test('resultContractJsonSchema exposes the contract shape without defaults', () => {
  const schema = resultContractJsonSchema();
  assert.equal(schema.type, 'object');
  assert.ok(schema.properties);
  const serialized = JSON.stringify(schema);
  assert.equal(serialized.includes('"default"'), false);
  assert.equal(serialized.includes('$schema'), false);
});

test('extractResultContract prefers structured output over transcript text', () => {
  const structured = contract('task-9');
  const fromStructured = extractResultContract({
    taskId: 'task-9',
    structured,
    messages: [assistant(JSON.stringify(contract('other-task')))]
  });
  assert.equal(fromStructured?.task_id, 'task-9');
  assert.equal(fromStructured?.summary, 'Did the work.');
});

test('extractResultContract scans newest messages first and ignores other tasks', () => {
  const messages = [
    assistant(JSON.stringify(contract('task-1'))),
    assistant('Correction cycle finished.\n```json\n' + JSON.stringify({ ...contract('task-1'), summary: 'Second pass.' }) + '\n```')
  ];
  const extracted = extractResultContract({ taskId: 'task-1', messages });
  assert.equal(extracted?.summary, 'Second pass.');

  assert.equal(extractResultContract({ taskId: 'task-2', messages }), undefined);
});

test('extractResultContract tolerates prose around a balanced object', () => {
  const messages = [assistant(`Here is the contract: ${JSON.stringify(contract('task-7'))} - thanks`)];
  assert.equal(extractResultContract({ taskId: 'task-7', messages })?.status, 'complete');
});

test('extractResultContract returns undefined for invalid or empty transcripts', () => {
  assert.equal(extractResultContract({ taskId: 'task-1', messages: [] }), undefined);
  assert.equal(extractResultContract({ taskId: 'task-1', messages: [assistant('no json')] }), undefined);
  assert.equal(
    extractResultContract({ taskId: 'task-1', messages: [assistant('{"task_id":"task-1"}')] }),
    undefined
  );
});

test('parseResultContractText accepts a normalised partial contract', () => {
  const parsed = parseResultContractText(JSON.stringify({
    task_id: 'task-5',
    status: 'partial',
    summary: 'Halfway.',
    what_changed: 'step one',
    validation: { typecheck: 'not_run', lint: 'not_run', tests: 'not_run', build: 'not_run', custom_checks: 'smoke' },
    provenance: ''
  }), 'task-5');
  assert.equal(parsed?.status, 'partial');
  assert.deepEqual(parsed?.what_changed, ['step one']);
  assert.deepEqual(parsed?.validation.custom_checks, ['smoke']);
  assert.deepEqual(parsed?.provenance, []);
});
