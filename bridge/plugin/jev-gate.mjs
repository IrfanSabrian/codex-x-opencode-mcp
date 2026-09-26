import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyJevRoute, assertAllowedTool, decideWithLocalJev } from './jev-gate-core.mjs';

export const JevGate = async () => {
  const routes = new Map();
  return {
  'chat.message': async (input, output) => {
    if (process.env.OPENCODE_HUB_JEV_GATE !== '1') return;
    const route = await applyJevRoute(output.parts, decideWithLocalJev);
    if (route) routes.set(input.sessionID, route);
    if (route && process.env.OPENCODE_HUB_ROUTE_DIR && /^ses_[A-Za-z0-9_-]+$/.test(input.sessionID)) {
      const path = join(process.env.OPENCODE_HUB_ROUTE_DIR, `${input.sessionID}.json`);
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(route), { mode: 0o600 });
      await rename(temp, path);
    }
  },
  'tool.execute.before': async (input) => {
    if (process.env.OPENCODE_HUB_JEV_GATE === '1') assertAllowedTool(routes.get(input.sessionID), input.tool);
  }
  };
};
