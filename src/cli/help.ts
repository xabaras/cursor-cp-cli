/**
 * CLI help text and routing.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { getProjectRoot } from '../config/home.js';

/** User-facing product name for this fork. */
export const APP_DISPLAY_NAME = 'Cursor Control Plane + CLI';

export function isHelpFlag(arg: string): boolean {
  return arg === '--help' || arg === '-h';
}

/** Returns help topic, `undefined` for main help, or `null` if not a help request. */
export function parseHelpTopic(args: string[]): string | undefined | null {
  if (args.length === 0) return null;

  const [cmd, ...rest] = args;

  if (cmd === 'help') {
    return rest[0];
  }

  if (isHelpFlag(cmd)) {
    return undefined;
  }

  if (rest.some(isHelpFlag)) {
    return cmd;
  }

  return null;
}

export function getVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(getProjectRoot(), 'package.json'), 'utf-8')
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const TOPICS: Record<string, () => void> = {
  serve: printServeHelp,
  start: printServeHelp,
  setup: printSetupHelp,
  onboard: printSetupHelp,
  doctor: printDoctorHelp,
  config: printConfigHelp,
  daemon: printDaemonHelp,
};

export function printHelpForTopic(topic: string | undefined): void {
  if (topic === undefined) {
    printMainHelp();
    return;
  }

  const printer = TOPICS[topic];
  if (!printer) {
    console.error(`Unknown help topic: ${topic}`);
    console.error('');
    console.error('Available topics:');
    for (const name of [...new Set(Object.keys(TOPICS))]) {
      console.error(`  ${name}`);
    }
    process.exit(1);
  }

  printer();
}

export function printMainHelp(): void {
  console.log(`${APP_DISPLAY_NAME} v${getVersion()}

Usage: cursor-cp [command] [options]

Commands:
  serve, start     Start the server in the foreground (default)
  setup, onboard   Interactive configuration wizard
  doctor           Check installation for common problems
  config           Show effective configuration and file paths
  daemon           Manage background service (macOS / Linux)
  help [command]   Show help (optionally for a specific command)
  version          Print version number

Global options:
  -h, --help       Show help (same as: cursor-cp help [command])
  -v, --version    Print version number

Examples:
  cursor-cp                    # start server (foreground)
  cursor-cp setup              # first-run configuration
  cursor-cp setup --enable-daemon
  cursor-cp daemon enable      # background + auto-start on login
  cursor-cp daemon restart     # apply config changes
  cursor-cp doctor             # diagnose issues
  cursor-cp config             # show active settings
  cursor-cp help setup         # setup command options

Run \`cursor-cp help <command>\` for command-specific options.`);
}

export function printServeHelp(): void {
  console.log(`Usage: cursor-cp [serve|start]

Start the web server and optional Telegram bot in the foreground.
This is the default when no command is given.

Commands:
  serve            Start the server (default)
  start            Alias for serve

Options:
  (none)

Examples:
  cursor-cp
  cursor-cp serve
  cursor-cp start

Press Ctrl+C to stop. For background mode, use: cursor-cp daemon enable`);
}

export function printSetupHelp(): void {
  console.log(`Usage: cursor-cp setup|onboard [options]

Interactive wizard that writes settings to ~/cursor-cp/config.yaml.
Creates the file from config.default.yaml if it does not exist.

Options:
  --enable-daemon          Enable background daemon after setup completes
  --no-daemon              Skip the daemon prompt; do not enable background service
  --non-interactive, -y    Use existing config values without prompts
  --yes                    Same as --non-interactive
  -h, --help               Show this help

Non-interactive mode requires cursor.api_key to already be set in config.yaml.

Examples:
  cursor-cp setup
  cursor-cp setup --enable-daemon
  cursor-cp setup --no-daemon
  cursor-cp onboard          # alias for setup`);
}

export function printDoctorHelp(): void {
  console.log(`Usage: cursor-cp doctor

Run checks for common installation and configuration problems:
  Node.js version, config files, API key, port availability,
  GitHub CLI, and background daemon status.

Options:
  (none)

Examples:
  cursor-cp doctor`);
}

export function printConfigHelp(): void {
  console.log(`Usage: cursor-cp config

Show the effective configuration after merging:
  config.default.yaml → ~/cursor-cp/config.yaml → project config.yaml (dev)

Displays config file paths, server port, channels, log level, and
whether the API key is set (value is never printed).

Options:
  (none)

Examples:
  cursor-cp config`);
}

export function printDaemonHelp(): void {
  console.log(`Usage: cursor-cp daemon [command]

Manage cursor-cp as a per-user background service.
Supported on macOS (LaunchAgent) and Linux (systemd user unit).
Not supported on Windows.

Commands:
  enable     Install service, start it, and enable auto-start on login
  disable    Stop service, remove unit, and disable auto-start
  start      Start the service (must be enabled first)
  stop       Stop the service without removing auto-start
  restart    Restart the service (use after editing config.yaml)
  status     Show service type and running state (default)

Options:
  -h, --help               Show this help

Examples:
  cursor-cp daemon enable
  cursor-cp daemon status
  cursor-cp daemon restart
  cursor-cp daemon disable

Logs:
  Linux   journalctl --user -u cursor-cp.service -f
  macOS   ~/cursor-cp/logs/service.log`);
}
