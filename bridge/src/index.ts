import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Hub } from './hub.js';
import { HttpOpenCodeClient } from './opencode-client.js';
import { createMcpServer } from './server.js';
import { FileTaskStore } from './state.js';
import { startManagedOpenCode } from './runtime.js';
import { CapabilityManager, HttpMcpRuntimeApi } from './capability-manager.js';
import { OfficialMcpRegistryDiscovery } from './discovery.js';
import { FileRouteReceiptReader } from './routes.js';
import { FileMcpInstallationStore } from './mcp-installations.js';
import { WorkspaceValidationRunner } from './validation.js';
import { SystemOneJevEstimator } from './jev-estimate-source.js';

async function main(): Promise<void> {
  const workspace = process.env.OPENCODE_WORKSPACE;
  if (!workspace) throw new Error('OPENCODE_WORKSPACE is required');

  const stateDir = process.env.OPENCODE_TASK_STATE_DIR ?? join(workspace, '.opencode-bridge-state');
  const managed = process.env.OPENCODE_BASE_URL ? undefined : await startManagedOpenCode(workspace, join(stateDir, 'routes'));
  const baseURL = process.env.OPENCODE_BASE_URL ?? managed!.baseURL;
  if (managed) process.on('exit', () => managed.close());

  const client = new HttpOpenCodeClient(
    baseURL,
    workspace,
    process.env.OPENCODE_SERVER_USERNAME,
    process.env.OPENCODE_SERVER_PASSWORD ?? managed?.password
  );
  const capabilities = new CapabilityManager(new HttpMcpRuntimeApi(
    baseURL, workspace, process.env.OPENCODE_SERVER_USERNAME, process.env.OPENCODE_SERVER_PASSWORD ?? managed?.password
  ), undefined, new OfficialMcpRegistryDiscovery(), new FileMcpInstallationStore(stateDir));
  const routeDir = managed?.routeDir ?? process.env.OPENCODE_HUB_ROUTE_DIR;
  // Genuine Jev estimates stay OFF by default: enabling them adds one live
  // SystemOne call per final task. Set OPENCODE_HUB_JEV_ESTIMATE=1 only
  // after user approval, then restart the bridge.
  const jevEstimator = process.env.OPENCODE_HUB_JEV_ESTIMATE === '1' ? new SystemOneJevEstimator() : undefined;
  const hub = new Hub(client, new FileTaskStore(stateDir), capabilities, routeDir ? new FileRouteReceiptReader(routeDir) : undefined, new WorkspaceValidationRunner(workspace), jevEstimator);
  await hub.recoverPending();
  await createMcpServer(hub).connect(new StdioServerTransport());
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
