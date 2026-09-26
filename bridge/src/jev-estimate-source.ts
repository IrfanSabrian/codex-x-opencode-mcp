// Genuine Jev estimate source (inactive by default; see index.ts).
//
// This estimator asks the EXISTING Jev SystemOne backend for a dedicated
// estimate judgment through the existing jevDecide entry point with
// estimate-specific questions. It is a separate operation from Jev
// Decision (different questions, asked once per parent-task final outcome,
// never used for routing) and requires no new MCP/plugin, no credential,
// and no provider/backend configuration change: same endpoint, same key,
// same model as the routing calls the Jev gate already makes.
//
// Honesty rules:
// - The backend only returns band judgments (tiny/small/medium/large);
//   absolute counts are disclosed band representatives from BAND_TOKENS,
//   approximate by construction, never measured Codex billing.
// - Only transcript/codex-payload LENGTHS are sent, never content.
// - Any backend failure or malformed answer throws; the hub converts that
//   to an unavailable report instead of inventing numbers.
// - The Jev client module is imported lazily so unit tests and builds
//   never need it; tests inject a stub decide function (no live calls).

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { JevEstimate } from './reporting.js';
import type { JevEstimateSource } from './hub.js';

export type JevDecideFn = (state: unknown, questions: unknown) => Promise<unknown>;

/** Approximate representative absolute token counts per Jev-judged band. */
export const ESTIMATE_BAND_TOKENS = {
  tiny: 500,
  small: 3000,
  medium: 12000,
  large: 40000
} as const;

export type EstimateBand = keyof typeof ESTIMATE_BAND_TOKENS;

const ESTIMATE_QUESTIONS = {
  saved_band: {
    type: 'choice',
    instructions: 'Judge how many Codex tokens were saved by delegating this execution (executor transcript the compact Codex payload never carried). Use the measured char lengths as grounding.',
    criteria: {
      tiny: 'Under about 1k tokens of delegated execution context',
      small: 'About 1k to 5k tokens of delegated execution context',
      medium: 'About 5k to 20k tokens of delegated execution context',
      large: 'Over about 20k tokens of delegated execution context'
    }
  },
  avoided_band: {
    type: 'choice',
    instructions: 'Judge the total task/repository execution context Codex avoided processing by delegating. Use the measured transcript length as grounding.',
    criteria: {
      tiny: 'Under about 1k tokens of avoided execution context',
      small: 'About 1k to 5k tokens of avoided execution context',
      medium: 'About 5k to 20k tokens of avoided execution context',
      large: 'Over about 20k tokens of avoided execution context'
    }
  }
};

function parseBand(value: unknown, name: string): EstimateBand {
  if (typeof value === 'string' && value in ESTIMATE_BAND_TOKENS) return value as EstimateBand;
  throw new Error(`Jev estimate returned an invalid ${name}`);
}

async function defaultDecide(state: unknown, questions: unknown): Promise<unknown> {
  const clientPath = process.env.JEV_CLIENT_PATH
    ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.omo', 'jev-router', 'jev-client.mjs');
  const module: unknown = await import(pathToFileURL(clientPath).href);
  const jevDecide = (module as { jevDecide: JevDecideFn }).jevDecide;
  return jevDecide(state, questions);
}

export class SystemOneJevEstimator implements JevEstimateSource {
  constructor(private readonly decide: JevDecideFn = defaultDecide) {}

  async estimate(input: { task_id: string; transcript: string; codex_payload: string }): Promise<JevEstimate> {
    const state = `Task ${input.task_id}: executor transcript ${input.transcript.length} chars; compact Codex payload ${input.codex_payload.length} chars.`;
    const response: unknown = await this.decide(state, ESTIMATE_QUESTIONS);
    const answers = (response as { answers?: Record<string, { choice?: unknown }> }).answers;
    const saved = parseBand(answers?.saved_band?.choice, 'saved_band');
    const avoided = parseBand(answers?.avoided_band?.choice, 'avoided_band');
    return {
      codex_tokens_saved: ESTIMATE_BAND_TOKENS[saved],
      context_avoided: ESTIMATE_BAND_TOKENS[avoided],
      available: true
    };
  }
}
