// Generates schemas/result-contract.schema.json from the zod Result Contract,
// and harness.config.schema.json from the zod harness configuration.
//
// The published contract schema is what non-OpenCode harnesses receive as a
// JSON Schema. `default` keywords are stripped so a harness that ignores them
// can never be silently "patched" by a consumer, and `$schema` is dropped
// because the file is embedded into prompts and CLI flags. The harness config
// schema documents `harness.config.json` for editor validation.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { resultContractSchema } from '../src/contracts.js';
import { harnessConfigSchema } from '../src/harness-config.js';

/**
 * Strip the `$schema` and `default` JSON Schema keywords, but keep property
 * *names* that happen to be called `default` (the harness config has one:
 * `harness.default`). A key is a name when its parent object is a
 * `properties` map; anywhere else `default` is the annotation keyword.
 */
function stripKeywords(value: unknown, insideProperties = false): unknown {
  if (Array.isArray(value)) return value.map(item => stripKeywords(item, insideProperties));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!insideProperties && (key === '$schema' || key === 'default')) continue;
    const childInsideProperties = key === 'properties' || key === 'patternProperties' || key === '$defs' || key === 'definitions';
    output[key] = stripKeywords(item, childInsideProperties);
  }
  return output;
}

const root = dirname(fileURLToPath(import.meta.url));
const targets: Array<{ schema: z.ZodType; path: string }> = [
  { schema: resultContractSchema, path: join(root, '..', 'schemas', 'result-contract.schema.json') },
  { schema: harnessConfigSchema, path: join(root, '..', 'harness.config.schema.json') }
];

for (const { schema, path } of targets) {
  const generated = z.toJSONSchema(schema, { target: 'draft-07' });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(stripKeywords(generated), null, 2)}\n`, 'utf8');
  console.log(`Wrote ${path}`);
}
