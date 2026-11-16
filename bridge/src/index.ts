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
import { loadHarnessConfig, openCodeRequired, resolveModel, resolveRoleBindings } from './harness-config.js';
import { createHarnessRegistry } from './harness/registry.js';
import { OpenCodeHarness } from './harness/opencode.js';

async function main(): Promise<void> {
  const workspace = process.env.BRIDGE_WORKSPACE ?? process.env.OPENCODE_WORKSPACE;
  if (!workspace) throw new Error('BRIDGE_WORKSPACE is required (legacy alias: OPENCODE_WORKSPACE)');

  const stateDir = process.env.BRIDGE_TASK_STATE_DIR ?? process.env.OPENCODE_TASK_STATE_DIR ?? join(workspace, '.codex-x-opencode-mcp');
  const config = await loadHarnessConfig(workspace, stateDir);
  const pure = config.pure_mode;
  const harnessId = config.harness.default;
  const opencodeEntry = config.harnesses['opencode'];
  // Route receipts are an OMO/Jev feature: never required in pure mode.
  const routeReceiptsRequired = config.route_receipts_required && !pure;

  // OpenCode runs only when it can actually take a task: it is enabled and
  // either selected for this deployment or reached through OPENCODE_BASE_URL.
  // A deployment that routes to a CLI harness therefore never needs an
  // OpenCode install.
  const externalOpenCode = process.env.OPENCODE_BASE_URL?.trim();
  const useOpenCode = openCodeRequired(config, externalOpenCode);

  const managed = useOpenCode && !externalOpenCode ? await startManagedOpenCode(
    workspace,
    routeReceiptsRequired ? join(stateDir, 'routes') : undefined,
    {
      pure,
      supportedVersions: opencodeEntry?.serve?.supported_versions,
      strictVersion: opencodeEntry?.serve?.strict_version
    }
  ) : undefined;
  const baseURL = externalOpenCode || managed?.baseURL;
  if (managed) process.on('exit', () => managed.close());

  const client = useOpenCode && baseURL ? new HttpOpenCodeClient(
    baseURL,
    workspace,
    process.env.OPENCODE_SERVER_USERNAME,
    process.env.OPENCODE_SERVER_PASSWORD ?? managed?.password
  ) : undefined;
  const capabilities = useOpenCode && baseURL ? new CapabilityManager(new HttpMcpRuntimeApi(
    baseURL, workspace, process.env.OPENCODE_SERVER_USERNAME, process.env.OPENCODE_SERVER_PASSWORD ?? managed?.password
  ), undefined, new OfficialMcpRegistryDiscovery(), new FileMcpInstallationStore(stateDir)) : undefined;
  const routeDir = managed?.routeDir ?? process.env.OPENCODE_HUB_ROUTE_DIR;
  // Genuine Jev estimates stay OFF by default: enabling them adds one live
  // SystemOne call per final task. Set OPENCODE_HUB_JEV_ESTIMATE=1 only
  // after user approval, then restart the bridge.
  const jevEstimator = process.env.OPENCODE_HUB_JEV_ESTIMATE === '1' ? new SystemOneJevEstimator() : undefined;
  const registry = createHarnessRegistry(config, {
    harnesses: client ? [new OpenCodeHarness(client, workspace)] : [],
    stateDir,
    workspace
  });
  // A configured default that is disabled or unavailable must not be reported
  // as the harness that executed the task.
  const activeHarnessId = registry.get(harnessId) ? harnessId : registry.default().descriptor.id;
  const hub = new Hub(client, new FileTaskStore(stateDir), {
    harnessRegistry: registry,
    harnessId: activeHarnessId,
    routeRequired: routeReceiptsRequired,
    pureMode: pure,
    orchestration: config.orchestration,
    roleBindings: id => resolveRoleBindings(config, id),
    routeModel: (mode, escalate) => resolveModel({ config, harnessId: activeHarnessId, mode, escalate }),
    capabilities
  }, routeReceiptsRequired && routeDir ? new FileRouteReceiptReader(routeDir) : undefined,
  new WorkspaceValidationRunner(workspace), jevEstimator);
  await hub.recoverPending();
  await createMcpServer(hub, { neutral_copy: true }).connect(new StdioServerTransport());
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
