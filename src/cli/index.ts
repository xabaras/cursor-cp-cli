/**
 * CLI Commands
 */

import { runDaemonCommand } from '../service/service-control.js';
import { userConfigPath, projectConfigPath } from '../config/home.js';
import { loadConfig } from '../config/loader.js';
import { runSetup } from './setup.js';
import { runDoctor } from './doctor.js';
import {
  parseHelpTopic,
  printHelpForTopic,
  getVersion,
  APP_DISPLAY_NAME,
} from './help.js';

const commands: Record<string, (args: string[]) => Promise<void>> = {
  async serve() {
    await import('../index.js');
  },

  async start() {
    await commands.serve([]);
  },

  async setup(args: string[]) {
    await runSetup(args);
  },

  async onboard(args: string[]) {
    await runSetup(args);
  },

  async doctor() {
    await runDoctor();
  },

  async config() {
    const { config, defaultPath, overridePaths } = loadConfig();

    console.log('Configuration:');
    console.log(`  Defaults:  ${defaultPath}`);
    if (overridePaths.length > 0) {
      for (const path of overridePaths) {
        console.log(`  Overrides: ${path}`);
      }
    } else {
      console.log(`  Overrides: (none — copy config.default.yaml to ${userConfigPath()})`);
    }
    console.log();

    console.log('Effective settings:');
    console.log(`  Workspace: ${config.workspaceRoot}`);
    console.log(`  Server: ${config.server.host}:${config.server.port}`);
    console.log(`  Default Model: ${config.sdk.defaultModel}`);
    console.log(`  Telegram: ${config.channels.telegram.enabled ? 'enabled' : 'disabled'}`);
    console.log(`  Web: ${config.channels.web.enabled ? 'enabled' : 'disabled'}`);
    console.log(`  CLI bridge: ${config.cliBridge.enabled ? 'enabled' : 'disabled'}`);
    if (config.cliBridge.enabled) {
      console.log(`  CLI agent: ${config.cliBridge.agentBin}`);
      console.log(`  CLI chats: ${config.cliBridge.chatsRoot}`);
    }
    console.log(`  Log level: ${config.logging.level}`);
    console.log(`  API Key: ${config.cursorApiKey ? 'configured' : 'NOT SET'}`);
    console.log();
    console.log(`Edit ${userConfigPath()} (or ${projectConfigPath()} when developing) then restart.`);
  },

  async daemon(args: string[]) {
    const command = args[0] || 'status';
    await runDaemonCommand(command);
  },

  async help(args: string[]) {
    printHelpForTopic(args[0]);
  },

  async version() {
    console.log(`${APP_DISPLAY_NAME} v${getVersion()}`);
  },
};

export async function runCLI(args: string[]): Promise<void> {
  const helpTopic = parseHelpTopic(args);
  if (helpTopic !== null) {
    printHelpForTopic(helpTopic);
    return;
  }

  const command = args[0] || 'serve';

  if (command === 'version' || command === '--version' || command === '-v') {
    console.log(`${APP_DISPLAY_NAME} v${getVersion()}`);
    return;
  }

  const handler = commands[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    console.error('Run "cursor-cp help" for available commands.');
    process.exit(1);
  }

  await handler(args.slice(1));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCLI(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
