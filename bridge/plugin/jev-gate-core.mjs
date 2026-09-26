import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const routeMarker = 'CODEX_HUB_ROUTE_REQUEST_V1\n';
export const receiptMarker = 'CODEX_HUB_JEV_RECEIPT_V1 ';

export const skillDiscoveryFallback = 'Jev listed no installed skills for this turn: check the user-global skill index, then follow the opencode-skill-discovery global skill (skills.sh for general work, ui-skills.com for UI work) before executing.';

const categories = new Set(['quick', 'deep', 'ultrabrain', 'visual-engineering']);
const complexities = new Set(['quick', 'standard', 'full', 'specialist']);

export function routeRequest(text) {
  const markerAt = text.lastIndexOf(routeMarker);
  if (markerAt < 0) return undefined;
  return JSON.parse(text.slice(markerAt + routeMarker.length));
}

export function routePrompt(text) {
  const payload = routeRequest(text);
  if (!payload) return undefined;
  const brief = payload.execution_brief;
  if (brief) return [brief.objective, ...brief.requirements, ...brief.acceptance_criteria].join('\n');
  if (payload.correction_brief) return [payload.correction_brief.observed_problem, payload.correction_brief.required_correction].join('\n');
  if (payload.codex_decision) return [payload.codex_decision.selected_option, payload.codex_decision.rationale].join('\n');
  throw new Error('Hub route request has no supported brief');
}

export function compactRoute(result) {
  if (!complexities.has(result?.complexity) || !categories.has(result?.decision?.category)) {
    throw new Error('Jev returned an invalid route');
  }
  if (typeof result.decision.should_ultrawork !== 'boolean' ||
      !Array.isArray(result.decision.load_skills) ||
      !result.decision.load_skills.every(skill => typeof skill === 'string')) {
    throw new Error('Jev returned an incomplete route');
  }
  return {
    complexity: result.complexity,
    category: result.decision.category,
    should_ultrawork: result.decision.should_ultrawork,
    load_skills: result.decision.load_skills,
    skill: result.skill ?? null,
    is_visual: (result.is_visual ?? 0) > 0.55,
    ...(typeof result._trace === 'string' && result._trace.length <= 4096
      ? { formatted_trace: result._trace }
      : {})
  };
}

export async function applyJevRoute(parts, decide) {
  const part = parts.find(item => item.type === 'text' && typeof item.text === 'string' && item.text.includes(routeMarker));
  if (!part) return undefined;
  const prompt = routePrompt(part.text);
  const route = compactRoute(await decide(prompt));
  const nonce = routeRequest(part.text).route_nonce;
  if (nonce !== undefined) {
    if (typeof nonce !== 'string' || !/^[0-9a-f-]{36}$/.test(nonce)) throw new Error('Invalid hub route nonce');
    route.route_nonce = nonce;
  }
  const instruction = route.category === 'quick'
    ? 'Execute directly with Sisyphus; do not delegate this quick task.'
    : route.should_ultrawork
      ? 'Use Sisyphus ultrawork orchestration and delegate suitable independent work through OMO.'
      : 'Use Sisyphus deep execution; delegate only if the task actually needs it.';
  const discovery = route.load_skills.length === 0 ? ` ${skillDiscoveryFallback}` : '';
  const planningBoundary = "The Codex brief is authoritative. Prometheus may only divide approved in-scope work among configured agents; it must not change Codex's objective, scope, architecture, or acceptance criteria. If a required choice crosses those boundaries, ask Codex and wait for its decision. Sisyphus executes the Codex-approved task and coordinates the assignments.";
  part.text = `${receiptMarker}${JSON.stringify(route)}\nJev routing has already run for this hub turn. Do not call Jev again for this turn. ${instruction}${discovery} ${planningBoundary} Load the listed skills when applicable.\n\n${part.text}`;
  return route;
}

export function assertAllowedTool(route, tool) {
  if (route?.category === 'quick' && (tool === 'task' || tool === 'delegate_task')) {
    throw new Error('Jev quick route does not permit OMO delegation');
  }
}

export async function decideWithLocalJev(prompt) {
  const clientPath = process.env.JEV_CLIENT_PATH ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.omo', 'jev-router', 'jev-client.mjs');
  const { omoRoute, formatTrace } = await import(pathToFileURL(clientPath).href);
  const startedAt = Date.now();
  const result = await omoRoute(prompt);
  return {
    ...result,
    _trace: typeof result._trace === 'string'
      ? result._trace
      : formatTrace(result, Date.now() - startedAt)
  };
}
